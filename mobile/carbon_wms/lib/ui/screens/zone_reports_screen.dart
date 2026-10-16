import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/tag_page_screen.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart' show CarbonScaffold;

/// Reports → Zones (owner, 2026-10-16): every Zone Management assign /
/// remove, newest first — the same reports the desktop shows under
/// Reports → Device Upload Logs. Open one to see every tag of that scan and
/// what happened to it, couldn't-assign tags with the reason; tap a line for
/// the tag page.
class ZoneReportsScreen extends StatefulWidget {
  const ZoneReportsScreen({super.key});

  @override
  State<ZoneReportsScreen> createState() => _ZoneReportsScreenState();
}

String _when(Object? iso) {
  if (iso is! String || iso.isEmpty) return '—';
  final t = DateTime.tryParse(iso)?.toLocal();
  if (t == null) return '—';
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  final h = t.hour % 12 == 0 ? 12 : t.hour % 12;
  return '${m[t.month - 1]} ${t.day} $h:${t.minute.toString().padLeft(2, '0')} ${t.hour < 12 ? 'AM' : 'PM'}';
}

class _ZoneReportsScreenState extends State<ZoneReportsScreen> {
  List<Map<String, dynamic>>? _reports;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => unawaited(_load()));
  }

  Future<void> _load() async {
    try {
      final r = await context.read<WmsApiClient>().fetchZoneReports();
      if (mounted) setState(() => _reports = r);
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  @override
  Widget build(BuildContext context) {
    final reports = _reports;
    return CarbonScaffold(
      pageTitle: 'ZONE REPORTS',
      body: SafeArea(
        child: RefreshIndicator(
          onRefresh: _load,
          child: reports == null
              ? ListView(children: [
                  Padding(padding: EdgeInsets.all(24.w), child: Text(_error ?? 'Loading…', textAlign: TextAlign.center)),
                ])
              : reports.isEmpty
                  ? ListView(children: [
                      Padding(
                        padding: EdgeInsets.all(24.w),
                        child: const Text('No zone reports yet — they appear after an ASSIGN or REMOVE in Zone Management.',
                            textAlign: TextAlign.center),
                      ),
                    ])
                  : ListView.builder(
                      padding: EdgeInsets.all(12.w),
                      itemCount: reports.length,
                      itemBuilder: (_, i) {
                        final r = reports[i];
                        return Card(
                          margin: EdgeInsets.only(bottom: 8.h),
                          shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
                          child: ListTile(
                            title: Text('${r['mode']}', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13.5.sp)),
                            subtitle: Text('${_when(r['createdAt'])} · ${r['device'] ?? ''}'),
                            trailing: const Icon(Icons.chevron_right),
                            onTap: () => Navigator.push(
                              context,
                              MaterialPageRoute<void>(
                                builder: (_) => _ZoneReportScreen(id: (r['id'] as num).toInt(), title: '${r['mode']}'),
                              ),
                            ),
                          ),
                        );
                      },
                    ),
        ),
      ),
    );
  }
}

class _ZoneReportScreen extends StatefulWidget {
  const _ZoneReportScreen({required this.id, required this.title});
  final int id;
  final String title;

  @override
  State<_ZoneReportScreen> createState() => _ZoneReportScreenState();
}

enum _Filter { all, done, notDone }

class _ZoneReportScreenState extends State<_ZoneReportScreen> {
  List<Map<String, dynamic>>? _lines;
  String? _error;
  _Filter _filter = _Filter.all;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => unawaited(_load()));
  }

  Future<void> _load() async {
    try {
      final j = await context.read<WmsApiClient>().fetchZoneReport(widget.id);
      final lines = j['lines'];
      if (!mounted) return;
      setState(() => _lines = lines is List
          ? lines.whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList()
          : <Map<String, dynamic>>[]);
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  static bool _isDone(Map<String, dynamic> l) {
    final r = '${l['Result']}';
    return r == 'assigned' || r == 'moved' || r == 'removed' || r == 'already in zone';
  }

  @override
  Widget build(BuildContext context) {
    final all = _lines;
    final shown = all
        ?.where((l) => switch (_filter) {
              _Filter.all => true,
              _Filter.done => _isDone(l),
              _Filter.notDone => !_isDone(l),
            })
        .toList();
    final notDone = all?.where((l) => !_isDone(l)).length ?? 0;
    return CarbonScaffold(
      pageTitle: 'ZONE REPORT',
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: EdgeInsets.fromLTRB(12.w, 10.h, 12.w, 4.h),
              child: Text(widget.title, style: TextStyle(fontWeight: FontWeight.w800, fontSize: 13.5.sp)),
            ),
            Padding(
              padding: EdgeInsets.symmetric(horizontal: 12.w),
              child: SegmentedButton<_Filter>(
                showSelectedIcon: false,
                segments: [
                  ButtonSegment(value: _Filter.all, label: Text('ALL ${all?.length ?? ''}')),
                  const ButtonSegment(value: _Filter.done, label: Text('DONE')),
                  ButtonSegment(value: _Filter.notDone, label: Text('COULDN\'T $notDone')),
                ],
                selected: {_filter},
                onSelectionChanged: (s) => setState(() => _filter = s.first),
              ),
            ),
            Expanded(
              child: shown == null
                  ? Center(child: Text(_error ?? 'Loading…'))
                  : ListView.builder(
                      padding: EdgeInsets.all(12.w),
                      itemCount: shown.length,
                      itemBuilder: (_, i) {
                        final l = shown[i];
                        final done = _isDone(l);
                        final product = [l['Product'], l['Color'], l['Size']]
                            .where((v) => v != null && '$v'.isNotEmpty)
                            .join(' · ');
                        final reason = '${l['Reason'] ?? ''}';
                        return InkWell(
                          onTap: () => Navigator.push(
                            context,
                            MaterialPageRoute<void>(
                              builder: (_) => TagPageScreen(
                                epc: '${l['EPC']}',
                                reason: done ? null : reason,
                                fallbackSku: '${l['SKU'] ?? ''}'.isEmpty ? null : '${l['SKU']}',
                                fallbackName: '${l['Product'] ?? ''}'.isEmpty ? null : '${l['Product']}',
                              ),
                            ),
                          ),
                          child: Container(
                            margin: EdgeInsets.only(bottom: 6.h),
                            decoration: BoxDecoration(
                              color: const Color(0xFFECECEC),
                              border: Border(
                                left: BorderSide(color: done ? const Color(0xFF16A34A) : const Color(0xFFB45309), width: 4),
                              ),
                            ),
                            padding: EdgeInsets.symmetric(horizontal: 10.w, vertical: 8.h),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(product.isEmpty ? '${l['EPC']}' : product,
                                    style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13.5.sp)),
                                Text(
                                  '${l['Result']}${reason.isNotEmpty ? ' — $reason' : ''}'
                                  '${'${l['Bin'] ?? ''}'.isNotEmpty ? ' · bin ${l['Bin']}' : ''}',
                                  style: TextStyle(
                                    fontSize: 12.sp,
                                    color: done ? AppColors.textMuted : const Color(0xFFB45309),
                                  ),
                                ),
                                Text('${l['EPC']}',
                                    style: TextStyle(fontSize: 11.sp, color: AppColors.textMuted, fontFamily: 'monospace')),
                              ],
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
