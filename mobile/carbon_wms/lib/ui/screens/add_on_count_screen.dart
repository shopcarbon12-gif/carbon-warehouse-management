import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';

import 'package:flutter/services.dart' show HapticFeedback;
import 'package:shared_preferences/shared_preferences.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/add_on_session_realtime.dart';
import 'package:carbon_wms/services/add_on_session_state.dart';
import 'package:carbon_wms/services/scan_sounds.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/add_on_count_settings_screen.dart';
import 'package:carbon_wms/ui/screens/add_on_count_review_screen.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart' show CarbonScaffold;

/// Add-On Count scan screen.
///
/// Trigger contract (Q18 lock): trigger toggles start/pause. Single click
/// to start, single click again to pause/stop. No hold-to-scan.
///
/// Server-mediated dedup is the source of truth for "new" — every EPC the
/// device hasn't already short-circuited (in source list, in submit cache)
/// is POSTed to /epc and the screen surfaces only outcome=='new'.
class AddOnCountScreen extends StatefulWidget {
  const AddOnCountScreen({
    super.key,
    required this.sessionId,
    required this.sourceType,
    required this.sourceId,
    required this.sourceSlip,
    required this.sourceEpcs,
  });

  final String sessionId;
  final String sourceType;
  final String sourceId;
  final String sourceSlip;
  final List<String> sourceEpcs;

  @override
  State<AddOnCountScreen> createState() => _AddOnCountScreenState();
}

class _AddOnCountScreenState extends State<AddOnCountScreen> {
  late AddOnSessionState _session;
  AddOnSessionRealtime? _sse;
  StreamSubscription<String>? _epcSub;
  StreamSubscription<AddOnRealtimeEvent>? _sseSub;
  Timer? _heartbeat;

  @override
  void initState() {
    super.initState();
    _session = AddOnSessionState(
      sessionId: widget.sessionId,
      sourceType: widget.sourceType,
      sourceId: widget.sourceId,
      sourceSlip: widget.sourceSlip,
      sourceEpcs: widget.sourceEpcs,
    );
    final api = context.read<WmsApiClient>();
    _sse = AddOnSessionRealtime(api: api, sessionId: widget.sessionId);
    _sseSub = _sse!.events.listen(_handleSseEvent);
    unawaited(_sse!.start());

    // 30-second heartbeat — server's Q12 60s disconnect kick + Q13 10min
    // idle cancel both depend on these touches keeping last_activity_at fresh.
    _heartbeat = Timer.periodic(const Duration(seconds: 30), (_) {
      api.touchAddOnSession(widget.sessionId).catchError((Object _) {});
    });
  }

  void _handleSseEvent(AddOnRealtimeEvent event) {
    if (!mounted) return;
    switch (event.type) {
      case 'epc_new':
        // Another device counted an EPC. Mark it locally so we don't re-submit.
        final epc = event.payload['epc'] as String?;
        if (epc != null) _session.recordRemoteDuplicate(epc);
        break;
      case 'join_requested':
        // We're the owner — show approve/decline popup.
        unawaited(_showJoinRequestPopup(event));
        break;
      case 'cancelled':
      case 'completed':
        if (Navigator.of(context).canPop()) Navigator.of(context).pop();
        break;
    }
  }

