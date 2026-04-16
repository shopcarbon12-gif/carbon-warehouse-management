import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/commission_retry_queue.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/camera_barcode_scanner.dart' show openCameraBarcodeScanner;
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Commissioning suite: catalog encode, UPC → server ZPL print, offline commission retry queue.
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
      pageTitle: 'ENCODE',
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Material(
            color: AppColors.surface,
            child: TabBar(
              controller: _tabs,
              indicatorColor: AppColors.primary,
              labelStyle: TextStyle(
                fontWeight: FontWeight.w800,
                letterSpacing: 0.6,
                fontSize: 12.sp,
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

class _SearchEncodeTab extends StatefulWidget {
  const _SearchEncodeTab();

  @override
  State<_SearchEncodeTab> createState() => _SearchEncodeTabState();
}

class _SearchEncodeTabState extends State<_SearchEncodeTab> {
  final _q = TextEditingController();
  List<dynamic> _matches = [];
  bool _busy = false;
  String? _err;
  final _qty = TextEditingController(text: '1');

  Future<void> _search() async {
    final qt = _q.text.trim();
    if (qt.length < 2) return;
    setState(() {
      _busy = true;
      _err = null;
    });
    try {
      final rows = await context.read<WmsApiClient>().fetchRfidCatalogSearch(qt);
      if (mounted) setState(() => _matches = rows);
    } catch (e) {
      if (mounted) setState(() => _err = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _commission(String customSkuId, String label) async {
    final n = int.tryParse(_qty.text.trim()) ?? 1;
    if (n < 1) return;
    setState(() => _busy = true);
    try {
      final j = await context.read<WmsApiClient>().postRfidCommission(
            customSkuId: customSkuId,
            qty: n,
            addToInventory: false,
          );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Commission: inserted=${j['inserted'] ?? '?'} printer_ok=${j['printer_ok']}')),
        );
      }
    } catch (e) {
      await CommissionRetryQueue.enqueue(
        CommissionQueueJob(customSkuId: customSkuId, qty: n, label: label),
      );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Failed — queued for Upload tab: $e'),
            backgroundColor: Colors.orange.shade900,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    _q.dispose();
    _qty.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: EdgeInsets.all(16.r),
      children: [
        TextField(
          controller: _q,
          style: const TextStyle(color: AppColors.textMain, fontWeight: FontWeight.w600),
          decoration: const InputDecoration(
            labelText: 'Search SKU / UPC / description',
            hintText: 'Min 2 characters',
          ),
          onSubmitted: (_) => unawaited(_search()),
        ),
        SizedBox(height: 8.h),
        TextField(
          controller: _qty,
          keyboardType: TextInputType.number,
          decoration: const InputDecoration(labelText: 'Qty to encode'),
        ),
        SizedBox(height: 8.h),
        FilledButton(
          onPressed: _busy ? null : () => unawaited(_search()),
          child: Text(_busy ? '…' : 'SEARCH CATALOG'),
        ),
        if (_err != null) Padding(padding: EdgeInsets.only(top: 8.h), child: Text(_err!, style: TextStyle(color: Colors.redAccent, fontSize: 12.sp))),
        SizedBox(height: 12.h),
        ..._matches.map((row) {
          if (row is! Map) return SizedBox.shrink();
          final id = row['id']?.toString() ?? '';
          final sku = row['sku']?.toString() ?? '';
          final title = row['description']?.toString() ?? '';
          final label = title.isNotEmpty ? title : sku;
          return Card(
            child: ListTile(
              title: Text(title.isNotEmpty ? title.toUpperCase() : sku, style: TextStyle(fontWeight: FontWeight.w800, fontSize: 12.sp)),
              subtitle: Text('$sku · id $id', style: TextStyle(color: AppColors.textMuted, fontSize: 11.sp)),
              trailing: FilledButton(
                onPressed: id.isEmpty || _busy ? null : () => unawaited(_commission(id, label)),
                style: FilledButton.styleFrom(
                  backgroundColor: AppColors.primary,
                  foregroundColor: Colors.white,
                ),
                child: const Text('WRITE'),
              ),
            ),
          );
        }),
      ],
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

  /// Server runs ZPL + optional raw print to configured printer (same as web commissioning).
  Future<void> _printViaCommission() async {
    final upc = _upcCtrl.text.trim();
    if (upc.length < 2) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Enter or scan at least 2 characters (UPC/SKU)')),
      );
      return;
    }
    setState(() => _busy = true);
    try {
      final api = context.read<WmsApiClient>();
      final matches = await api.fetchRfidCatalogSearch(upc);
      if (!mounted) return;
      if (matches.isEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('No catalog match — try Search tab')),
        );
        return;
      }
      final first = matches.first;
      if (first is! Map) return;
      final id = first['id']?.toString() ?? '';
      if (id.isEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Invalid catalog row')),
        );
        return;
      }
      final j = await api.postRfidCommission(
        customSkuId: id,
        qty: 1,
        addToInventory: false,
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            'Print job: inserted=${j['inserted'] ?? '?'} printer_ok=${j['printer_ok'] ?? '?'}',
          ),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.all(16.r),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('UPC / BARCODE', style: AppTheme.headline(context)),
          SizedBox(height: 8.h),
          TextField(
            controller: _upcCtrl,
            style: const TextStyle(
              color: AppColors.textMain,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.9,
            ),
            decoration: const InputDecoration(
              hintText: 'Scan or type UPC / SKU',
            ),
          ),
          SizedBox(height: 12.h),
          OutlinedButton.icon(
            onPressed: _busy
                ? null
                : () async {
                    final code = await openCameraBarcodeScanner(context, title: 'Scan UPC');
                    if (code != null && code.isNotEmpty && mounted) {
                      setState(() => _upcCtrl.text = code.trim());
                    }
                  },
            icon: Icon(Icons.photo_camera_outlined, size: 20.sp),
            label: const Text('CAMERA SCAN'),
          ),
          SizedBox(height: 16.h),
          FilledButton(
            onPressed: _busy ? null : () => unawaited(_printViaCommission()),
            style: FilledButton.styleFrom(
              backgroundColor: AppColors.primary,
              foregroundColor: Colors.white,
              padding: EdgeInsets.symmetric(vertical: 18.h),
            ),
            child: Text(
              _busy ? 'PRINTING…' : 'PRINT RFID LABEL (SERVER ZPL)',
              textAlign: TextAlign.center,
              style: const TextStyle(fontWeight: FontWeight.w900, letterSpacing: 0.8),
            ),
          ),
          SizedBox(height: 24.h),
          Text(
            'Resolves the first catalog match, then POST /api/rfid/commission (qty 1). Printer IP/port use server defaults unless you extend the API client.',
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
  List<CommissionQueueJob> _jobs = [];
  bool _loading = true;
  bool _syncing = false;

  @override
  void initState() {
    super.initState();
    unawaited(_reload());
  }

  Future<void> _reload() async {
    final jobs = await CommissionRetryQueue.load();
    if (mounted) {
      setState(() {
        _jobs = jobs;
        _loading = false;
      });
    }
  }

  Future<void> _syncAll() async {
    if (_jobs.isEmpty) return;
    setState(() => _syncing = true);
    final api = context.read<WmsApiClient>();
    final remaining = <CommissionQueueJob>[];
    var ok = 0;
    for (final job in _jobs) {
      try {
        await api.postRfidCommission(
          customSkuId: job.customSkuId,
          qty: job.qty,
          addToInventory: false,
        );
        ok++;
      } catch (_) {
        remaining.add(job);
      }
    }
    await CommissionRetryQueue.save(remaining);
    if (mounted) {
      setState(() {
        _jobs = remaining;
        _syncing = false;
      });
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Synced $ok job(s); ${remaining.length} still queued')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: EdgeInsets.fromLTRB(16.w, 16.h, 16.w, 8.h),
          child: Text('FAILED COMMISSION RETRY', style: AppTheme.headline(context)),
        ),
        Padding(
          padding: EdgeInsets.symmetric(horizontal: 16.w),
          child: Text(
            'Jobs land here when Search → WRITE fails (e.g. offline). Successful commissions from Search do not use this queue.',
            style: Theme.of(context).textTheme.bodySmall?.copyWith(color: AppColors.textMuted),
          ),
        ),
        SizedBox(height: 8.h),
        Expanded(
          child: _jobs.isEmpty
              ? const Center(
                  child: Text(
                    'Queue is clear.',
                    style: TextStyle(color: AppColors.textMuted),
                  ),
                )
              : ListView.separated(
                  padding: EdgeInsets.symmetric(horizontal: 16.w),
                  itemCount: _jobs.length,
                  separatorBuilder: (_, __) => Divider(height: 1.h, color: AppColors.border),
                  itemBuilder: (context, i) {
                    final j = _jobs[i];
                    return ListTile(
                      title: Text(
                        j.label,
                        style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13.sp),
                      ),
                      subtitle: Text(
                        'SKU id ${j.customSkuId} · qty ${j.qty}',
                        style: TextStyle(color: AppColors.textMuted, fontSize: 11.sp),
                      ),
                      trailing: Icon(Icons.cloud_upload_outlined, color: AppColors.textMuted),
                    );
                  },
                ),
        ),
        Padding(
          padding: EdgeInsets.all(16.r),
          child: Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: _syncing ? null : () => unawaited(_reload()),
                  child: const Text('REFRESH'),
                ),
              ),
              SizedBox(width: 12.w),
              Expanded(
                flex: 2,
                child: FilledButton(
                  onPressed: (_jobs.isEmpty || _syncing) ? null : () => unawaited(_syncAll()),
                  style: FilledButton.styleFrom(
                    backgroundColor: AppColors.slateActionDark,
                    foregroundColor: Colors.white,
                    padding: EdgeInsets.symmetric(vertical: 18.h),
                  ),
                  child: Text(
                    _syncing ? 'SYNCING…' : 'RETRY ALL',
                    style: const TextStyle(fontWeight: FontWeight.w900, letterSpacing: 1),
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
