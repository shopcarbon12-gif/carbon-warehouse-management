import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:printing/printing.dart';
import 'package:provider/provider.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/handheld_device_identity.dart';
import 'package:carbon_wms/services/mobile_permissions.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/guards/permission_guard.dart';
import 'package:carbon_wms/ui/screens/cloud_geiger_screen.dart';
import 'package:carbon_wms/ui/screens/tag_page_screen.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart' show CarbonScaffold;

/// End-of-count report (owner, 2026-10-16) — Inventory Count, Add-On Count,
/// Add-On Catalog. Summary, every NEW Unknown tag the count found (a fresh
/// number never recorded in the WMS) and the defective tags; EXCEL / PDF from
/// the WMS; CLOUD + GEIGER puts the Unknown tags still waiting on this
/// handheld's Cloud + Geiger, to find them and change them to LIVE.
class CountReportScreen extends StatefulWidget {
  const CountReportScreen({super.key, required this.reportId});

  final String reportId;

  @override
  State<CountReportScreen> createState() => _CountReportScreenState();
}

const Color _kWarn = Color(0xFFB45309);
const Color _kRed = Color(0xFFBF2E2E);

class _CountReportScreenState extends State<CountReportScreen> {
  Map<String, dynamic>? _rep;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final r = await context.read<WmsApiClient>().fetchCountReport(widget.reportId);
      if (mounted) setState(() => _rep = r);
    } catch (e) {
      if (mounted) setState(() => _error = 'Could not load the report: $e');
    }
  }

  List<Map<String, dynamic>> _list(String key) =>
      (_rep?[key] is List ? _rep![key] as List : const []).whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList();

  List<String> get _waiting => _list('unknown')
      .where((u) => '${u['statusNow'] ?? ''}'.startsWith('Unknown'))
      .map((u) => '${u['epc']}')
      .toList();

  Future<void> _file(String format) async {
    if (_busy) return;
    setState(() => _busy = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      final f = await context.read<WmsApiClient>().downloadCountReport(widget.reportId, format);
      if (format == 'pdf') {
        await Printing.layoutPdf(onLayout: (_) async => f.bytes, name: f.filename);
      } else {
        // Share sheet: email, Drive, Downloads…
        await Printing.sharePdf(bytes: f.bytes, filename: f.filename);
      }
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('Could not get the ${format.toUpperCase()}: $e')));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _cloudGeiger() async {
    final epcs = _waiting;
    final messenger = ScaffoldMessenger.of(context);
    if (epcs.isEmpty) {
      messenger.showSnackBar(const SnackBar(content: Text('No Unknown tags waiting in this count.')));
      return;
    }
    setState(() => _busy = true);
    try {
      final deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
      if (!mounted) return;
      final n = await context.read<WmsApiClient>().addToMyEpcQueue(deviceId: deviceId, epcs: epcs);
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text('$n tag${n == 1 ? '' : 's'} added to Cloud + Geiger.')));
      await context.pushGuarded<void>(ScreenIds.cloudGeiger, (_) => const CloudGeigerScreen());
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('Could not send to Cloud + Geiger: $e')));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String _et(Object? iso) {
    final d = DateTime.tryParse('${iso ?? ''}');
    if (d == null) return '';
    final l = d.toLocal();
    String two(int n) => n.toString().padLeft(2, '0');
    final h = l.hour % 12 == 0 ? 12 : l.hour % 12;
    return '${l.month}/${l.day} $h:${two(l.minute)} ${l.hour < 12 ? 'AM' : 'PM'}';
  }

  @override
  Widget build(BuildContext context) {
    final rep = _rep;
    final t = rep?['totals'] is Map ? Map<String, dynamic>.from(rep!['totals'] as Map) : const <String, dynamic>{};
    final unknown = _list('unknown');
    final defective = _list('defective');
    final waiting = _waiting.length;
    return CarbonScaffold(
      pageTitle: 'COUNT REPORT',
      body: SafeArea(
        child: rep == null
            ? Center(child: Padding(padding: EdgeInsets.all(24.w), child: Text(_error ?? 'Loading report…')))
            : ListView(
                padding: EdgeInsets.all(12.w),
                children: [
                  Text('${rep['title'] ?? 'Count'}', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 14.sp)),
                  SizedBox(height: 2.h),
                  Text(
                    [
                      if ('${rep['endedAt'] ?? ''}'.isNotEmpty) _et(rep['endedAt']),
                      if (rep['by'] is List && (rep['by'] as List).isNotEmpty) (rep['by'] as List).join(', '),
                      if (rep['devices'] is List && (rep['devices'] as List).isNotEmpty) (rep['devices'] as List).join(', '),
                    ].join(' · '),
                    style: TextStyle(fontSize: 12.sp, color: AppColors.textMuted),
                  ),
                  SizedBox(height: 10.h),
                  Wrap(
                    spacing: 6.w,
                    runSpacing: 6.h,
                    children: [
                      _tile('READ', t['read']),
                      _tile('LIVE', t['live']),
                      _tile('BACK FROM UNKNOWN', t['cameBack']),
                      _tile('NEW UNKNOWN', t['newUnknown'], color: _kWarn),
                      _tile('EARLIER UNKNOWN', t['earlierUnknown'], color: _kWarn),
                      _tile('DEFECTIVE', t['defective'], color: _kRed),
                      _tile('OTHER', t['other']),
                    ],
                  ),
                  SizedBox(height: 10.h),
                  Row(
                    children: [
                      Expanded(child: OutlinedButton(onPressed: _busy ? null : () => unawaited(_file('xlsx')), child: const Text('EXCEL'))),
                      SizedBox(width: 6.w),
                      Expanded(child: OutlinedButton(onPressed: _busy ? null : () => unawaited(_file('pdf')), child: const Text('PDF'))),
                    ],
                  ),
                  SizedBox(height: 6.h),
                  FilledButton.icon(
                    onPressed: _busy || waiting == 0 ? null : () => unawaited(_cloudGeiger()),
                    icon: const Icon(Icons.radar_outlined),
                    label: Text(waiting == 0 ? 'NO UNKNOWN TAGS WAITING' : 'CLOUD + GEIGER — $waiting UNKNOWN'),
                  ),
                  SizedBox(height: 14.h),
                  Text('NEW UNKNOWN TAGS (${unknown.length})', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 12.5.sp)),
                  SizedBox(height: 6.h),
                  if (unknown.isEmpty)
                    Text('None — every tag this count read was already known.', style: TextStyle(fontSize: 12.sp, color: AppColors.textMuted)),
                  for (final u in unknown) _unknownRow(u),
                  if (defective.isNotEmpty) ...[
                    SizedBox(height: 14.h),
                    Text('DEFECTIVE — TAG KILLED (${defective.length})', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 12.5.sp)),
                    SizedBox(height: 6.h),
                    for (final d in defective)
                      Container(
                        margin: EdgeInsets.only(bottom: 4.h),
                        padding: EdgeInsets.symmetric(horizontal: 10.w, vertical: 6.h),
                        decoration: const BoxDecoration(
                          color: Color(0xFFECECEC),
                          border: Border(left: BorderSide(color: _kRed, width: 4)),
                        ),
                        child: Text('${d['epc']}  ·  ${d['reason'] ?? ''}',
                            style: TextStyle(fontSize: 11.5.sp, fontFamily: 'monospace')),
                      ),
                  ],
                ],
              ),
      ),
    );
  }

  Widget _tile(String label, Object? value, {Color? color}) {
    return Container(
      width: 104.w,
      padding: EdgeInsets.symmetric(horizontal: 8.w, vertical: 6.h),
      color: const Color(0xFFEEF4F3),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('${value ?? 0}', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18.sp, color: color ?? AppColors.textMain)),
          Text(label, style: TextStyle(fontSize: 9.5.sp, fontWeight: FontWeight.w700, color: AppColors.textMuted)),
        ],
      ),
    );
  }

  Widget _unknownRow(Map<String, dynamic> u) {
    final product = [u['product'], u['color'], u['size']].where((v) => v != null && '$v'.isNotEmpty).join(' · ');
    final here = u['foundHere'] == true;
    final status = '${u['statusNow'] ?? ''}';
    final waiting = status.startsWith('Unknown');
    return InkWell(
      onTap: () => Navigator.push(
        context,
        MaterialPageRoute<void>(
          builder: (_) => TagPageScreen(
            epc: '${u['epc']}',
            reason: waiting ? 'New Unknown tag — find it and change it to LIVE' : null,
            fallbackSku: '${u['sku'] ?? ''}'.isEmpty ? null : '${u['sku']}',
            fallbackName: '${u['product'] ?? ''}'.isEmpty ? null : '${u['product']}',
          ),
        ),
      ),
      child: Container(
        margin: EdgeInsets.only(bottom: 6.h),
        decoration: BoxDecoration(
          color: const Color(0xFFECECEC),
          border: Border(left: BorderSide(color: waiting ? _kWarn : const Color(0xFF16A34A), width: 4)),
        ),
        padding: EdgeInsets.symmetric(horizontal: 10.w, vertical: 8.h),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(product.isEmpty ? '${u['epc']}' : product, style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13.5.sp)),
            Text(
              '${here ? 'NEW in this count' : 'Found earlier'} · ${status.isEmpty ? 'Unknown' : status}'
              '${'${u['bin'] ?? ''}'.isNotEmpty ? ' · bin ${u['bin']}' : ''}',
              style: TextStyle(fontSize: 12.sp, color: waiting ? _kWarn : AppColors.textMuted),
            ),
            Text(
              [
                if ('${u['readAt'] ?? ''}'.isNotEmpty) 'Read ${_et(u['readAt'])}',
                if ('${u['readBy'] ?? ''}'.isNotEmpty) '${u['readBy']}',
              ].join(' · '),
              style: TextStyle(fontSize: 11.sp, color: AppColors.textMuted),
            ),
            Text('${u['epc']}', style: TextStyle(fontSize: 11.sp, color: AppColors.textMuted, fontFamily: 'monospace')),
          ],
        ),
      ),
    );
  }
}