  Future<void> _showJoinRequestPopup(AddOnRealtimeEvent event) async {
    final requesterUserId = event.payload['requester_user_id'] as String?;
    final requesterDeviceId = event.payload['requester_device_id'] as String?;
    ScanSounds.instance.play(ScanCue.error);
    // Pause scanning while the popup is up — spec contract.
    final wasScanning = _session.scanning;
    if (wasScanning) {
      await context.read<RfidManager>().pauseScanning();
      _session.setScanning(false);
    }
    if (!mounted) return;
    final approved = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        title: const Text('Join request'),
        content: Text(
          '${requesterUserId ?? 'Another operator'} wants to join this session.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('DECLINE'),
          ),
          ElevatedButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('APPROVE'),
          ),
        ],
      ),
    );
    if (!mounted) return;
    final api = context.read<WmsApiClient>();
    try {
      await api.respondJoinAddOnSession(
        sessionId: widget.sessionId,
        approve: approved == true,
        requesterUserId: requesterUserId,
        requesterDeviceId: requesterDeviceId,
      );
      if (approved == true) {
        ScanSounds.instance.play(ScanCue.success);
      }
    } catch (_) {/* best-effort */}
  }

  Future<void> _toggleScanning() async {
    final rfid = context.read<RfidManager>();
    if (_session.scanning) {
      await rfid.pauseScanning();
      _session.setScanning(false);
      ScanSounds.instance.play(ScanCue.stop);
    } else {
      _session.setScanning(true);
      ScanSounds.instance.play(ScanCue.start);
      _epcSub ??= rfid.visibleEpcs.listen(_onEpc);
    }
  }

  Future<void> _onEpc(String epc) async {
    if (!_session.scanning) return;
    final clean = epc.replaceAll(RegExp(r'\s+'), '').toUpperCase();
    if (clean.length != 24) return;

    if (!_session.shouldSubmit(clean)) return;

    final api = context.read<WmsApiClient>();
    final inSource = _session.sourceEpcs.contains(clean);
    try {
      final result = await api.submitAddOnSessionEpc(
        sessionId: widget.sessionId,
        epc: clean,
        inSource: inSource,
      );
      final outcome = result['outcome'] as String?;
      if (outcome == 'new') {
        _session.recordNew(NewEpcEntry(epc: clean, scannedAtUtc: DateTime.now().toUtc()));
        ScanSounds.instance.play(ScanCue.success);
        await _maybeVibrate();
        // Fire-and-forget enrichment so the row gets sku/name/color/size.
        unawaited(_enrichEpc(clean));
      }
      // 'duplicate' / 'failed' / inSource → silent (Q16 + spec).
    } catch (_) {
      // Best-effort — server-mediated dedup will catch up on retries.
    }
  }

  Future<void> _maybeVibrate() async {
    try {
      final p = await SharedPreferences.getInstance();
      final on = p.getBool(AddOnCountSettingsScreen.prefKeyVibrateOnNew) ??
          AddOnCountSettingsScreen.defaultVibrateOnNew;
      if (on) await HapticFeedback.lightImpact();
    } catch (_) {/* best-effort */}
  }

  Future<void> _enrichEpc(String epc) async {
    try {
      final api = context.read<WmsApiClient>();
      final rows = await api.lookupEpcs([epc]);
      if (rows.isEmpty) return;
      final r = rows.first;
      final scannedAt = DateTime.now().toUtc();
      _session.enrichEntry(
        epc,
        NewEpcEntry(
          epc: epc,
          scannedAtUtc: scannedAt,
          systemId: r['systemId'] as String?,
          customSku: r['sku'] as String?,
          itemName: r['productName'] as String?,
          color: r['color'] as String?,
          size: r['size'] as String?,
        ),
      );
    } catch (_) {/* best-effort enrichment */}
  }

  Future<void> _stopAndReview() async {
    if (_session.scanning) {
      await context.read<RfidManager>().pauseScanning();
      _session.setScanning(false);
    }
    if (!mounted) return;
    await Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (_) => AddOnCountReviewScreen(
          sessionId: widget.sessionId,
          sourceType: widget.sourceType,
          sourceId: widget.sourceId,
          sourceSlip: widget.sourceSlip,
          newEntries: _session.newEntries,
        ),
      ),
    );
  }

  @override
  void dispose() {
    _heartbeat?.cancel();
    _sseSub?.cancel();
    unawaited(_sse?.dispose() ?? Future<void>.value());
    _epcSub?.cancel();
    _session.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      pageTitle: 'add-on',
      body: ColoredBox(
        color: Colors.white,
        child: Column(
          children: [
            _Header(slip: widget.sourceSlip, sourceCount: widget.sourceEpcs.length),
            ListenableBuilder(
              listenable: _session,
              builder: (_, __) => _Counter(count: _session.newCount),
            ),
            Expanded(
              child: ListenableBuilder(
                listenable: _session,
                builder: (_, __) => _NewList(entries: _session.newEntries),
              ),
            ),
            ListenableBuilder(
              listenable: _session,
              builder: (_, __) => _ActionBar(
                scanning: _session.scanning,
                onToggle: _toggleScanning,
                onStop: _session.newCount > 0 ? _stopAndReview : null,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.slip, required this.sourceCount});
  final String slip;
  final int sourceCount;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: EdgeInsets.fromLTRB(20.w, 12.h, 20.w, 12.h),
      color: const Color(0xFFF5F8F8),
      child: Text(
        'Source · $slip · $sourceCount EPCs',
        style: GoogleFonts.spaceGrotesk(
          fontSize: 12.sp,
          fontWeight: FontWeight.w700,
          color: AppColors.textMain,
          letterSpacing: 0.6,
        ),
      ),
    );
  }
}

class _Counter extends StatelessWidget {
  const _Counter({required this.count});
  final int count;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.symmetric(vertical: 16.h),
      child: Column(
        children: [
          Text(
            '$count',
            style: GoogleFonts.spaceGrotesk(
              fontSize: 84.sp,
              fontWeight: FontWeight.w900,
              color: AppColors.primary,
              height: 1.0,
            ),
          ),
          Text(
            'NEW EPCS FOUND',
            style: GoogleFonts.spaceGrotesk(
              fontSize: 11.sp,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.2,
              color: AppColors.textMuted,
            ),
          ),
        ],
      ),
    );
  }
}

