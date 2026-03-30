import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/util/demo_epc.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Commissioning suite: catalog encode queue, label print bridge, offline upload queue.
class EncodeSuiteScreen extends StatefulWidget {
  const EncodeSuiteScreen({super.key, this.initialTab = 0});

  /// 0 = Search & Encode, 1 = Scan & Print, 2 = Upload
  final int initialTab;

  @override
  State<EncodeSuiteScreen> createState() => _EncodeSuiteScreenState();
}

class _EncodeSuiteScreenState extends State<EncodeSuiteScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabs;

  @override
  void initState() {
    super.initState();
    final i = widget.initialTab.clamp(0, 2);
    _tabs = TabController(length: 3, vsync: this, initialIndex: i);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<RfidManager>().scanContext = 'COMMISSIONING';
    });
  }

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Material(
            color: AppColors.surface,
            child: TabBar(
              controller: _tabs,
              indicatorColor: AppColors.primary,
              labelStyle: const TextStyle(
                fontWeight: FontWeight.w800,
                letterSpacing: 0.6,
                fontSize: 12,
              ),
              tabs: const [
                Tab(text: 'SEARCH & ENCODE'),
                Tab(text: 'SCAN & PRINT'),
                Tab(text: 'UPLOAD'),
              ],
            ),
          ),
          Expanded(
            child: TabBarView(
              controller: _tabs,
              children: const [
                _SearchEncodeTab(),
                _ScanPrintTab(),
                _UploadQueueTab(),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _CatalogRow {
  const _CatalogRow({required this.sku, required this.title, required this.qty});

  final String sku;
  final String title;
  final int qty;
}

class _SearchEncodeTab extends StatelessWidget {
  const _SearchEncodeTab();

  static const _rows = <_CatalogRow>[
    _CatalogRow(sku: 'SKU-884210', title: 'Carbon tube 31mm', qty: 6),
    _CatalogRow(sku: 'SKU-441902', title: 'Binder post M5', qty: 14),
    _CatalogRow(sku: 'SKU-102233', title: 'Fork seal kit', qty: 3),
  ];

  @override
  Widget build(BuildContext context) {
    return ListView.separated(
      padding: const EdgeInsets.all(16),
      itemCount: _rows.length,
      separatorBuilder: (_, __) => const SizedBox(height: 10),
      itemBuilder: (context, index) {
        final r = _rows[index];
        return Card(
          child: ListTile(
            title: Text(
              r.title.toUpperCase(),
              style: const TextStyle(fontWeight: FontWeight.w800, letterSpacing: 0.6),
            ),
            subtitle: Text(
              '${r.sku}  ·  QTY ${r.qty}',
              style: const TextStyle(color: AppColors.textMuted),
            ),
            trailing: FilledButton(
              onPressed: () {
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(content: Text('Encode queued for ${r.sku} (stub)')),
                );
              },
              style: FilledButton.styleFrom(
                backgroundColor: AppColors.primary,
                foregroundColor: AppColors.background,
              ),
              child: const Text('WRITE'),
            ),
          ),
        );
      },
    );
  }
}

class _ScanPrintTab extends StatefulWidget {
  const _ScanPrintTab();

  @override
  State<_ScanPrintTab> createState() => _ScanPrintTabState();
}

class _ScanPrintTabState extends State<_ScanPrintTab> {
  final _upcCtrl = TextEditingController();
  bool _busy = false;

  @override
  void dispose() {
    _upcCtrl.dispose();
    super.dispose();
  }

  Future<void> _mockPrintZpl() async {
    final upc = _upcCtrl.text.trim();
    if (upc.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Enter a UPC first')),
      );
      return;
    }
    setState(() => _busy = true);
    await Future<void>.delayed(const Duration(milliseconds: 650));
    if (!mounted) return;
    setState(() => _busy = false);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text('ZPL label job sent for $upc (mock printer bridge)'),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('UPC / BARCODE', style: AppTheme.headline(context)),
          const SizedBox(height: 8),
          TextField(
            controller: _upcCtrl,
            style: const TextStyle(
              color: AppColors.textMain,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.9,
            ),
            decoration: const InputDecoration(
              hintText: 'Scan or type UPC',
            ),
          ),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: _busy ? null : () => unawaited(_mockPrintZpl()),
            style: FilledButton.styleFrom(
              backgroundColor: AppColors.primary,
              foregroundColor: AppColors.background,
              padding: const EdgeInsets.symmetric(vertical: 18),
            ),
            child: Text(
              _busy ? 'PRINTING…' : 'PRINT RFID LABEL (ZPL)',
              textAlign: TextAlign.center,
              style: const TextStyle(fontWeight: FontWeight.w900, letterSpacing: 0.8),
            ),
          ),
          const SizedBox(height: 24),
          Text(
            'Printer profile and DPI are configured on the edge gateway. This handset only submits jobs.',
            style: Theme.of(context).textTheme.bodySmall?.copyWith(color: AppColors.textMuted),
          ),
        ],
      ),
    );
  }
}

class _UploadQueueTab extends StatefulWidget {
  const _UploadQueueTab();

  @override
  State<_UploadQueueTab> createState() => _UploadQueueTabState();
}

class _UploadQueueTabState extends State<_UploadQueueTab> {
  final List<String> _pending = <String>[
    randomDemoEpc(),
    randomDemoEpc(),
  ];
  bool _syncing = false;

  Future<void> _syncAll() async {
    if (_pending.isEmpty) return;
    setState(() => _syncing = true);
    await Future<void>.delayed(const Duration(milliseconds: 800));
    if (!mounted) return;
    setState(() {
      _pending.clear();
      _syncing = false;
    });
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Offline encodes pushed to CarbonWMS (stub)')),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
          child: Text('OFFLINE ENCODED TAGS', style: AppTheme.headline(context)),
        ),
        Expanded(
          child: _pending.isEmpty
              ? const Center(
                  child: Text(
                    'Queue is clear.',
                    style: TextStyle(color: AppColors.textMuted),
                  ),
                )
              : ListView.separated(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  itemCount: _pending.length,
                  separatorBuilder: (_, __) => const Divider(height: 1, color: Color(0xFF334155)),
                  itemBuilder: (context, i) => ListTile(
                    title: Text(
                      _pending[i],
                      style: const TextStyle(fontWeight: FontWeight.w700, letterSpacing: 0.8),
                    ),
                    trailing: const Icon(Icons.cloud_upload_outlined, color: AppColors.textMuted),
                  ),
                ),
        ),
        Padding(
          padding: const EdgeInsets.all(16),
          child: FilledButton(
            onPressed: (_pending.isEmpty || _syncing) ? null : () => unawaited(_syncAll()),
            style: FilledButton.styleFrom(
              backgroundColor: AppColors.slateActionDark,
              foregroundColor: AppColors.textMain,
              padding: const EdgeInsets.symmetric(vertical: 18),
            ),
            child: Text(
              _syncing ? 'SYNCING…' : 'SYNC NOW',
              style: const TextStyle(fontWeight: FontWeight.w900, letterSpacing: 1),
            ),
          ),
        ),
      ],
    );
  }
}
