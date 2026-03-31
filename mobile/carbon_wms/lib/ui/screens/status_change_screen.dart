import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/util/demo_epc.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';
import 'package:carbon_wms/ui/widgets/tactical_bottom_bar.dart';

/// Clean 10 bulk status via `POST /api/inventory/bulk-status` (server-enforced locks).
class StatusChangeScreen extends StatefulWidget {
  const StatusChangeScreen({super.key});

  @override
  State<StatusChangeScreen> createState() => _StatusChangeScreenState();
}

class _Opt {
  const _Opt(this.value, this.label);
  final String value;
  final String label;
}

const _options = <_Opt>[
  _Opt('in-stock', 'Live (in-stock)'),
  _Opt('return', 'Return'),
  _Opt('damaged', 'Damaged'),
  _Opt('sold', 'Sold'),
  _Opt('stolen', 'Stolen'),
  _Opt('tag_killed', 'Tag killed'),
  _Opt('UNKNOWN', 'Unknown'),
  _Opt('pending_visibility', 'Pending visibility (system)'),
  _Opt('in-transit', 'In transit (system)'),
  _Opt('pending_transaction', 'Pending transaction (system)'),
];

class _StatusChangeScreenState extends State<StatusChangeScreen> {
  String _target = 'in-stock';
  bool _override = false;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<RfidManager>().scanContext = 'STATUS_CHANGE';
    });
  }

  Future<void> _commit(BuildContext context) async {
    final m = context.read<RfidManager>();
    final epcs = m.sessionEpcs;
    if (epcs.isEmpty) return;
    setState(() => _busy = true);
    try {
      final j = await context.read<WmsApiClient>().postBulkStatus(
            epcs: epcs,
            targetStatus: _target,
            override: _override,
          );
      final updated = j['updated'];
      if (context.mounted) {
        m.clearSessionScans();
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Updated ${updated ?? epcs.length} item(s) → $_target')),
        );
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
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
            onPressed: () => manager.addSimulatedEpc(randomDemoEpc()),
          ),
          TacticalSlateButton(
            label: _busy ? '…' : 'APPLY BULK STATUS',
            onPressed: (items.isEmpty || _busy) ? null : () => unawaited(_commit(context)),
          ),
        ],
      ),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('TARGET STATUS', style: AppTheme.headline(context)),
            const SizedBox(height: 8),
            DropdownButtonFormField<String>(
              key: ValueKey(_target),
              initialValue: _target,
              decoration: const InputDecoration(labelText: 'Clean 10 WMS status'),
              items: _options
                  .map(
                    (o) => DropdownMenuItem(
                      value: o.value,
                      child: Text(o.label, style: const TextStyle(fontSize: 13)),
                    ),
                  )
                  .toList(),
              onChanged: (v) {
                if (v != null) setState(() => _target = v);
              },
            ),
            SwitchListTile(
              title: const Text('Super Admin override (risky transitions)'),
              value: _override,
              onChanged: (v) => setState(() => _override = v),
            ),
            const SizedBox(height: 8),
            Text('SCANNED EPCS (${items.length})', style: AppTheme.headline(context)),
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
                            style: const TextStyle(fontWeight: FontWeight.w600, letterSpacing: 0.8),
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
