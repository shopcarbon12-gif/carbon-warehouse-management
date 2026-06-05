import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/report_csv_export.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Transfer slip report — read-only history of transfer slips for a direction
/// ('out' = sent, 'in' = received). Mirrors the desktop Reports → Transfers
/// list. `by` columns render as "First L." (server-formatted).
class TransferReportListScreen extends StatefulWidget {
  const TransferReportListScreen({
    super.key,
    required this.direction,
    required this.title,
  });
  final String direction; // 'out' | 'in'
  final String title;

  @override
  State<TransferReportListScreen> createState() =>
      _TransferReportListScreenState();
}

class _TransferReportListScreenState extends State<TransferReportListScreen> {
  static const Color _ink = Color(0xFF171D1D);
  static const Color _slate = Color(0xFF3F4A4A);
  static const Color _muted = Color(0xFF8A9090);
  static const Color _transit = Color(0xFFE08A2C);
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
      final rows = await context
          .read<WmsApiClient>()
          .fetchTransferReport(direction: widget.direction);
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

  String _fmtDate(String iso) {
    final dt = DateTime.tryParse(iso)?.toLocal();
    if (dt == null) return iso;
    String two(int n) => n.toString().padLeft(2, '0');
    return '${dt.year}-${two(dt.month)}-${two(dt.day)}';
  }

  ({Color bg, Color fg, String text}) _statePill(String s) {
    switch (s) {
      case 'received':
        return (bg: const Color(0x142A8E2A), fg: const Color(0xFF2A8E2A), text: 'RECEIVED');
      case 'partially_received':
        return (bg: const Color(0x141B7D7D), fg: _primary, text: 'PARTIAL');
      case 'cancelled':
        return (bg: const Color(0x14D9534F), fg: const Color(0xFFD9534F), text: 'CANCELLED');
      default:
        return (bg: const Color(0x14E08A2C), fg: _transit, text: 'IN TRANSIT');
    }
  }

  Future<void> _export() async {
    final inbound = widget.direction == 'in';
    await exportReportCsv(
      context,
      header: [
        'slip',
        'state',
        'from',
        'to',
        'rfid',
        'manual',
        'sent',
        'received',
        'missing',
        inbound ? 'received_at' : 'created_at',
        inbound ? 'received_by' : 'created_by',
      ],
      rows: _rows.map((r) {
        return [
          (r['slip_number'] ?? '').toString(),
          (r['state'] ?? '').toString(),
          (r['source_location_name'] ?? '').toString(),
          (r['destination_location_name'] ?? '').toString(),
          (r['rfid_count'] ?? '').toString(),
          (r['manual_count'] ?? '').toString(),
          (r['sent_qty'] ?? '').toString(),
          (r['received_qty'] ?? '').toString(),
          (r['missing_qty'] ?? '').toString(),
          ((inbound ? r['received_at'] : r['created_at']) ?? '').toString(),
          ((inbound ? r['received_by_name'] : r['created_by_name']) ?? '')
              .toString(),
        ];
      }).toList(),
      filename: inbound ? 'transfer-in' : 'transfer-out',
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
                      ? _centered('No transfer slips yet.', _muted)
                      : ListView.separated(
                          physics: const AlwaysScrollableScrollPhysics(),
                          padding: EdgeInsets.fromLTRB(16.w, 12.h, 16.w, 24.h),
                          itemCount: _rows.length,
                          separatorBuilder: (_, __) => SizedBox(height: 10.h),
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
            child: Text(msg,
                style: GoogleFonts.manrope(
                    fontSize: 14.sp,
                    fontWeight: FontWeight.w600,
                    color: color)),
          ),
        ],
      );

  Widget _card(Map<String, dynamic> r) {
    final inbound = widget.direction == 'in';
    final slip = (r['slip_number']?.toString() ?? '—');
    final state = (r['state'] ?? '').toString();
    final pill = _statePill(state);
    final from = (r['source_location_name'] ?? '').toString();
    final to = (r['destination_location_name'] ?? '').toString();
    final sent = (r['sent_qty'] as num?)?.toInt() ?? 0;
    final recv = (r['received_qty'] as num?)?.toInt() ?? 0;
    final missing = (r['missing_qty'] as num?)?.toInt() ?? 0;
    final by = inbound
        ? (r['received_by_name'] ?? '').toString()
        : (r['created_by_name'] ?? '').toString();
    final whenIso =
        inbound ? (r['received_at'] ?? '').toString() : (r['created_at'] ?? '').toString();
    final when = whenIso.isEmpty ? '' : _fmtDate(whenIso);

    return Container(
      decoration: const BoxDecoration(
        color: Colors.white,
        border: Border(
            left: BorderSide(color: AppColors.primary, width: 4)),
      ),
      padding: EdgeInsets.fromLTRB(13.w, 12.h, 13.w, 12.h),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text('SLIP #$slip',
                  style: GoogleFonts.spaceGrotesk(
                      fontSize: 16.sp, fontWeight: FontWeight.w800, color: _ink)),
              const Spacer(),
              Container(
                padding: EdgeInsets.symmetric(horizontal: 8.w, vertical: 3.h),
                color: pill.bg,
                child: Text(pill.text,
                    style: GoogleFonts.spaceGrotesk(
                        fontSize: 9.sp,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 0.8,
                        color: pill.fg)),
              ),
            ],
          ),
          SizedBox(height: 6.h),
          Row(
            children: [
              Flexible(
                child: Text(from.toUpperCase(),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: GoogleFonts.spaceGrotesk(
                        fontSize: 12.sp,
                        fontWeight: FontWeight.w700,
                        color: _slate)),
              ),
              Padding(
                padding: EdgeInsets.symmetric(horizontal: 6.w),
                child: Icon(LucideIcons.arrowRight, size: 14.sp, color: _muted),
              ),
              Flexible(
                child: Text(to.toUpperCase(),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: GoogleFonts.spaceGrotesk(
                        fontSize: 12.sp,
                        fontWeight: FontWeight.w700,
                        color: _slate)),
              ),
            ],
          ),
          SizedBox(height: 6.h),
          Text(
            'Sent $sent · Received $recv${missing > 0 ? " · Missing $missing" : ""}'
            '${when.isEmpty ? "" : "  ·  $when"}${by.isEmpty ? "" : "  ·  $by"}',
            style: GoogleFonts.manrope(
                fontSize: 12.5.sp, fontWeight: FontWeight.w600, color: _muted),
          ),
        ],
      ),
    );
  }
}

/// Outgoing transfer report tile entry point.
class TransferOutReportsScreen extends StatelessWidget {
  const TransferOutReportsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const TransferReportListScreen(
        direction: 'out', title: 'TRANSFER OUT · SENT');
  }
}
