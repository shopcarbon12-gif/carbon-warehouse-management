import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/mobile_settings_repository.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/util/demo_epc.dart';
import 'package:carbon_wms/util/template_substitution.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';
import 'package:carbon_wms/ui/widgets/tactical_bottom_bar.dart';

class TransferScreen extends StatefulWidget {
  const TransferScreen({super.key});

  @override
  State<TransferScreen> createState() => _TransferScreenState();
}

class _TransferScreenState extends State<TransferScreen> {
  static const _fallbackBins = <String>[
    'RCV-STAGE',
    'BULK-A-01',
    'BULK-A-02',
    'PICK-B-14',
    'SHIP-DOCK-3',
  ];

  List<String> _bins = List<String>.from(_fallbackBins);
  late String _origin = _bins.first;
  late String _destination = _bins.length > 2 ? _bins[2] : _bins.last;

  void _syncMeta(RfidManager m) {
    m.setIngestMetadata({
      'originLocation': _origin,
      'destinationLocation': _destination,
    });
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final m = context.read<RfidManager>();
      m.scanContext = 'TRANSFER';
      _syncMeta(m);
      try {
        final codes = await context.read<WmsApiClient>().fetchSessionLocationCodes();
        if (codes.isNotEmpty && mounted) {
          setState(() {
            _bins = codes;
            _origin = _bins.first;
            _destination = _bins.length > 2 ? _bins[2] : _bins.last;
          });
          _syncMeta(m);
        }
      } catch (_) {
        /* keep demo bins */
      }
    });
  }

  Future<void> _commitTransfer(BuildContext context) async {
    final m = context.read<RfidManager>();
    _syncMeta(m);
    m.setIngestMetadata({
      'originLocation': _origin,
      'destinationLocation': _destination,
      'committed': true,
    });
    try {
      await m.ingestSessionSnapshot();
      if (context.mounted) {
        m.clearSessionScans();
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Transfer committed')),
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
    final settings = context.watch<MobileSettingsRepository>();
    final items = manager.sessionEpcs;

    return CarbonScaffold(
      bottomBar: TacticalBottomBar(
        children: [
          TacticalEmeraldButton(
            label: 'SIMULATE SCAN',
            onPressed: () {
              final m = context.read<RfidManager>();
              _syncMeta(m);
              m.addSimulatedEpc(randomDemoEpc());
            },
          ),
          TacticalSlateButton(
            label: 'COMMIT TRANSFER',
            onPressed: items.isEmpty
                ? null
                : () => unawaited(_commitTransfer(context)),
          ),
        ],
      ),
      body: CustomScrollView(
        slivers: [
          SliverPadding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
            sliver: SliverToBoxAdapter(
              child: Text('LOCATIONS', style: AppTheme.headline(context)),
            ),
          ),
          SliverPadding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            sliver: SliverToBoxAdapter(
              child: DropdownButtonFormField<String>(
                key: ValueKey<String>('o-${_bins.join('|')}'),
                initialValue: _bins.contains(_origin) ? _origin : _bins.first,
                decoration: const InputDecoration(labelText: 'Origin location'),
                items: _bins
                    .map((b) => DropdownMenuItem(value: b, child: Text(b)))
                    .toList(),
                onChanged: (v) {
                  if (v == null) return;
                  setState(() => _origin = v);
                  _syncMeta(context.read<RfidManager>());
                },
              ),
            ),
          ),
          SliverPadding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
            sliver: SliverToBoxAdapter(
              child: DropdownButtonFormField<String>(
                key: ValueKey<String>('d-${_bins.join('|')}'),
                initialValue: _bins.contains(_destination) ? _destination : _bins.last,
                decoration: const InputDecoration(labelText: 'Destination location'),
                items: _bins
                    .map((b) => DropdownMenuItem(value: b, child: Text(b)))
                    .toList(),
                onChanged: (v) {
                  if (v == null) return;
                  setState(() => _destination = v);
                  _syncMeta(context.read<RfidManager>());
                },
              ),
            ),
          ),
          SliverPersistentHeader(
            pinned: true,
            delegate: _TotalHeaderDelegate(
              count: items.length,
              background: AppColors.background,
            ),
          ),
          if (items.isEmpty)
            const SliverFillRemaining(
              hasScrollBody: false,
              child: Center(
                child: Text(
                  'No tags in session.\nTap SIMULATE SCAN or read tags on the sled.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: AppColors.textMuted),
                ),
              ),
            )
          else
            SliverList(
              delegate: SliverChildBuilderDelegate(
                (context, index) {
                  final epc = items[index];
                  final tagLine = applyMustacheTemplate(settings.config.tagDetailsTemplate, {
                    'epc.id': epc,
                    'epc.status': 'UNKNOWN',
                    'epc.lastSeen': '—',
                    'epc.zone': _origin,
                  });
                  return ListTile(
                    title: Text(
                      epc,
                      style: const TextStyle(
                        fontWeight: FontWeight.w600,
                        letterSpacing: 0.8,
                      ),
                    ),
                    subtitle: Text(
                      tagLine,
                      style: const TextStyle(
                        color: AppColors.textMuted,
                        fontSize: 12,
                        height: 1.3,
                      ),
                    ),
                    isThreeLine: tagLine.contains('\n'),
                    tileColor: index.isEven ? AppColors.background : AppColors.surface,
                  );
                },
                childCount: items.length,
              ),
            ),
        ],
      ),
    );
  }
}

class _TotalHeaderDelegate extends SliverPersistentHeaderDelegate {
  _TotalHeaderDelegate({required this.count, required this.background});

  final int count;
  final Color background;

  @override
  double get minExtent => 52;

  @override
  double get maxExtent => 52;

  @override
  Widget build(
    BuildContext context,
    double shrinkOffset,
    bool overlapsContent,
  ) {
    return Material(
      color: background,
      elevation: overlapsContent ? 4 : 0,
      child: Container(
        alignment: Alignment.centerLeft,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        decoration: const BoxDecoration(
          border: Border(
            top: BorderSide(color: Color(0xFF334155)),
            bottom: BorderSide(color: Color(0xFF334155)),
          ),
        ),
        child: Text(
          'TOTAL SCANNED: $count',
          style: AppTheme.headline(context).copyWith(color: AppColors.textMain),
        ),
      ),
    );
  }

  @override
  bool shouldRebuild(covariant _TotalHeaderDelegate oldDelegate) {
    return oldDelegate.count != count || oldDelegate.background != background;
  }
}
