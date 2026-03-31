import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/epc_tenant_sync.dart';
import 'package:carbon_wms/services/mobile_settings_repository.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/locate_tag_screen.dart';
import 'package:carbon_wms/ui/widgets/camera_barcode_scanner.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';
import 'package:carbon_wms/util/template_substitution.dart';

class InventoryLookupScreen extends StatefulWidget {
  const InventoryLookupScreen({super.key});

  @override
  State<InventoryLookupScreen> createState() => _InventoryLookupScreenState();
}

class _InventoryLookupScreenState extends State<InventoryLookupScreen> {
  final _ctrl = TextEditingController();
  _LookupRow? _row;
  bool _busyLookup = false;
  String? _lookupErr;

  static final RegExp _epc24 = RegExp(r'^[0-9A-F]{24}$');
  static final RegExp _hexBody = RegExp(r'^[0-9A-F]{4,}$');

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<RfidManager>().scanContext = 'INVENTORY_LOOKUP';
    });
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  static String? _epcProfileHint(TenantEpcProfile p) {
    return '${p.name} · prefix ${p.epcPrefix} · item @${p.itemStartBit}+${p.itemLength} · serial @${p.serialStartBit}+${p.serialLength}';
  }

  Future<void> _performLookup() async {
    final raw = _ctrl.text.trim().toUpperCase();
    if (raw.isEmpty) {
      setState(() {
        _row = null;
        _lookupErr = null;
      });
      return;
    }

    setState(() {
      _busyLookup = true;
      _lookupErr = null;
    });

    final cleaned = raw.replaceAll(RegExp(r'\s'), '');
    final profiles = context.read<MobileSettingsRepository>().epcProfiles;
    TenantEpcProfile? prof;
    if (_hexBody.hasMatch(cleaned)) {
      prof = matchingEpcProfile(cleaned, profiles);
    }

    try {
      final api = context.read<WmsApiClient>();
      final map = await api.catalogGridSearchFirstRow(raw);
      if (!mounted) return;

      if (map != null) {
        final sku = map['sku']?.toString() ?? '';
        final name = map['name']?.toString() ?? '';
        final upc = (map['sku_upc'] ?? map['matrix_upc'])?.toString() ?? '';
        final vendor = map['vendor']?.toString() ?? '';
        final color = map['color']?.toString() ?? '';
        final size = map['size']?.toString() ?? '';
        final price = map['retail_price']?.toString() ?? '';
        final qty = map['ls_on_hand_total']?.toString() ?? '';

        var binStr = '—';
        if (_epc24.hasMatch(cleaned)) {
          try {
            final detail = await api.fetchItemDetailByEpc(cleaned);
            final item = detail?['item'];
            if (item is Map<String, dynamic>) {
              final bc = item['bin_code']?.toString().trim();
              if (bc != null && bc.isNotEmpty) binStr = bc;
            }
          } catch (_) {
            /* optional enrichment */
          }
        }

        setState(() {
          _row = _LookupRow(
            code: raw,
            sku: sku.isNotEmpty ? sku : upc,
            name: name.isNotEmpty ? name : '—',
            bin: binStr,
            upc: upc,
            vendor: vendor,
            color: color,
            size: size,
            price: price,
            quantity: qty,
            epcDecodeHint: prof != null ? _epcProfileHint(prof) : null,
          );
          _busyLookup = false;
        });
        return;
      }

      if (prof != null) {
        final hint = _epcProfileHint(prof);
        setState(() {
          _row = _LookupRow(
            code: raw,
            sku: '—',
            name: 'No catalog row for this scan',
            bin: '—',
            epcDecodeHint: hint,
          );
          _lookupErr = null;
          _busyLookup = false;
        });
        return;
      }

      setState(() {
        _row = null;
        _lookupErr =
            'No catalog match. Sync handheld settings (EPC profiles) or try SKU / UPC.';
        _busyLookup = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _row = null;
        _lookupErr = 'Lookup failed — check network and login.';
        _busyLookup = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('SCAN OR ENTER EPC / BARCODE', style: AppTheme.headline(context)),
            const SizedBox(height: 8),
            TextField(
              controller: _ctrl,
              style: const TextStyle(
                color: AppColors.textMain,
                fontWeight: FontWeight.w600,
                letterSpacing: 0.9,
              ),
              decoration: const InputDecoration(
                hintText: 'EPC, UPC, or internal code',
              ),
              onSubmitted: (_) => unawaited(_performLookup()),
            ),
            const SizedBox(height: 8),
            OutlinedButton.icon(
              onPressed: () async {
                final code = await openCameraBarcodeScanner(
                  context,
                  title: 'Scan barcode / QR',
                );
                if (!mounted || code == null || code.isEmpty) return;
                _ctrl.text = code;
                unawaited(_performLookup());
              },
              icon: const Icon(Icons.photo_camera_outlined),
              label: const Text('Scan with camera'),
            ),
            const SizedBox(height: 12),
            if (_lookupErr != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Text(
                  _lookupErr!,
                  style: const TextStyle(color: Color(0xFFf87171), fontSize: 12, fontFamily: 'monospace'),
                ),
              ),
            FilledButton(
              onPressed: _busyLookup ? null : () => unawaited(_performLookup()),
              style: FilledButton.styleFrom(
                backgroundColor: AppColors.primary,
                foregroundColor: AppColors.background,
                padding: const EdgeInsets.symmetric(vertical: 16),
              ),
              child: Text(
                _busyLookup ? 'LOOKUP…' : 'LOOKUP',
                style: const TextStyle(fontWeight: FontWeight.w800, letterSpacing: 1.2),
              ),
            ),
            const SizedBox(height: 24),
            if (_row != null) ...[
              _LookupCard(
                row: _row!,
                template: context.watch<MobileSettingsRepository>().config.itemDetailsTemplate,
              ),
              if (_epc24.hasMatch(_row!.code.trim().toUpperCase().replaceAll(RegExp(r'\s'), ''))) ...[
                const SizedBox(height: 16),
                FilledButton.icon(
                  onPressed: () {
                    final epc = _row!.code.trim().toUpperCase().replaceAll(RegExp(r'\s'), '');
                    Navigator.of(context).push<void>(
                      MaterialPageRoute<void>(
                        builder: (_) => LocateTagScreen(targetEpc: epc),
                      ),
                    );
                  },
                  icon: const Icon(Icons.sensors),
                  label: const Text('LOCATE TAG (GEIGER)'),
                  style: FilledButton.styleFrom(
                    backgroundColor: AppColors.primary,
                    foregroundColor: AppColors.background,
                    padding: const EdgeInsets.symmetric(vertical: 16),
                  ),
                ),
              ],
            ],
          ],
        ),
      ),
    );
  }
}

