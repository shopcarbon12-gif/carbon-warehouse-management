import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/mobile_permissions.dart';
import 'package:carbon_wms/services/transfer_events_client.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/guards/permission_guard.dart';
import 'package:carbon_wms/ui/screens/transfer_in_receive_screen.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Transfer In — pending list. Shows incoming slips for the operator's
/// location (state in-transit / partially_received). Tapping a slip opens
/// the receive workspace where the operator scans EPCs against the
/// expected manifest.
class TransferInPendingScreen extends StatefulWidget {
  const TransferInPendingScreen({super.key});

  @override
  State<TransferInPendingScreen> createState() =>
      _TransferInPendingScreenState();
}

class _TransferInPendingScreenState extends State<TransferInPendingScreen> {
  static const Color _accent = Color(0xFF1B7F4F);
  bool _loading = false;
  String? _error;
  List<Map<String, dynamic>> _rows = const [];

  // Live mirror: a commit / receive at this location (from any device) pushes
  // an event over SSE and we re-pull so the list matches the desktop instantly.
  TransferEventsClient? _events;
  StreamSubscription<Map<String, dynamic>>? _eventsSub;
  bool _live = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      unawaited(_reload());
      _startLiveMirror();
    });
  }

  void _startLiveMirror() {
    final client = TransferEventsClient(context.read<WmsApiClient>());
    _events = client;
    _eventsSub = client.events.listen((_) {
      if (!mounted) return;
      setState(() => _live = true);
      unawaited(_reload());
    });
    unawaited(client.connect());
  }

  @override
  void dispose() {
    _eventsSub?.cancel();
    _events?.dispose();
    super.dispose();
  }

  Future<void> _reload() async {
    if (_loading) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final rows =
          await context.read<WmsApiClient>().fetchPendingIncomingTransfers();
      if (!mounted) return;
      setState(() => _rows = rows);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _openSlip(Map<String, dynamic> row) async {
    final id = (row['id'] ?? '').toString();
    if (id.isEmpty) return;
    await context.pushGuarded<void>(
      ScreenIds.transferInReceive,
      (_) => TransferInReceiveScreen(
        transferId: id,
        slipNumber: row['slip_number'] is int
            ? row['slip_number'] as int
            : int.tryParse('${row['slip_number']}'),
        sourceCode: (row['source_location_code'] ?? '').toString(),
        sourceName: (row['source_location_name'] ?? '').toString(),
      ),
    );
    if (!mounted) return;
    // Re-pull on return so a partial / fully-received slip's pending count
    // updates immediately. /pending naturally drops state='received' rows
    // because the server filters in-transit + partially_received only.
    unawaited(_reload());
  }

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      pageTitle: 'TRANSFER IN',
      actions: [
        Padding(
          padding: EdgeInsets.only(right: 14.w),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 8.w,
                height: 8.w,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: _live ? _accent : const Color(0xFFBCC9C9),
                ),
              ),
              SizedBox(width: 6.w),
              Text(
                'LIVE',
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 10.sp,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 1.4,
                  color: _live ? _accent : const Color(0xFF8A9090),
                ),
              ),
            ],
          ),
        ),
      ],
      bottomBar: SafeArea(
        top: false,
        child: Container(
          color: const Color(0xFFF5F7F7),
          padding: EdgeInsets.fromLTRB(16.w, 8.h, 16.w, 12.h),
          child: SizedBox(
            height: 50.h,
            width: double.infinity,
            child: OutlinedButton.icon(
              onPressed: _loading ? null : _reload,
              style: OutlinedButton.styleFrom(
                backgroundColor: Colors.white,
                foregroundColor: _accent,
                side: BorderSide(color: _accent, width: 1.5),
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(2.r)),
                textStyle: GoogleFonts.spaceGrotesk(
                    fontSize: 15.sp,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 0.8),
              ),
              icon: Icon(LucideIcons.refreshCw, size: 18.sp),
              label: const Text('REFRESH'),
            ),
          ),
        ),
      ),
      body: ColoredBox(
        color: Colors.white,
        child: RefreshIndicator(
          color: _accent,
          onRefresh: _reload,
          child: _buildBody(),
        ),
      ),
    );
  }

  Widget _buildBody() {
    if (_loading && _rows.isEmpty) {
      return const _CenterMsg(text: 'LOADING…');
    }
    if (_error != null) {
      return _CenterMsg(text: 'ERROR\n$_error', color: Colors.redAccent);
    }
    if (_rows.isEmpty) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          SizedBox(height: 120.h),
          Icon(LucideIcons.packageCheck, size: 56.sp, color: _accent),
          SizedBox(height: 16.h),
          Center(
            child: Text(
              'NOTHING TO RECEIVE',
              style: GoogleFonts.spaceGrotesk(
                fontSize: 14.sp,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.8,
                color: AppColors.textMain,
              ),
            ),
          ),
          SizedBox(height: 8.h),
          Center(
            child: Padding(
              padding: EdgeInsets.symmetric(horizontal: 32.w),
              child: Text(
                'No incoming slips for this location.\nPull down to refresh.',
                textAlign: TextAlign.center,
                style: GoogleFonts.manrope(
                  fontSize: 13.sp,
                  color: const Color(0xFF5A6464),
                  height: 1.5,
                ),
              ),
            ),
          ),
        ],
      );
    }
    return ListView.separated(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: EdgeInsets.fromLTRB(16.w, 12.h, 16.w, 24.h),
      itemCount: _rows.length,
      separatorBuilder: (_, __) => SizedBox(height: 10.h),
      itemBuilder: (_, i) => _SlipRow(row: _rows[i], onTap: () => _openSlip(_rows[i])),
    );
  }
}

