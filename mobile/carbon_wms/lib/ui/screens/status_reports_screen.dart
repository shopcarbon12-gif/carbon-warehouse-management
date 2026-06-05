import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/report_csv_export.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Status Change report — read-only mirror of the STATUS_CHANGE audit trail
/// (the same rows the desktop sees). Damages reuses this with [damagedOnly].
class StatusChangeReportView extends StatefulWidget {
  const StatusChangeReportView({
    super.key,
    required this.title,
    this.damagedOnly = false,
  });
  final String title;
  final bool damagedOnly;

  @override
  State<StatusChangeReportView> createState() => _StatusChangeReportViewState();
}

class _StatusChangeReportViewState extends State<StatusChangeReportView> {
  static const Color _ink = Color(0xFF171D1D);
  static const Color _slate = Color(0xFF3F4A4A);
  static const Color _muted = Color(0xFF8A9090);
  static const Color _card = Color(0xFFECECEC);

  bool _loading = false;
  String? _error;
  List<Map<String, dynamic>> _rows = [];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    if (_loading) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final rows = await context
          .read<WmsApiClient>()
          .fetchStatusChangeReport(damagedOnly: widget.damagedOnly);
      if (!mounted) return;
      setState(() {
        _rows = rows;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = 'Could not load: $e';
      });
    }
  }

  Color _statusColor(String s) {
    switch (s.toLowerCase()) {
      case 'in-stock':
        return const Color(0xFF2A8E2A);
      case 'damaged':
        return const Color(0xFFE08A2C);
      case 'tag_killed':
      case 'stolen':
        return const Color(0xFFD9534F);
      case 'sold':
        return const Color(0xFF1B7D7D);
      default:
        return _slate;
    }
  }

  String _fmtWhen(String iso) {
    final dt = DateTime.tryParse(iso)?.toLocal();
    if (dt == null) return iso;
    String two(int n) => n.toString().padLeft(2, '0');
    return '${dt.year}-${two(dt.month)}-${two(dt.day)}  ${two(dt.hour)}:${two(dt.minute)}';
  }

  static const List<String> _csvHeader = [
    'epc',
    'old_status',
    'new_status',
    'reason',
    'changed_at',
    'changed_by',
  ];

  static List<String> _csvRow(Map<String, dynamic> r) => [
        (r['epc'] ?? '').toString(),
        (r['old_status'] ?? '').toString(),
        (r['new_status'] ?? '').toString(),
        (r['reason'] ?? '').toString(),
        (r['changed_at'] ?? '').toString(),
        (r['changed_by'] ?? '').toString(),
      ];

  Future<void> _export() async {
    await exportReportCsv(
      context,
      header: _csvHeader,
      rows: _rows.map(_csvRow).toList(),
      filename: widget.damagedOnly ? 'damages' : 'status-changes',
    );
  }

  /// Group status changes into sessions: same user, consecutive changes within
  /// a 30-minute gap. Newest first. One report row per session, each with its
  /// own download icon (operator request 2026-06-05).
  List<_StatusSession> _sessions() {
    DateTime? ts(Map<String, dynamic> r) =>
        DateTime.tryParse((r['changed_at'] ?? '').toString());
    final rows = [..._rows]..sort((a, b) {
        final ta = ts(a);
        final tb = ts(b);
        if (ta == null && tb == null) return 0;
        if (ta == null) return 1;
        if (tb == null) return -1;
        return tb.compareTo(ta);
      });
    final out = <_StatusSession>[];
    String? prevUser;
    DateTime? prevTs;
    for (final r in rows) {
      final user = (r['changed_by'] ?? '').toString();
      final t = ts(r);
      final cont = out.isNotEmpty &&
          user == prevUser &&
          prevTs != null &&
          t != null &&
          prevTs.difference(t).inMinutes.abs() <= 30;
      if (cont) {
        out.last.events.add(r);
      } else {
        out.add(_StatusSession(user: user, events: [r]));
      }
      prevUser = user;
      prevTs = t;
    }
    return out;
  }

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      pageTitle: widget.title,
      actions: [
        IconButton(
          tooltip: 'Export CSV',
          onPressed: _rows.isEmpty ? null : _export,
          icon: Icon(LucideIcons.download, size: 20.sp, color: AppColors.primary),
        ),
        IconButton(
          tooltip: 'Refresh',
          onPressed: _loading ? null : _load,
          icon: Icon(LucideIcons.refreshCw,
              size: 20.sp, color: AppColors.primary),
        ),
      ],
      body: ColoredBox(
        color: const Color(0xFFF5F7F7),
        child: RefreshIndicator(
          color: AppColors.primary,
          onRefresh: _load,
          child: _loading && _rows.isEmpty
              ? const Center(
                  child: CircularProgressIndicator(color: AppColors.primary))
              : _error != null
                  ? _centered(_error!, const Color(0xFFD9534F))
                  : _rows.isEmpty
                      ? _centered(
                          widget.damagedOnly
                              ? 'No damaged-item changes yet.'
                              : 'No status changes yet.',
                          _muted)
                      : Builder(builder: (_) {
                          final sessions = _sessions();
                          return ListView.separated(
                            physics: const AlwaysScrollableScrollPhysics(),
                            padding:
                                EdgeInsets.fromLTRB(16.w, 12.h, 16.w, 24.h),
                            itemCount: sessions.length,
                            separatorBuilder: (_, __) => SizedBox(height: 10.h),
                            itemBuilder: (_, i) => _StatusSessionCard(
                              session: sessions[i],
                              csvHeader: _csvHeader,
                              csvRow: _csvRow,
                              eventBuilder: _row,
                            ),
                          );
                        }),
        ),
      ),
    );
  }

  Widget _centered(String msg, Color color) => ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          SizedBox(height: 140.h),
          Center(
            child: Padding(
              padding: EdgeInsets.symmetric(horizontal: 32.w),
              child: Text(msg,
                  textAlign: TextAlign.center,
                  style: GoogleFonts.manrope(
                      fontSize: 14.sp,
                      fontWeight: FontWeight.w600,
                      color: color)),
            ),
          ),
        ],
      );

  Widget _row(Map<String, dynamic> r) {
    final epc = (r['epc'] ?? '').toString();
    final oldS = (r['old_status'] ?? '').toString();
    final newS = (r['new_status'] ?? '').toString();
    final reason = (r['reason'] ?? '').toString();
    final by = (r['changed_by'] ?? '').toString();
    final when = _fmtWhen((r['changed_at'] ?? '').toString());
    return Container(
      color: _card,
      padding: EdgeInsets.symmetric(horizontal: 13.w, vertical: 12.h),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(epc,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: GoogleFonts.robotoMono(
                  fontSize: 14.sp, fontWeight: FontWeight.w700, color: _ink)),
          SizedBox(height: 6.h),
          Row(
            children: [
              if (oldS.isNotEmpty) ...[
                _chip(oldS, _statusColor(oldS)),
                Padding(
                  padding: EdgeInsets.symmetric(horizontal: 6.w),
                  child:
                      Icon(LucideIcons.arrowRight, size: 14.sp, color: _muted),
                ),
              ],
              _chip(newS, _statusColor(newS)),
            ],
          ),
          SizedBox(height: 7.h),
          Text(
            '${reason.isEmpty ? "" : "$reason  ·  "}$when${by.isEmpty ? "" : "  ·  $by"}',
            style: GoogleFonts.manrope(
                fontSize: 12.5.sp, fontWeight: FontWeight.w600, color: _slate),
          ),
        ],
      ),
    );
  }

  Widget _chip(String s, Color c) => Container(
        padding: EdgeInsets.symmetric(horizontal: 8.w, vertical: 3.h),
        color: Colors.white,
        child: Text(
          s.toUpperCase().replaceAll('_', ' '),
          style: GoogleFonts.spaceGrotesk(
              fontSize: 11.sp,
              fontWeight: FontWeight.w800,
              letterSpacing: 0.5,
              color: c),
        ),
      );
}

