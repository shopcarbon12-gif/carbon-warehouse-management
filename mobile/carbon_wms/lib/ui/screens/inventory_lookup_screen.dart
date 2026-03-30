import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/services/mobile_settings_repository.dart';
import 'package:carbon_wms/theme/app_theme.dart';
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

  void _lookup() {
    final raw = _ctrl.text.trim().toUpperCase();
    setState(() {
      _row = raw.isEmpty ? null : _mockRowForKey(raw);
    });
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
              onSubmitted: (_) => _lookup(),
            ),
            const SizedBox(height: 12),
            FilledButton(
              onPressed: _lookup,
              style: FilledButton.styleFrom(
                backgroundColor: AppColors.primary,
                foregroundColor: AppColors.background,
                padding: const EdgeInsets.symmetric(vertical: 16),
              ),
              child: const Text(
                'LOOKUP',
                style: TextStyle(fontWeight: FontWeight.w800, letterSpacing: 1.2),
              ),
            ),
            const SizedBox(height: 24),
            if (_row != null)
              _LookupCard(
                row: _row!,
                template: context.watch<MobileSettingsRepository>().config.itemDetailsTemplate,
              ),
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
}

_LookupRow _mockRowForKey(String key) {
  final suffix = key.length >= 6 ? key.substring(key.length - 6) : key;
  return _LookupRow(
    code: key,
    sku: 'SKU-$suffix',
    name: 'Carbon floor stock $suffix',
    bin: 'BULK-A-${suffix.codeUnitAt(0) % 12 + 1}',
    upc: '00$suffix',
    vendor: 'Carbon',
    color: 'BLK',
    size: 'M',
    price: '129.00',
    quantity: '12',
  );
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