class _NewList extends StatelessWidget {
  const _NewList({required this.entries});
  final List<NewEpcEntry> entries;

  @override
  Widget build(BuildContext context) {
    if (entries.isEmpty) {
      return Center(
        child: Text(
          'Pull trigger to start scanning',
          style: GoogleFonts.manrope(color: AppColors.textMuted),
        ),
      );
    }
    return ListView.builder(
      padding: EdgeInsets.symmetric(horizontal: 12.w),
      itemCount: entries.length,
      itemBuilder: (_, i) => _NewRow(entry: entries[i]),
    );
  }
}

class _NewRow extends StatelessWidget {
  const _NewRow({required this.entry});
  final NewEpcEntry entry;

  @override
  Widget build(BuildContext context) {
    final title = [entry.customSku, entry.itemName, entry.color, entry.size]
        .where((s) => s != null && s.isNotEmpty)
        .join(' · ');
    return Padding(
      padding: EdgeInsets.symmetric(vertical: 6.h),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (title.isNotEmpty)
            Text(
              title,
              style: GoogleFonts.manrope(
                fontSize: 12.sp,
                fontWeight: FontWeight.w700,
                color: AppColors.textMain,
              ),
            ),
          Text(
            'EPC ${entry.epc}',
            style: GoogleFonts.spaceMono(
              fontSize: 11.sp,
              color: AppColors.textMuted,
            ),
          ),
        ],
      ),
    );
  }
}

class _ActionBar extends StatelessWidget {
  const _ActionBar({required this.scanning, required this.onToggle, required this.onStop});
  final bool scanning;
  final VoidCallback onToggle;
  final VoidCallback? onStop;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(16.w, 8.h, 16.w, 16.h),
      child: Row(
        children: [
          Expanded(
            child: ElevatedButton(
              style: ElevatedButton.styleFrom(
                backgroundColor: scanning ? Colors.redAccent : AppColors.primary,
                padding: EdgeInsets.symmetric(vertical: 16.h),
              ),
              onPressed: onToggle,
              child: Text(
                scanning ? 'PAUSE' : 'START',
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 14.sp,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 1.2,
                  color: Colors.white,
                ),
              ),
            ),
          ),
          SizedBox(width: 12.w),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: AppColors.slateAction,
              padding: EdgeInsets.symmetric(horizontal: 24.w, vertical: 16.h),
            ),
            onPressed: onStop,
            child: Text(
              'REVIEW',
              style: GoogleFonts.spaceGrotesk(
                fontSize: 13.sp,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.2,
                color: Colors.white,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
