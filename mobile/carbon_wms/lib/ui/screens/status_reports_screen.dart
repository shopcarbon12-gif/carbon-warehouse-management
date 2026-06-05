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

  Future<void> _export() async {
    await exportReportCsv(
      context,
      header: const [
        'epc',
        'old_status',
        'new_status',
        'reason',
        'changed_at',
        'changed_by',
      ],
      rows: _rows
          .map((r) => [
                (r['epc'] ?? '').toString(),
                (r['old_status'] ?? '').toString(),
                (r['new_status'] ?? '').toString(),
                (r['reason'] ?? '').toString(),
                (r['changed_at'] ?? '').toString(),
                (r['changed_by'] ?? '').toString(),
              ])
          .toList(),
      filename: widget.damagedOnly ? 'damages' : 'status-changes',
    );
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
                      : ListView.separated(
                          physics: const AlwaysScrollableScrollPhysics(),
                          padding:
                              EdgeInsets.fromLTRB(16.w, 12.h, 16.w, 24.h),
                          itemCount: _rows.length,
                          separatorBuilder: (_, __) => SizedBox(height: 9.h),
                          itemBuilder: (_, i) => _row(_rows[i]),
                        ),
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

/// Status Change report tile entry point.
class StatusReportsScreen extends StatelessWidget {
  const StatusReportsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const StatusChangeReportView(title: 'STATUS CHANGE');
  }
}
