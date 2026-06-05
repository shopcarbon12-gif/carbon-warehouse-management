import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/report_csv_export.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Inventory → Reports → RE-ENCODE.
///
/// Read-only log of every re-encode event the active session location
/// has produced (server-side `encode_events` rows, fetched via
/// `/api/handheld/encode-events`). One row per chip write attempt —
/// `status: ok` for successful writes, `write_failed` / `not_found` /
/// etc. for the failure modes the Re-Encode screen surfaces as a
/// status badge. Old EPC, new EPC, system id, serial, custom SKU,
/// timestamp.
class ReEncodeReportsScreen extends StatefulWidget {
  const ReEncodeReportsScreen({super.key});

  @override
  State<ReEncodeReportsScreen> createState() => _ReEncodeReportsScreenState();
}

class _ReEncodeReportsScreenState extends State<ReEncodeReportsScreen> {
  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _rows = const [];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => unawaited(_load()));
  }

  Future<void> _load() async {
    if (!mounted) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final api = context.read<WmsApiClient>();
      final rows = await api.fetchEncodeEvents(limit: 200);
      if (!mounted) return;
      setState(() {
        _rows = rows;
        _loading = false;
      });
    } on WmsApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = 'HTTP ${e.statusCode}';
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  static const List<String> _csvHeader = [
    'old_epc',
    'new_epc',
    'custom_sku',
    'system_id',
    'serial',
    'status',
    're_encoded_at',
    're_encoded_by',
  ];

  static List<String> _csvRow(Map<String, dynamic> r) => [
        (r['oldEpc'] ?? '').toString(),
        (r['newEpc'] ?? '').toString(),
        (r['customSku'] ?? '').toString(),
        (r['systemId'] ?? '').toString(),
        (r['serial'] ?? '').toString(),
        (r['status'] ?? '').toString(),
        (r['encodedAt'] ?? r['createdAt'] ?? '').toString(),
        (r['by'] ?? '').toString(),
      ];

  Future<void> _export() async {
    await exportReportCsv(
      context,
      header: _csvHeader,
      rows: _rows.map(_csvRow).toList(),
      filename: 're-encode',
    );
  }

  /// Group events into work sessions: same user, consecutive events within a
  /// 30-minute gap. Newest session first. Each session is one report row with
  /// its own download icon (operator request 2026-06-05).
  List<_Session> _sessions() {
    DateTime? ts(Map<String, dynamic> r) =>
        DateTime.tryParse((r['encodedAt'] ?? r['createdAt'] ?? '').toString());
    final rows = [..._rows]..sort((a, b) {
        final ta = ts(a);
        final tb = ts(b);
        if (ta == null && tb == null) return 0;
        if (ta == null) return 1;
        if (tb == null) return -1;
        return tb.compareTo(ta); // newest first
      });
    final out = <_Session>[];
    String? prevUser;
    DateTime? prevTs;
    for (final r in rows) {
      final user = (r['by'] ?? '').toString();
      final t = ts(r);
      final cont = out.isNotEmpty &&
          user == prevUser &&
          prevTs != null &&
          t != null &&
          prevTs.difference(t).inMinutes.abs() <= 30;
      if (cont) {
        out.last.events.add(r);
      } else {
        out.add(_Session(user: user, events: [r]));
      }
      prevUser = user;
      prevTs = t;
    }
    return out;
  }

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      pageTitle: 're-encode',
      actions: [
        IconButton(
          onPressed: _rows.isEmpty ? null : () => unawaited(_export()),
          icon: const Icon(Icons.download),
          tooltip: 'Export CSV',
        ),
        IconButton(
          onPressed: _loading ? null : () => unawaited(_load()),
          icon: const Icon(Icons.refresh),
          tooltip: 'Refresh',
        ),
      ],
      body: ColoredBox(
        color: Colors.white,
        child: RefreshIndicator(
          onRefresh: _load,
          child: _buildBody(),
        ),
      ),
    );
  }

  Widget _buildBody() {
    if (_loading && _rows.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null && _rows.isEmpty) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          Padding(
            padding: EdgeInsets.all(24.r),
            child: Column(
              children: [
                Icon(Icons.error_outline,
                    size: 36.sp, color: const Color(0xFFD9534F)),
                SizedBox(height: 8.h),
                Text(
                  _error!,
                  textAlign: TextAlign.center,
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 13.sp,
                    fontWeight: FontWeight.w700,
                    color: const Color(0xFFD9534F),
                  ),
                ),
                SizedBox(height: 12.h),
                FilledButton(
                  onPressed: () => unawaited(_load()),
                  child: const Text('RETRY'),
                ),
              ],
            ),
          ),
        ],
      );
    }
    if (_rows.isEmpty) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          Padding(
            padding: EdgeInsets.all(40.r),
            child: Center(
              child: Column(
                children: [
                  Icon(Icons.history,
                      size: 48.sp, color: const Color(0xFFBCC9C9)),
                  SizedBox(height: 12.h),
                  Text(
                    'No re-encode events yet',
                    style: GoogleFonts.spaceGrotesk(
                      fontSize: 13.sp,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 1.6,
                      color: const Color(0xFF5A6464),
                    ),
                  ),
                  SizedBox(height: 6.h),
                  Text(
                    'Re-Encode chip writes will appear here.',
                    textAlign: TextAlign.center,
                    style: GoogleFonts.manrope(
                      fontSize: 12.sp,
                      fontWeight: FontWeight.w600,
                      color: const Color(0xFF6D7979),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      );
    }
    final sessions = _sessions();
    return ListView.separated(
      padding: EdgeInsets.fromLTRB(20.w, 12.h, 20.w, 12.h),
      itemCount: sessions.length,
      separatorBuilder: (_, __) => SizedBox(height: 10.h),
      itemBuilder: (_, i) => _SessionCard(
        session: sessions[i],
        csvHeader: _csvHeader,
        csvRow: _csvRow,
      ),
    );
  }
}

/// One work session — same user, events clustered within a 30-minute gap.
class _Session {
  _Session({required this.user, required this.events});
  final String user;
  final List<Map<String, dynamic>> events;
}

/// A session row: date · time-range · user · counts, with its own download
/// icon (exports just this session's events). Tap to expand the events.
class _SessionCard extends StatefulWidget {
  const _SessionCard({
    required this.session,
    required this.csvHeader,
    required this.csvRow,
  });
  final _Session session;
  final List<String> csvHeader;
  final List<String> Function(Map<String, dynamic>) csvRow;

  @override
  State<_SessionCard> createState() => _SessionCardState();
}

class _SessionCardState extends State<_SessionCard> {
  bool _expanded = false;

  DateTime? _ts(Map<String, dynamic> r) =>
      DateTime.tryParse((r['encodedAt'] ?? r['createdAt'] ?? '').toString());

  @override
  Widget build(BuildContext context) {
    final s = widget.session;
    final times = s.events.map(_ts).whereType<DateTime>().map((d) => d.toLocal()).toList()
      ..sort();
    final start = times.isNotEmpty ? times.first : null;
    final end = times.isNotEmpty ? times.last : null;
    final total = s.events.length;
    final ok = s.events
        .where((e) => (e['status'] ?? '').toString().toLowerCase() == 'ok')
        .length;
    final failed = s.events
        .where((e) =>
            (e['status'] ?? '').toString().toLowerCase() == 'write_failed')
        .length;
    String two(int n) => n.toString().padLeft(2, '0');
    String fmtDate(DateTime d) => '${d.year}-${two(d.month)}-${two(d.day)}';
    String fmtTime(DateTime d) => '${two(d.hour)}:${two(d.minute)}';
    final dateLabel = end != null ? fmtDate(end) : '—';
    final timeLabel = (start != null && end != null)
        ? (fmtTime(start) == fmtTime(end)
            ? fmtTime(start)
            : '${fmtTime(start)}–${fmtTime(end)}')
        : '';
    final stamp =
        end != null ? '${fmtDate(end)}_${two(end.hour)}${two(end.minute)}' : 'session';
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
                              color: AppColors.textMain),
                        ),
                        SizedBox(height: 3.h),
                        Text(
                          '${s.user.isEmpty ? '—' : s.user}  ·  $total write${total == 1 ? '' : 's'}  ·  $ok ok${failed > 0 ? '  ·  $failed failed' : ''}',
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
                        're-encode-${userFile.isEmpty ? 'session' : userFile}-$stamp',
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
                      child: _EventCard(row: e),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _EventCard extends StatefulWidget {
  const _EventCard({required this.row});
  final Map<String, dynamic> row;
  @override
  State<_EventCard> createState() => _EventCardState();
}

class _EventCardState extends State<_EventCard> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final row = widget.row;
    final status = (row['status'] as String? ?? 'ok').toLowerCase();
    final sku = row['customSku'] as String?;
    final sysId = row['systemId'] as String?;
    final serial = row['serial'] as String?;
    final oldEpc = row['oldEpc'] as String? ?? '—';
    final newEpc = row['newEpc'] as String? ?? '—';
    final ts = row['encodedAt'] as String? ?? row['createdAt'] as String?;
    final by = (row['by'] as String?) ?? '';
    final tsLocal = _formatTs(ts);

    final summary = <String>[
      if (sku != null && sku.isNotEmpty) 'SKU $sku',
      if (sysId != null && sysId.isNotEmpty) '#$sysId',
      if (serial != null && serial.isNotEmpty) 'SN $serial',
    ].join(' · ');

    final isOk = status == 'ok';
    final accent = isOk
        ? const Color(0xFF16A34A)
        : (status == 'write_failed'
            ? const Color(0xFFDC2626)
            : const Color(0xFFD97706));

    return Material(
      color: const Color(0xFFECECEC),
      borderRadius: BorderRadius.zero,
      child: InkWell(
        onTap: () => setState(() => _expanded = !_expanded),
        child: IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Container(width: 4, color: accent),
              Expanded(
                child: Padding(
                  padding: EdgeInsets.fromLTRB(12.w, 10.h, 12.w, 10.h),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              summary.isEmpty ? newEpc : summary,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: GoogleFonts.manrope(
                                fontSize: 14.sp,
                                fontWeight: FontWeight.w800,
                                color: AppColors.textMain,
                              ),
                            ),
                          ),
                          SizedBox(width: 8.w),
                          Container(
                            padding: EdgeInsets.symmetric(
                                horizontal: 8.w, vertical: 3.h),
                            color: accent,
                            child: Text(
                              status.toUpperCase(),
                              style: GoogleFonts.spaceGrotesk(
                                fontSize: 10.sp,
                                fontWeight: FontWeight.w900,
                                letterSpacing: 1.0,
                                color: Colors.white,
                              ),
                            ),
                          ),
                        ],
                      ),
                      SizedBox(height: 4.h),
                      Text(
                        '$tsLocal${by.isEmpty ? "" : "  ·  $by"}',
                        style: GoogleFonts.spaceGrotesk(
                          fontSize: 11.sp,
                          fontWeight: FontWeight.w700,
                          letterSpacing: 1.0,
                          color: const Color(0xFF6D7979),
                        ),
                      ),
                      if (_expanded) ...[
                        SizedBox(height: 8.h),
                        _kv('OLD', oldEpc),
                        SizedBox(height: 4.h),
                        _kv('NEW', newEpc, accent: true),
                      ],
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _kv(String label, String value, {bool accent = false}) {
    return Row(
      children: [
        SizedBox(
          width: 38.w,
          child: Text(
            label,
            style: GoogleFonts.spaceGrotesk(
              fontSize: 10.sp,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.2,
              color: const Color(0xFF6D7979),
            ),
          ),
        ),
        Expanded(
          child: Text(
            value,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: GoogleFonts.robotoMono(
              fontSize: 12.sp,
              fontWeight: FontWeight.w700,
              color: accent ? AppColors.primary : AppColors.textMain,
            ),
          ),
        ),
      ],
    );
  }

  static String _formatTs(String? iso) {
    if (iso == null || iso.isEmpty) return '—';
    final t = DateTime.tryParse(iso);
    if (t == null) return iso;
    final local = t.toLocal();
    String pad(int v) => v.toString().padLeft(2, '0');
    return '${local.year}-${pad(local.month)}-${pad(local.day)} '
        '${pad(local.hour)}:${pad(local.minute)}';
  }
}
