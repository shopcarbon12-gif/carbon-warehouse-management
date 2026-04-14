import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/camera_barcode_scanner.dart' show openCameraBarcodeScanner;
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Scan bin barcode → clear all EPC assignments (`POST /api/mobile/clean-bin`).
class CleanBinScreen extends StatefulWidget {
  const CleanBinScreen({super.key});

  @override
  State<CleanBinScreen> createState() => _CleanBinScreenState();
}

class _CleanBinScreenState extends State<CleanBinScreen> {
  final _focus = FocusNode();
  final _hidden = TextEditingController();
  bool _busy = false;
  String? _status;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _focus.requestFocus());
  }

  @override
  void dispose() {
    _focus.dispose();
    _hidden.dispose();
    super.dispose();
  }

  Future<void> _submit(String raw) async {
    final code = raw.trim().toUpperCase();
    if (code.isEmpty) return;
    _hidden.clear();
    setState(() {
      _busy = true;
      _status = null;
    });
    try {
      final j = await context.read<WmsApiClient>().postCleanBinByCode(code);
      final cleared = j['cleared'];
      if (mounted) {
        setState(() => _status = 'Cleared $cleared item(s) from $code');
      }
    } catch (e) {
      if (mounted) setState(() => _status = 'Failed: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      pageTitle: 'CLEAN BIN',
      body: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('CLEAN BIN', style: AppTheme.headline(context)),
            const SizedBox(height: 8),
            const Text(
              'Scan the bin 2D barcode or type the bin code. All in-stock assignments are removed and audited.',
              style: TextStyle(color: AppColors.textMuted, fontSize: 13),
            ),
            const SizedBox(height: 16),
            OutlinedButton.icon(
              onPressed: _busy
                  ? null
                  : () async {
                      final code = await openCameraBarcodeScanner(context, title: 'Scan bin label');
                      if (!mounted || code == null || code.isEmpty) return;
                      await _submit(code);
                    },
              icon: const Icon(Icons.photo_camera_outlined),
              label: const Text('Scan with camera'),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _hidden,
              focusNode: _focus,
              style: const TextStyle(color: AppColors.textMain, fontWeight: FontWeight.w700, letterSpacing: 1),
              decoration: const InputDecoration(
                labelText: 'Bin code (wedge / manual)',
                hintText: 'e.g. 1A01C',
              ),
              textCapitalization: TextCapitalization.characters,
              onSubmitted: (s) => unawaited(_submit(s)),
            ),
            const SizedBox(height: 16),
            FilledButton(
              onPressed: _busy ? null : () => unawaited(_submit(_hidden.text)),
              child: Text(_busy ? 'WORKING…' : 'CLEAN BIN'),
            ),
            if (_status != null) ...[
              const SizedBox(height: 16),
              Text(_status!, style: const TextStyle(color: AppColors.primary, fontWeight: FontWeight.w600)),
            ],
          ],
        ),
      ),
    );
  }
}
