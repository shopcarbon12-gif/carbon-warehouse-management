import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Reports → Count Reports.
///
/// Mirrors `inventory_reports` rows that the Count screen archived via the
/// Save / Upload flow. The same data drives the web `/reports/count-sessions`
/// page — this screen is a 100% read-only mirror, just rendered in the
/// Count-style row containers operators are already used to.
class CountReportsScreen extends StatefulWidget {
  const CountReportsScreen({super.key});

  @override
  State<CountReportsScreen> createState() => _CountReportsScreenState();
}

class _CountReportsScreenState extends State<CountReportsScreen> {
  static const int _pageSize = 50;

  final ScrollController _scrollCtrl = ScrollController();

  int _page = 1;
  int _total = 0;
  bool _loading = false;
  bool _loadingMore = false;
  String? _error;
  final List<Map<String, dynamic>> _rows = [];

  @override
  void initState() {
    super.initState();
    _scrollCtrl.addListener(_onScroll);
    WidgetsBinding.instance.addPostFrameCallback((_) => _refresh());
  }

  @override
  void dispose() {
    _scrollCtrl.removeListener(_onScroll);
    _scrollCtrl.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (_loadingMore || _loading) return;
    if (_rows.length >= _total) return;
    final pos = _scrollCtrl.position;
    if (pos.pixels >= pos.maxScrollExtent - 240) {
      unawaited(_loadNextPage());
    }
  }

  Future<void> _refresh() async {
    if (_loading) return;
    setState(() {
      _loading = true;
      _error = null;
      _page = 1;
      _rows.clear();
      _total = 0;
    });
    try {
      final api = context.read<WmsApiClient>();
      final res = await api.fetchCountSessionReports(
        page: 1,
        limit: _pageSize,
      );
      if (!mounted) return;
      final rows = (res['rows'] as List?)
              ?.whereType<Map<String, dynamic>>()
              .toList() ??
          [];
      setState(() {
        _rows.addAll(rows);
        _total = (res['total'] as num?)?.toInt() ?? rows.length;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = 'Reports load failed: $e';
      });
    }
  }

  Future<void> _loadNextPage() async {
    if (_loadingMore || _loading) return;
    if (_rows.length >= _total) return;
    setState(() {
      _loadingMore = true;
      _error = null;
    });
    final next = _page + 1;
    try {
      final api = context.read<WmsApiClient>();
      final res = await api.fetchCountSessionReports(
        page: next,
        limit: _pageSize,
      );
      if (!mounted) return;
      final rows = (res['rows'] as List?)
              ?.whereType<Map<String, dynamic>>()
              .toList() ??
          [];
      setState(() {
        _page = next;
        _rows.addAll(rows);
        _total = (res['total'] as num?)?.toInt() ?? _total;
        _loadingMore = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loadingMore = false;
        _error = 'Load more failed: $e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      pageTitle: 'COUNT REPORTS',
      body: Column(
        children: [
          Padding(
            padding: EdgeInsets.fromLTRB(20.w, 12.h, 20.w, 8.h),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(
                _loading && _rows.isEmpty
                    ? 'LOADING…'
                    : '$_total REPORTS · LIVE FROM WMS',
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 11.sp,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 1.4,
                  color: const Color(0xFF6D7979),
                ),
              ),
            ),
          ),
          if (_error != null)
            Padding(
              padding: EdgeInsets.fromLTRB(20.w, 4.h, 20.w, 4.h),
              child: Text(
                _error!,
                style: GoogleFonts.manrope(
                  fontSize: 12.sp,
                  fontWeight: FontWeight.w700,
                  color: const Color(0xFFBF2E2E),
                ),
              ),
            ),
          Expanded(
            child: _loading && _rows.isEmpty
                ? const Center(child: CircularProgressIndicator())
                : _rows.isEmpty
                    ? Center(
                        child: Padding(
                          padding: EdgeInsets.all(24.r),
                          child: Text(
                            'No count reports archived yet.\nSave or upload from the Count screen to populate this list.',
                            textAlign: TextAlign.center,
                            style: GoogleFonts.manrope(
                              fontSize: 14.sp,
                              fontWeight: FontWeight.w700,
                              color: const Color(0xFF5A6464),
                              height: 1.4,
                            ),
                          ),
                        ),
                      )
                    : RefreshIndicator(
                        onRefresh: _refresh,
                        child: ListView.separated(
                          controller: _scrollCtrl,
                          padding: EdgeInsets.fromLTRB(20.w, 0, 20.w, 12.h),
                          itemCount: _rows.length + (_loadingMore ? 1 : 0),
                          separatorBuilder: (_, __) => SizedBox(height: 12.h),
                          itemBuilder: (_, i) {
                            if (i >= _rows.length) {
                              return Padding(
                                padding: EdgeInsets.symmetric(vertical: 16.h),
                                child: const Center(
                                    child: CircularProgressIndicator()),
                              );
                            }
                            return _CountReportCard(row: _rows[i]);
                          },
                        ),
                      ),
          ),
        ],
      ),
    );
  }
}

