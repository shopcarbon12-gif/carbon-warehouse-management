import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/handheld_device_identity.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/camera_barcode_scanner.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Fast 2D bin putaway: hardware wedge, device camera, or manual entry.
class FastPutawayScreen extends StatefulWidget {
  const FastPutawayScreen({super.key});

  @override
  State<FastPutawayScreen> createState() => _FastPutawayScreenState();
}

enum _PutawayPhase { scanItem, scanBin }

class _FastPutawayScreenState extends State<FastPutawayScreen> {
  _PutawayPhase _phase = _PutawayPhase.scanItem;
  final _scanFocus = FocusNode();
  final _hiddenCtrl = TextEditingController();
  String _pendingSku = '';
  bool _busy = false;
  bool _flashOk = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _scanFocus.requestFocus());
  }

  @override
  void dispose() {
    _hiddenCtrl.dispose();
    _scanFocus.dispose();
    super.dispose();
  }

  String? _parseColorHint(String sku) {
    final parts = sku.split(RegExp(r'[-_/]'));
    if (parts.length < 2) return null;
    return parts.last.trim().toUpperCase();
  }

  Future<void> _onItemSubmit(String raw) async {
    final sku = raw.trim();
    if (sku.isEmpty) return;
    _hiddenCtrl.clear();
    final hint = _parseColorHint(sku) ?? sku;
    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: AppColors.surface,
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('COLOR SCOPE', style: AppTheme.headline(context)),
              const SizedBox(height: 16),
              FilledButton(
                onPressed: () {
                  Navigator.pop(ctx);
                  _scopeForBin = 'all_colors';
                  _skuForBin = sku;
                  setState(() {
                    _pendingSku = sku;
                    _phase = _PutawayPhase.scanBin;
                  });
                  WidgetsBinding.instance.addPostFrameCallback((_) => _scanFocus.requestFocus());
                },
                style: FilledButton.styleFrom(
                  backgroundColor: AppColors.primary,
                  foregroundColor: Colors.white,
                  padding: const EdgeInsets.symmetric(vertical: 18),
                ),
                child: const Text('ASSIGN ALL COLORS', style: TextStyle(fontWeight: FontWeight.w800)),
              ),
              const SizedBox(height: 10),
              OutlinedButton(
                onPressed: () {
                  Navigator.pop(ctx);
                  _scopeForBin = 'single_color';
                  _skuForBin = sku;
                  setState(() {
                    _pendingSku = sku;
                    _phase = _PutawayPhase.scanBin;
                  });
                  WidgetsBinding.instance.addPostFrameCallback((_) => _scanFocus.requestFocus());
                },
                child: Text('ONLY THIS COLOR · $hint'),
              ),
            ],
          ),
        ),
      ),
    );
  }

  String _scopeForBin = 'all_colors';
  String _skuForBin = '';

  Future<void> _onBinSubmit(String raw) async {
    final bin = raw.trim().toUpperCase();
    if (bin.isEmpty || _skuForBin.isEmpty) return;
    _hiddenCtrl.clear();
    setState(() => _busy = true);
    try {
      final api = context.read<WmsApiClient>();
      final deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
      await api.postPutawayAssign(
        deviceId: deviceId,
        binCode: bin,
        skuScanned: _skuForBin,
        scope: _scopeForBin,
      );
      if (!mounted) return;
      setState(() {
        _busy = false;
        _flashOk = true;
        _phase = _PutawayPhase.scanItem;
        _pendingSku = '';
        _skuForBin = '';
      });
      await Future<void>.delayed(const Duration(milliseconds: 450));
      if (mounted) setState(() => _flashOk = false);
    } catch (e) {
      if (mounted) {
        setState(() => _busy = false);
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Putaway failed: $e')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      body: AnimatedContainer(
        duration: const Duration(milliseconds: 200),
        color: _flashOk ? const Color(0xFFCCEAE9) : AppColors.background,
        width: double.infinity,
        height: double.infinity,
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                _phase == _PutawayPhase.scanItem ? 'SCAN ITEM BARCODE' : 'SCAN DESTINATION BIN',
                style: AppTheme.headline(context),
              ),
              const SizedBox(height: 8),
              Text(
                _phase == _PutawayPhase.scanItem
                    ? 'Hardware scanner (wedge), camera, or type below — custom SKU from label.'
                    : 'Hardware scanner, camera, or type bin label (e.g. 1A01C).',
                style: const TextStyle(color: AppColors.textMuted),
              ),
              const SizedBox(height: 12),
              OutlinedButton.icon(
                onPressed: _busy
                    ? null
                    : () async {
                        final title = _phase == _PutawayPhase.scanItem
                            ? 'Scan item barcode'
                            : 'Scan bin label';
                        final code = await openCameraBarcodeScanner(context, title: title);
                        if (!mounted || code == null || code.isEmpty) return;
                        if (_phase == _PutawayPhase.scanItem) {
                          await _onItemSubmit(code);
                        } else {
                          await _onBinSubmit(code);
                        }
                      },
                icon: const Icon(Icons.photo_camera_outlined),
                label: const Text('Scan with camera'),
              ),
              if (_pendingSku.isNotEmpty && _phase == _PutawayPhase.scanBin)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text('Item: $_pendingSku', style: const TextStyle(fontWeight: FontWeight.w600)),
                ),
              const SizedBox(height: 24),
              // Hidden field captures hardware scanner / keyboard wedge
              Offstage(
                offstage: true,
                child: TextField(
                  controller: _hiddenCtrl,
                  focusNode: _scanFocus,
                  autofocus: true,
                  keyboardType: TextInputType.text,
                  enableInteractiveSelection: false,
                  onSubmitted: (v) {
                    if (_phase == _PutawayPhase.scanItem) {
                      unawaited(_onItemSubmit(v));
                    } else {
                      unawaited(_onBinSubmit(v));
                    }
                  },
                ),
              ),
              const Spacer(),
              if (_busy) const Center(child: CircularProgressIndicator()),
              const SizedBox(height: 16),
              TextField(
                decoration: const InputDecoration(
                  labelText: 'Manual entry',
                  hintText: 'Type code + Enter',
                ),
                onSubmitted: (v) {
                  if (_phase == _PutawayPhase.scanItem) {
                    unawaited(_onItemSubmit(v));
                  } else {
                    unawaited(_onBinSubmit(v));
                  }
                },
              ),
            ],
          ),
        ),
      ),
    );
  }
}
