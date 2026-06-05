import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Bin Clearance report — each clean-bin action (bin · count · time · First L.).
class BinClearanceReportScreen extends StatefulWidget {
  const BinClearanceReportScreen({super.key});

  @override
  State<BinClearanceReportScreen> createState() =>
      _BinClearanceReportScreenState();
}

class _BinClearanceReportScreenState extends State<BinClearanceReportScreen> {
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
      final rows = await context.read<WmsApiClient>().fetchBinClearanceReport();
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

  String _fmtWhen(String iso) {
    final dt = DateTime.tryParse(iso)?.toLocal();
    if (dt == null) return iso;
    String two(int n) => n.toString().padLeft(2, '0');
    return '${dt.year}-${two(dt.month)}-${two(dt.day)}  ${two(dt.hour)}:${two(dt.minute)}';
  }

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      pageTitle: 'BIN CLEARANCE',
      actions: [
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
                      ? _centered('No bins cleared yet.', _muted)
                      : ListView.separated(
                          physics: const AlwaysScrollableScrollPhysics(),
                          padding: EdgeInsets.fromLTRB(16.w, 12.h, 16.w, 24.h),
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
            child: Text(msg,
                style: GoogleFonts.manrope(
                    fontSize: 14.sp, fontWeight: FontWeight.w600, color: color)),
          ),
        ],
      );

  Widget _row(Map<String, dynamic> r) {
    final bin = (r['bin_code'] ?? '').toString();
    final count = (r['epc_count'] as num?)?.toInt() ?? 0;
    final by = (r['cleared_by'] ?? '').toString();
    final when = _fmtWhen((r['cleared_at'] ?? '').toString());
    return Container(
      color: const Color(0xFFECECEC),
      padding: EdgeInsets.symmetric(horizontal: 13.w, vertical: 13.h),
      child: Row(
        children: [
          Icon(LucideIcons.eraser, size: 20.sp, color: _slate),
          SizedBox(width: 12.w),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(bin,
                    style: GoogleFonts.robotoMono(
                        fontSize: 16.sp,
                        fontWeight: FontWeight.w700,
                        color: _ink)),
                SizedBox(height: 4.h),
                Text(
                  '$count cleared  ·  $when${by.isEmpty ? "" : "  ·  $by"}',
                  style: GoogleFonts.manrope(
                      fontSize: 12.5.sp,
                      fontWeight: FontWeight.w600,
                      color: _muted),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
