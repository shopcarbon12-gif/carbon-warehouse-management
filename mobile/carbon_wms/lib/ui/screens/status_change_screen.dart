import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/util/demo_epc.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';
import 'package:carbon_wms/ui/widgets/tactical_bottom_bar.dart';

enum _StatusBucket { missing, damaged, inStock }

class StatusChangeScreen extends StatefulWidget {
  const StatusChangeScreen({super.key});

  @override
  State<StatusChangeScreen> createState() => _StatusChangeScreenState();
}

class _StatusChangeScreenState extends State<StatusChangeScreen> {
  _StatusBucket _bucket = _StatusBucket.inStock;

  String get _bucketCode => switch (_bucket) {
        _StatusBucket.missing => 'MISSING',
        _StatusBucket.damaged => 'DAMAGED',
        _StatusBucket.inStock => 'IN_STOCK',
      };

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final m = context.read<RfidManager>();
      m.scanContext = 'STATUS_CHANGE';
      m.setIngestMetadata({'statusBucket': _bucketCode});
    });
  }

  void _applyMeta(RfidManager m) {
    m.setIngestMetadata({'statusBucket': _bucketCode});
  }

  Future<void> _commitStatus(BuildContext context) async {
    final m = context.read<RfidManager>();
    _applyMeta(m);
    m.setIngestMetadata({
      'statusBucket': _bucketCode,
      'committed': true,
    });
    try {
      await m.ingestSessionSnapshot();
      if (context.mounted) {
        m.clearSessionScans();
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Status update sent ($_bucketCode)')),
        );
      }
    } catch (_) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Commit failed — check network')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final manager = context.watch<RfidManager>();
    final items = manager.sessionEpcs;

    return CarbonScaffold(
      bottomBar: TacticalBottomBar(
        children: [
          TacticalEmeraldButton(
            label: 'SIMULATE SCAN',
            onPressed: () {
              final m = context.read<RfidManager>();
              _applyMeta(m);
              m.addSimulatedEpc(randomDemoEpc());
            },
          ),
          TacticalSlateButton(
            label: 'COMMIT STATUS',
            onPressed: items.isEmpty
                ? null
                : () => unawaited(_commitStatus(context)),
          ),
        ],
      ),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('STATUS', style: AppTheme.headline(context)),
            const SizedBox(height: 12),
            SegmentedButton<_StatusBucket>(
              segments: const [
                ButtonSegment(
                  value: _StatusBucket.missing,
                  label: Text('MISSING'),
                ),
                ButtonSegment(
                  value: _StatusBucket.damaged,
                  label: Text('DAMAGED'),
                ),
                ButtonSegment(
                  value: _StatusBucket.inStock,
                  label: Text('IN-STOCK'),
                ),
              ],
              selected: {_bucket},
              onSelectionChanged: (s) {
                setState(() => _bucket = s.first);
                _applyMeta(context.read<RfidManager>());
              },
            ),
            const SizedBox(height: 16),
            Text('SCANNED EPCS', style: AppTheme.headline(context)),
            const SizedBox(height: 8),
            Expanded(
              child: items.isEmpty
                  ? const Center(
                      child: Text(
                        'No EPCs yet.\nUse SIMULATE SCAN or the sled.',
                        textAlign: TextAlign.center,
                        style: TextStyle(color: AppColors.textMuted),
                      ),
                    )
                  : ListView.separated(
                      itemCount: items.length,
                      separatorBuilder: (_, __) => const Divider(height: 1, color: Color(0xFF334155)),
                      itemBuilder: (context, index) {
                        return ListTile(
                          title: Text(
                            items[index],
                            style: const TextStyle(
                              fontWeight: FontWeight.w600,
                              letterSpacing: 0.8,
                            ),
                          ),
                        );
                      },
                    ),
            ),
          ],
        ),
      ),
    );
  }
}