/// One archived count-session report. Visual rhythm matches
/// `_CountItemContainer`: SKU-strength row 1, smaller meta rows, big teal
/// number on the right.
///
///   Row 1 (left)  — Activity (e.g. "INVENTORY") · row count
///   Row 1 (right) — qty count (rows in the report) in primary teal
///   Row 2         — uploaded_by_email or device id fallback
///   Row 3         — local-date timestamp + filename
class _CountReportCard extends StatelessWidget {
  const _CountReportCard({required this.row});

  final Map<String, dynamic> row;

  String _formatLocal(DateTime dt) {
    final l = dt.toLocal();
    String two(int n) => n.toString().padLeft(2, '0');
    final ymd = '${l.year}-${two(l.month)}-${two(l.day)}';
    final hms = '${two(l.hour)}:${two(l.minute)}';
    return '$ymd · $hms';
  }

  @override
  Widget build(BuildContext context) {
    final activity = (row['activity']?.toString() ?? '').toUpperCase();
    final uploadedAtRaw = row['uploaded_at']?.toString();
    final dt = DateTime.tryParse(uploadedAtRaw ?? '')?.toLocal();
    final dateText = dt != null ? _formatLocal(dt) : (uploadedAtRaw ?? '—');
    final email = row['uploaded_by_email']?.toString();
    final deviceId = row['device_id']?.toString() ?? '';
    final whoLine = (email != null && email.isNotEmpty)
        ? email
        : (deviceId.isNotEmpty ? 'device $deviceId' : 'unknown user');
    final rowCount = (row['row_count'] as num?)?.toInt() ?? 0;
    final overrideCatalog = row['override_catalog'] == true;
    final filename = row['filename']?.toString() ?? '';

    final activityStyle = GoogleFonts.robotoMono(
      fontSize: 19.sp,
      fontWeight: FontWeight.w700,
      color: AppColors.textMain,
      height: 1.2,
    );
    final whoStyle = GoogleFonts.manrope(
      fontSize: 14.sp,
      fontWeight: FontWeight.w700,
      color: AppColors.textMain,
      height: 1.2,
    );
    final dateStyle = GoogleFonts.manrope(
      fontSize: 13.sp,
      fontWeight: FontWeight.w700,
      color: const Color(0xFF3F4A4A),
      letterSpacing: 0.2,
      height: 1.2,
    );
    final filenameStyle = GoogleFonts.spaceGrotesk(
      fontSize: 11.sp,
      fontWeight: FontWeight.w600,
      color: const Color(0xFF6D7979),
      letterSpacing: 0.4,
      height: 1.2,
    );
    final qtyStyle = GoogleFonts.spaceGrotesk(
      fontSize: 26.sp,
      fontWeight: FontWeight.w800,
      color: AppColors.primary,
      height: 1.2,
    );
    final overrideStyle = GoogleFonts.spaceGrotesk(
      fontSize: 10.sp,
      fontWeight: FontWeight.w800,
      color: const Color(0xFFBF2E2E),
      letterSpacing: 1.5,
      height: 1.2,
    );

    return Material(
      color: const Color(0xFFECECEC),
      borderRadius: BorderRadius.zero,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Expanded(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.baseline,
                    textBaseline: TextBaseline.alphabetic,
                    children: [
                      Expanded(
                        child: Text(
                          activity.isEmpty ? 'COUNT' : activity,
                          style: activityStyle,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      if (overrideCatalog) ...[
                        SizedBox(width: 8.w),
                        Text('OVERRIDE', style: overrideStyle),
                      ],
                    ],
                  ),
                  SizedBox(height: 3.h),
                  Text(
                    whoLine,
                    style: whoStyle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  SizedBox(height: 2.h),
                  Text(
                    dateText,
                    style: dateStyle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  if (filename.isNotEmpty) ...[
                    SizedBox(height: 2.h),
                    Text(
                      filename,
                      style: filenameStyle,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ],
              ),
            ),
            SizedBox(width: 4.w),
            Padding(
              padding: const EdgeInsets.only(left: 6, right: 12),
              child: Text('x$rowCount', style: qtyStyle),
            ),
          ],
        ),
      ),
    );
  }
}