class _SlipRow extends StatelessWidget {
  const _SlipRow({required this.row, required this.onTap});

  final Map<String, dynamic> row;
  final VoidCallback onTap;

  static const Color _accent = Color(0xFF1B7F4F);
  static const Color _amber = Color(0xFFB87A00);

  @override
  Widget build(BuildContext context) {
    final slipNum = row['slip_number'];
    final state = (row['state'] ?? '').toString();
    final partial = state == 'partially_received';
    final src = (row['source_location_code'] ?? '').toString();
    final srcName = (row['source_location_name'] ?? '').toString();
    final rfidPending = _asInt(row['rfid_pending']);
    final manualPending = _asInt(row['manual_pending']);
    final rfidTotal = _asInt(row['rfid_count']);
    final manualTotal = _asInt(row['manual_count']);
    final pending = rfidPending + manualPending;
    final total = rfidTotal + manualTotal;
    final stateColor = partial ? _amber : _accent;

    return Material(
      color: const Color(0xFFF5F8F8),
      borderRadius: BorderRadius.zero,
      child: InkWell(
        onTap: onTap,
        child: Container(
          decoration: const BoxDecoration(
            border: Border(
              left: BorderSide(color: _accent, width: 5),
            ),
          ),
          padding: EdgeInsets.fromLTRB(16.w, 14.h, 14.w, 14.h),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Text(
                          'SLIP #${slipNum ?? "—"}',
                          style: GoogleFonts.spaceGrotesk(
                            fontSize: 16.sp,
                            fontWeight: FontWeight.w800,
                            letterSpacing: 1.4,
                            color: AppColors.textMain,
                          ),
                        ),
                        SizedBox(width: 10.w),
                        Container(
                          padding: EdgeInsets.symmetric(
                              horizontal: 6.w, vertical: 2.h),
                          color: stateColor.withValues(alpha: 0.12),
                          child: Text(
                            partial ? 'PARTIAL' : 'PENDING',
                            style: GoogleFonts.spaceGrotesk(
                              fontSize: 9.sp,
                              fontWeight: FontWeight.w800,
                              letterSpacing: 1.6,
                              color: stateColor,
                            ),
                          ),
                        ),
                      ],
                    ),
                    SizedBox(height: 4.h),
                    Text(
                      'FROM  $src${srcName.isNotEmpty ? "  ·  $srcName" : ""}',
                      style: GoogleFonts.spaceGrotesk(
                        fontSize: 11.sp,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 1.2,
                        color: const Color(0xFF6D7979),
                      ),
                    ),
                    SizedBox(height: 6.h),
                    Text(
                      '$pending pending  ·  $total expected',
                      style: GoogleFonts.manrope(
                        fontSize: 12.sp,
                        fontWeight: FontWeight.w600,
                        color: const Color(0xFF11181C),
                      ),
                    ),
                  ],
                ),
              ),
              Icon(LucideIcons.chevronRight, size: 22.sp, color: _accent),
            ],
          ),
        ),
      ),
    );
  }

  int _asInt(Object? v) {
    if (v is int) return v;
    if (v is num) return v.toInt();
    if (v is String) return int.tryParse(v) ?? 0;
    return 0;
  }
}

class _CenterMsg extends StatelessWidget {
  const _CenterMsg({required this.text, this.color});
  final String text;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      children: [
        SizedBox(height: 140.h),
        Center(
          child: Text(
            text,
            textAlign: TextAlign.center,
            style: GoogleFonts.spaceGrotesk(
              fontSize: 13.sp,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.6,
              color: color ?? const Color(0xFF6D7979),
            ),
          ),
        ),
      ],
    );
  }
}
