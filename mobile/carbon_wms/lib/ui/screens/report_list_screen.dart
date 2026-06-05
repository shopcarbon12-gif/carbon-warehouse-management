import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/report_csv_export.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// One column in a report. [key] reads from the row map; [label] is the CSV
/// header + (optionally) the on-card label.
class ReportCol {
  const ReportCol(this.key, this.label, {this.primary = false});
  final String key;
  final String label;

  /// The primary column is shown big/mono as the card title (e.g. EPC/SKU).
  final bool primary;
}

/// Generic report screen — fetches rows, lists them as cards, and exports the
/// exact columns to CSV (saved to the device + shared). Every report shares
/// this so they all look the same and all export the same way.
class ReportListScreen extends StatefulWidget {
  const ReportListScreen({
    super.key,
    required this.title,
    required this.fetch,
    required this.columns,
    required this.csvName,
    this.emptyText = 'No records yet.',
  });

  final String title;
  final Future<List<Map<String, dynamic>>> Function(WmsApiClient) fetch;
  final List<ReportCol> columns;
  final String csvName;
  final String emptyText;

  @override
  State<ReportListScreen> createState() => _ReportListScreenState();
}

class _ReportListScreenState extends State<ReportListScreen> {
  static const Color _ink = Color(0xFF171D1D);
  static const Color _slate = Color(0xFF3F4A4A);
  static const Color _muted = Color(0xFF8A9090);
  static const Color _primary = AppColors.primary;

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
      final rows = await widget.fetch(context.read<WmsApiClient>());
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

  String _val(Map<String, dynamic> r, String key) {
    final v = r[key];
    if (v == null) return '';
    return v.toString();
  }

  String _fmt(String key, String raw) {
    if (raw.isEmpty) return raw;
    if (key.endsWith('_at') || key == 'created_at' || key == 'received_at') {
      final dt = DateTime.tryParse(raw)?.toLocal();
      if (dt != null) {
        String two(int n) => n.toString().padLeft(2, '0');
        return '${dt.year}-${two(dt.month)}-${two(dt.day)} ${two(dt.hour)}:${two(dt.minute)}';
      }
    }
    return raw;
  }

  Future<void> _export() async {
    final header = widget.columns.map((c) => c.label).toList();
    final rows = _rows
        .map((r) => widget.columns.map((c) => _val(r, c.key)).toList())
        .toList();
    await exportReportCsv(
      context,
      header: header,
      rows: rows,
      filename: widget.csvName,
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
          icon: Icon(LucideIcons.download, size: 20.sp, color: _primary),
        ),
        IconButton(
          tooltip: 'Refresh',
          onPressed: _loading ? null : _load,
          icon: Icon(LucideIcons.refreshCw, size: 20.sp, color: _primary),
        ),
      ],
      body: ColoredBox(
        color: const Color(0xFFF5F7F7),
        child: RefreshIndicator(
          color: _primary,
          onRefresh: _load,
          child: _loading && _rows.isEmpty
              ? const Center(child: CircularProgressIndicator(color: _primary))
              : _error != null
                  ? _centered(_error!, const Color(0xFFD9534F))
                  : _rows.isEmpty
                      ? _centered(widget.emptyText, _muted)
                      : ListView.separated(
                          physics: const AlwaysScrollableScrollPhysics(),
                          padding: EdgeInsets.fromLTRB(16.w, 12.h, 16.w, 24.h),
                          itemCount: _rows.length,
                          separatorBuilder: (_, __) => SizedBox(height: 9.h),
                          itemBuilder: (_, i) => _card(_rows[i]),
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

  Widget _card(Map<String, dynamic> r) {
    final primaryCol = widget.columns.firstWhere(
      (c) => c.primary,
      orElse: () => widget.columns.first,
    );
    final secondary = widget.columns.where((c) => c != primaryCol).toList();
    final header = widget.columns.map((c) => c.label).toList();
    final rowCells = widget.columns.map((c) => _val(r, c.key)).toList();
    final idPart = (r['id'] ?? _val(r, primaryCol.key))
        .toString()
        .replaceAll(RegExp(r'[^A-Za-z0-9_-]'), '')
        .trim();
    return Container(
      color: const Color(0xFFECECEC),
      padding: EdgeInsets.fromLTRB(13.w, 12.h, 6.w, 12.h),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  _fmt(primaryCol.key, _val(r, primaryCol.key)),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: GoogleFonts.robotoMono(
                      fontSize: 15.sp, fontWeight: FontWeight.w700, color: _ink),
                ),
                SizedBox(height: 6.h),
                Wrap(
                  spacing: 14.w,
                  runSpacing: 4.h,
                  children: [
                    for (final c in secondary)
                      if (_val(r, c.key).isNotEmpty)
                        RichText(
                          text: TextSpan(
                            children: [
                              TextSpan(
                                text: '${c.label}: ',
                                style: GoogleFonts.spaceGrotesk(
                                    fontSize: 11.sp,
                                    fontWeight: FontWeight.w800,
                                    letterSpacing: 0.3,
                                    color: _muted),
                              ),
                              TextSpan(
                                text: _fmt(c.key, _val(r, c.key)),
                                style: GoogleFonts.manrope(
                                    fontSize: 12.5.sp,
                                    fontWeight: FontWeight.w700,
                                    color: _slate),
                              ),
                            ],
                          ),
                        ),
                  ],
                ),
              ],
            ),
          ),
          SizedBox(width: 4.w),
          ReportRowDownloadButton(
            header: header,
            rows: [rowCells],
            filename:
                '${widget.csvName}${idPart.isEmpty ? '' : '-$idPart'}',
          ),
        ],
      ),
    );
  }
}
