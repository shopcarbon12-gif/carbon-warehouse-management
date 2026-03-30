import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';
import 'package:carbon_wms/ui/widgets/tactical_bottom_bar.dart';
import 'package:carbon_wms/util/demo_epc.dart';

class InventoryCsvSessionScreen extends StatefulWidget {
  const InventoryCsvSessionScreen({super.key});

  @override
  State<InventoryCsvSessionScreen> createState() => _InventoryCsvSessionScreenState();
}

class _InventoryCsvSessionScreenState extends State<InventoryCsvSessionScreen> {
  bool _uploading = false;
  String? _status;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final m = context.read<RfidManager>();
      m.suppressEdgeStreaming = true;
      m.scanContext = 'CYCLE_COUNT_CSV';
      m.clearManualCsvSession();
    });
  }

  @override
  void dispose() {
    try {
      context.read<RfidManager>().suppressEdgeStreaming = false;
    } catch (_) {
      /* widget tree may be torn down */
    }
    super.dispose();
  }

  Future<void> _upload() async {
    final m = context.read<RfidManager>();
    final api = context.read<WmsApiClient>();
    if (m.manualCsvRows.isEmpty) {
      setState(() => _status = 'No scans to upload');
      return;
    }
    setState(() {
      _uploading = true;
      _status = null;
    });
    try {
      final deviceId = await m.activeScanner?.getDeviceId() ?? 'HANDHELD_OFFLINE';
      final csv = m.buildManualUploadCsv();
      final res = await api.postInventoryUpload(
        deviceId: deviceId,
        mode: 'Cycle Count',
        csvData: csv,
      );
      final updated = res['rowsUpdated'];
      if (mounted) {
        setState(() {
          _status = 'Uploaded (${res['rowsProcessed']} rows, $updated items updated)';
        });
        m.clearManualCsvSession();
      }
    } catch (e) {
      if (mounted) {
        setState(() => _status = 'Upload failed: $e');
      }
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final m = context.watch<RfidManager>();

    return CarbonScaffold(
      bottomBar: TacticalBottomBar(
        children: [
          TacticalEmeraldButton(
            label: 'SIMULATE RFID TAG',
            onPressed: () => m.addSimulatedEpc(randomDemoEpc()),
          ),
          TacticalSlateButton(
            label: _uploading ? 'UPLOADING…' : 'UPLOAD TO WMS',
            onPressed: _uploading ? null : () => unawaited(_upload()),
          ),
        ],
      ),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('MANUAL CSV SESSION', style: AppTheme.headline(context)),
            const SizedBox(height: 8),
            const Text(
              'RFID reads stay on device until you tap Upload. Edge streaming is paused on this screen.',
              style: TextStyle(color: AppColors.textMuted, fontSize: 13),
            ),
            if (_status != null) ...[
              const SizedBox(height: 12),
              Text(_status!, style: const TextStyle(color: AppColors.primary, fontWeight: FontWeight.w600)),
            ],
            const SizedBox(height: 16),
            Text(
              'UNIQUE TAGS: ${m.manualCsvRows.length}',
              style: AppTheme.headline(context).copyWith(fontSize: 12),
            ),
            const SizedBox(height: 8),
            Expanded(
              child: DecoratedBox(
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: const Color(0xFF334155)),
                  color: AppColors.surface,
                ),
                child: m.manualCsvRows.isEmpty
                    ? const Center(
                        child: Text(
                          'Scan tags with the sled\n(or Simulate)',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: AppColors.textMuted),
                        ),
                      )
                    : ListView.builder(
                        itemCount: m.manualCsvRows.length,
                        itemBuilder: (context, i) {
                          final r = m.manualCsvRows[i];
                          return ListTile(
                            title: Text(
                              r.epc,
                              style: const TextStyle(
                                fontWeight: FontWeight.w600,
                                letterSpacing: 0.6,
                              ),
                            ),
                            subtitle: Text(
                              r.at.toIso8601String(),
                              style: const TextStyle(color: AppColors.textMuted, fontSize: 11),
                            ),
                          );
                        },
                      ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
