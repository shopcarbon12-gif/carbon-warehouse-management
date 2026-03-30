import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/camera_barcode_scanner.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Non-RFID receiving — same edge context family as lookup for Carbon WMS.
class BarcodeIntakeScreen extends StatefulWidget {
  const BarcodeIntakeScreen({super.key});

  @override
  State<BarcodeIntakeScreen> createState() => _BarcodeIntakeScreenState();
}

class _BarcodeIntakeScreenState extends State<BarcodeIntakeScreen> {
  final _barcodeCtrl = TextEditingController();
  final _qtyCtrl = TextEditingController(text: '1');
  _LookupRow? _preview;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<RfidManager>().scanContext = 'INVENTORY_LOOKUP';
    });
  }

  @override
  void dispose() {
    _barcodeCtrl.dispose();
    _qtyCtrl.dispose();
    super.dispose();
  }

  void _resolvePreview() {
    final b = _barcodeCtrl.text.trim().toUpperCase();
    setState(() {
      _preview = b.isEmpty ? null : _mockIntakeRow(b);
    });
  }

  void _commitIntake() {
    if (_preview == null) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          'Intake logged locally (${_qtyCtrl.text}× ${_preview!.sku}) — sync to WMS pending.',
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('BARCODE INTAKE', style: AppTheme.headline(context)),
            const SizedBox(height: 8),
            TextField(
              controller: _barcodeCtrl,
              style: const TextStyle(
                color: AppColors.textMain,
                fontWeight: FontWeight.w600,
                letterSpacing: 0.9,
              ),
              decoration: const InputDecoration(
                hintText: 'Scan UPC / EAN / Code-128',
              ),
              onSubmitted: (_) => _resolvePreview(),
            ),
            const SizedBox(height: 8),
            OutlinedButton.icon(
              onPressed: () async {
                final code = await openCameraBarcodeScanner(
                  context,
                  title: 'Scan barcode',
                );
                if (!mounted || code == null || code.isEmpty) return;
                _barcodeCtrl.text = code;
                _resolvePreview();
              },
              icon: const Icon(Icons.photo_camera_outlined),
              label: const Text('Scan with camera'),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _qtyCtrl,
              keyboardType: TextInputType.number,
              style: const TextStyle(color: AppColors.textMain, fontWeight: FontWeight.w600),
              decoration: const InputDecoration(labelText: 'Quantity'),
            ),
            const SizedBox(height: 12),
            FilledButton(
              onPressed: _resolvePreview,
              style: FilledButton.styleFrom(
                backgroundColor: AppColors.primary,
                foregroundColor: AppColors.background,
                padding: const EdgeInsets.symmetric(vertical: 16),
              ),
              child: const Text(
                'RESOLVE',
                style: TextStyle(fontWeight: FontWeight.w800, letterSpacing: 1.2),
              ),
            ),
            const SizedBox(height: 24),
            if (_preview != null) ...[
              _IntakePreviewCard(row: _preview!),
              const SizedBox(height: 16),
              FilledButton(
                onPressed: _commitIntake,
                style: FilledButton.styleFrom(
                  backgroundColor: AppColors.slateActionDark,
                  foregroundColor: AppColors.textMain,
                  padding: const EdgeInsets.symmetric(vertical: 16),
                ),
                child: const Text(
                  'COMMIT INTAKE',
                  style: TextStyle(fontWeight: FontWeight.w800, letterSpacing: 1.2),
                ),
              ),
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
  });

  final String code;
  final String sku;
  final String name;
  final String bin;
}

_LookupRow _mockIntakeRow(String barcode) {
  final tail = barcode.length >= 4 ? barcode.substring(barcode.length - 4) : barcode;
  return _LookupRow(
    code: barcode,
    sku: 'UPC-$tail',
    name: 'Vendor carton mix $tail',
    bin: 'RCV-STAGE',
  );
}

class _IntakePreviewCard extends StatelessWidget {
  const _IntakePreviewCard({required this.row});

  final _LookupRow row;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            AspectRatio(
              aspectRatio: 4 / 3,
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: AppColors.background,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: const Color(0xFF334155)),
                ),
                child: const Center(
                  child: Icon(Icons.inventory_2_outlined, size: 56, color: AppColors.textMuted),
                ),
              ),
            ),
            const SizedBox(height: 12),
            _line('BARCODE', row.code),
            _line('SKU', row.sku),
            _line('NAME', row.name),
            _line('PUTAWAY HINT', row.bin),
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