/// One status-change work session — same user, events clustered within 30 min.
class _StatusSession {
  _StatusSession({required this.user, required this.events});
  final String user;
  final List<Map<String, dynamic>> events;
}

/// Session row: date · time-range · user · count, with its own download icon
/// (exports just this session's changes). Tap to expand the individual rows.
class _StatusSessionCard extends StatefulWidget {
  const _StatusSessionCard({
    required this.session,
    required this.csvHeader,
    required this.csvRow,
    required this.eventBuilder,
  });
  final _StatusSession session;
  final List<String> csvHeader;
  final List<String> Function(Map<String, dynamic>) csvRow;
  final Widget Function(Map<String, dynamic>) eventBuilder;

  @override
  State<_StatusSessionCard> createState() => _StatusSessionCardState();
}

class _StatusSessionCardState extends State<_StatusSessionCard> {
  bool _expanded = false;

  DateTime? _ts(Map<String, dynamic> r) =>
      DateTime.tryParse((r['changed_at'] ?? '').toString());

  @override
  Widget build(BuildContext context) {
    final s = widget.session;
    final times = s.events
        .map(_ts)
        .whereType<DateTime>()
        .map((d) => d.toLocal())
        .toList()
      ..sort();
    final start = times.isNotEmpty ? times.first : null;
    final end = times.isNotEmpty ? times.last : null;
    final total = s.events.length;
    String two(int n) => n.toString().padLeft(2, '0');
    String fmtDate(DateTime d) => '${d.year}-${two(d.month)}-${two(d.day)}';
    String fmtTime(DateTime d) => '${two(d.hour)}:${two(d.minute)}';
    final dateLabel = end != null ? fmtDate(end) : '—';
    final timeLabel = (start != null && end != null)
        ? (fmtTime(start) == fmtTime(end)
            ? fmtTime(start)
            : '${fmtTime(start)}–${fmtTime(end)}')
        : '';
    final stamp = end != null
        ? '${fmtDate(end)}_${two(end.hour)}${two(end.minute)}'
        : 'session';
    final userFile = s.user.replaceAll(RegExp(r'[^A-Za-z0-9_-]'), '');

    return Material(
      color: const Color(0xFFECECEC),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          InkWell(
            onTap: () => setState(() => _expanded = !_expanded),
            child: Padding(
              padding: EdgeInsets.fromLTRB(12.w, 10.h, 6.w, 10.h),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '$dateLabel${timeLabel.isEmpty ? '' : '  ·  $timeLabel'}',
                          style: GoogleFonts.spaceGrotesk(
                              fontSize: 14.sp,
                              fontWeight: FontWeight.w800,
                              color: const Color(0xFF171D1D)),
                        ),
                        SizedBox(height: 3.h),
                        Text(
                          '${s.user.isEmpty ? '—' : s.user}  ·  $total change${total == 1 ? '' : 's'}',
                          style: GoogleFonts.manrope(
                              fontSize: 12.sp,
                              fontWeight: FontWeight.w700,
                              color: const Color(0xFF6D7979)),
                        ),
                      ],
                    ),
                  ),
                  ReportRowDownloadButton(
                    header: widget.csvHeader,
                    rows: s.events.map(widget.csvRow).toList(),
                    filename:
                        'status-${userFile.isEmpty ? 'session' : userFile}-$stamp',
                  ),
                  Icon(_expanded ? Icons.expand_less : Icons.expand_more,
                      size: 20.sp, color: const Color(0xFF6D7979)),
                ],
              ),
            ),
          ),
          if (_expanded)
            Padding(
              padding: EdgeInsets.fromLTRB(8.w, 0, 8.w, 8.h),
              child: Column(
                children: [
                  for (final e in s.events)
                    Padding(
                      padding: EdgeInsets.only(top: 6.h),
                      child: widget.eventBuilder(e),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

/// Status Change report tile entry point.
class StatusReportsScreen extends StatelessWidget {
  const StatusReportsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const StatusChangeReportView(title: 'STATUS CHANGE');
  }
}