class _LookupRow {
  const _LookupRow({
    required this.code,
    required this.sku,
    required this.name,
    required this.bin,
    this.upc = '',
    this.vendor = '',
    this.color = '',
    this.size = '',
    this.price = '',
    this.quantity = '',
    this.epcDecodeHint,
  });

  final String code;
  final String sku;
  final String name;
  final String bin;
  final String upc;
  final String vendor;
  final String color;
  final String size;
  final String price;
  final String quantity;
  final String? epcDecodeHint;
}

class _LookupCard extends StatelessWidget {
  const _LookupCard({required this.row, required this.template});

  final _LookupRow row;
  final String template;

  @override
  Widget build(BuildContext context) {
    final summary = applyMustacheTemplate(template, {
      'item.customSku': row.sku,
      'item.name': row.name,
      'item.upc': row.upc,
      'item.vendor': row.vendor,
      'item.color': row.color,
      'item.size': row.size,
      'item.price': row.price,
      'item.quantity': row.quantity,
    });

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            AspectRatio(
              aspectRatio: 16 / 9,
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: AppColors.background,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: const Color(0xFF334155)),
                ),
                child: const Center(
                  child: Icon(Icons.image_outlined, size: 48, color: AppColors.textMuted),
                ),
              ),
            ),
            const SizedBox(height: 16),
            Text(
              summary,
              style: const TextStyle(
                color: AppColors.textMain,
                fontWeight: FontWeight.w800,
                fontSize: 15,
                height: 1.35,
              ),
            ),
            const SizedBox(height: 16),
            _line('CODE', row.code),
            _line('SKU', row.sku),
            _line('NAME', row.name),
            _line('CURRENT BIN', row.bin),
            if (row.epcDecodeHint != null && row.epcDecodeHint!.isNotEmpty) ...[
              const SizedBox(height: 8),
              _line('EPC PROFILE (TENANT)', row.epcDecodeHint!),
            ],
          ],
        ),
      ),
    );
  }

  Widget _line(String k, String v) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            k,
            style: const TextStyle(
              color: AppColors.textMuted,
              fontSize: 11,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.2,
            ),
          ),
          Text(
            v,
            style: const TextStyle(
              color: AppColors.textMain,
              fontWeight: FontWeight.w700,
              fontSize: 16,
            ),
          ),
        ],
      ),
    );
  }
}
