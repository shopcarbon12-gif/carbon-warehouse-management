import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';

import 'package:flutter/services.dart' show HapticFeedback;
import 'package:shared_preferences/shared_preferences.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/hardware/rfid_tag_read.dart';
import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/add_on_session_realtime.dart';
import 'package:carbon_wms/services/add_on_session_state.dart';
import 'package:carbon_wms/services/epc/epc_codec.dart';
import 'package:carbon_wms/services/mobile_settings_repository.dart';
import 'package:carbon_wms/services/scan_sounds.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/add_on_count_settings_screen.dart';
import 'package:carbon_wms/ui/screens/add_on_count_review_screen.dart';
import 'package:carbon_wms/ui/widgets/add_on_epc_card.dart';
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
  StreamSubscription<RfidTagRead>? _directTagSub;
  StreamSubscription<String>? _barcodeSub;
  StreamSubscription<AddOnRealtimeEvent>? _sseSub;
  StreamSubscription<String>? _triggerSub;
  Timer? _heartbeat;
  String? _previousScanContext;
  bool _scannerReady = false;

  @override
  void initState() {
    super.initState();
    // RFID-only screen: we deliberately don't subscribe to the camera
    // wedge / 2D-barcode broadcast streams here. Add-On Count surfaces
    // surprise EPCs read by the UHF radio — barcode scans (1D/2D) would
    // pollute the new-EPC list and aren't part of this flow. The single
    // listener below is `rfid.visibleEpcs`, which is the EPC-only stream
    // emitted by `_handleTagRead` after the UHF radio decodes a tag.
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

    // Route the physical trigger to RFID + subscribe to trigger-down events
    // so a trigger pull toggles start/pause (Q18 lock). Mirrors the working
    // pattern from count_inventory_screen.dart:_ensureScannerReady — without
    // this the screen has no way for the operator to scan via hardware
    // trigger; only the on-screen START button works.
    unawaited(_ensureScannerReady());
  }

  /// Put the device in RFID-trigger mode and bind the hardware trigger to
  /// [_toggleScanning]. We deliberately keep tag ingest on
  /// `RfidManager.visibleEpcs` (rather than switching to the raw
  /// vendor stream the way Count Inventory does) so the manager's
  /// dedup + RSSI logic still applies and we don't duplicate ingest paths.
  Future<void> _ensureScannerReady() async {
    if (_scannerReady) return;
    final rfid = context.read<RfidManager>();
    _previousScanContext ??= rfid.scanContext;
    rfid.scanContext = 'ADD-ON COUNT';

    // Mirror Count Inventory: silence the 2D laser + relay so a trigger
    // pull goes straight to the UHF radio. setZebraTriggerModeRfid is the
    // RFD8500-side analogue of Chainway's enableRfidFunctionMode broadcast.
    try {
      await RfidVendorChannel.scannerDisableTriggerRelay();
      await RfidVendorChannel.close2dBarcode();
      await RfidVendorChannel.enableRfidFunctionMode();
      await RfidVendorChannel.setZebraTriggerModeRfid();
    } catch (_) {/* best-effort — channel may no-op when sled not connected */}

    _triggerSub = RfidVendorChannel.hardwareTriggerStream().listen((event) {
      // Q18 contract: single trigger press toggles start/pause. 'down' is
      // press; we ignore 'up' so a held trigger doesn't keep retoggling.
      if (event == 'down') {
        unawaited(_toggleScanning());
      }
    }, onError: (_) {});

    // Subscribe directly to the native tag-read stream — same path Count
    // Inventory uses. The RfidManager's `visibleEpcs` requires `_active`
    // to be a connected scanner instance, which isn't always wired up by
    // the time the Add-On screen mounts; the vendor channel emits raw
    // tags from the native bridge regardless of manager state and never
    // misses reads. The `_session.scanning` flag inside `_onEpc` gates
    // ingest so tags read between START and STOP are processed.
    _directTagSub = RfidVendorChannel.tagReadStream().listen(
      (tag) => _onEpc(tag.epcHex24),
      onError: (_) {},
    );
    // Some rugged handhelds (Chainway broadcast-only mode) emit UHF EPCs
    // on the hardware_barcode channel instead. Mirror Count Inventory's
    // _barcodeSub so we don't miss reads on those devices. Dedup in
    // `_session.shouldSubmit` makes double-reads safe.
    _barcodeSub = RfidVendorChannel.hardwareBarcodeStream().listen((raw) {
      final compact = raw.trim().toUpperCase().replaceAll(RegExp(r'\s+'), '');
      if (compact.isEmpty) return;
      final match = RegExp(r'([0-9A-F]{24})').firstMatch(compact);
      final epc = match?.group(1);
      if (epc != null) _onEpc(epc);
    }, onError: (_) {});

    // Silence the auto per-tag beep fired by the native RFID controllers
    // (CarbonZebraRfidController.emitTag → ScanSoundPool.playTagBeep) for
    // the duration of this screen. We drive the beep manually in _onEpc
    // so the operator only hears a tone when a tag genuinely makes it
    // past the in-source / formula filters and is added as a NEW EPC.
    // Restored in dispose so Count Inventory / Locate / etc. still beep.
    unawaited(ScanSounds.instance.setTagBeepSuppressed(true));

    _scannerReady = true;
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
      // Stop side: stop the radio first, then drop the gate. Order
      // matters because the visibleEpcs stream can flush late tags
      // between stop and the listener being torn down — we still
      // _session.scanning-gate them in _onEpc so they go nowhere.
      try {
        await rfid.stopLocateScanning();
      } catch (_) {/* ignore — best-effort stop */}
      _session.setScanning(false);
      ScanSounds.instance.play(ScanCue.stop);
    } else {
      // Start side: tag stream is already subscribed in
      // _ensureScannerReady (always-on, gated by _session.scanning), so
      // here we just flip the gate and fire the radio. Both Zebra
      // (startInventoryFlutterResult) and Chainway paths terminate on
      // startScanning under the manager.
      _session.setScanning(true);
      ScanSounds.instance.play(ScanCue.start);
      try {
        await rfid.startLocateScanning();
      } catch (_) {/* radio may be unconnected — tag stream stays cold */}
    }
  }

  Future<void> _onEpc(String epc) async {
    if (!_session.scanning) return;
    final clean = epc.replaceAll(RegExp(r'\s+'), '').toUpperCase();
    if (clean.length != 24) return;

    // Note: _session.shouldSubmit returns false for any EPC already in the
    // chosen source list (silent skip per Q16) AND for any EPC we already
    // submitted this session — so anything reaching past this line is
    // unambiguously a NEW-to-session, not-in-source tag.
    if (!_session.shouldSubmit(clean)) return;

    final api = context.read<WmsApiClient>();

    // Carbon EPC formula gate. Defective tags (wrong prefix, bad hex,
    // wrong length already filtered above) go in their own bucket — they
    // are NOT shown in the main "new EPCs" list and do NOT beep. We still
    // POST them with validationFailed=true so the server captures them
    // in add_on_sessions.failed_ledger; scan-finalize then emits them as
    // a separate "Defective" sheet on SAVE and through the defective-CSV
    // pipeline on UPLOAD.
    final cfg = context.read<MobileSettingsRepository>().epcConfig;
    final decoded = decodeEpc(clean, cfg);
    if (!decoded.valid) {
      final reason = decoded.reason?.name ?? 'invalid';
      _session.recordFailed(FailedEpcEntry(
        epc: clean,
        reason: reason,
        scannedAtUtc: DateTime.now().toUtc(),
      ));
      try {
        await api.submitAddOnSessionEpc(
          sessionId: widget.sessionId,
          epc: clean,
          inSource: false,
          validationFailed: true,
          failureReason: reason,
        );
      } catch (_) {/* best-effort — server reconciles on retry */}
      return; // no display, no beep
    }

    try {
      final result = await api.submitAddOnSessionEpc(
        sessionId: widget.sessionId,
        epc: clean,
        inSource: false,
      );
      final outcome = result['outcome'] as String?;
      if (outcome == 'new') {
        // Decode is already done above (formula check passed → valid =
        // true), so reuse decoded.systemId. This is the ONLY enrichment
        // that happens during scan — no catalog network call, no
        // /epc/lookup, nothing. system_id displays on the card so the
        // operator can identify the item without any round-trip. Full
        // catalog resolution (SKU, name, color, size) happens
        // server-side during UPLOAD intent only.
        _session.recordNew(NewEpcEntry(
          epc: clean,
          scannedAtUtc: DateTime.now().toUtc(),
          systemId: decoded.systemId?.toString(),
        ));
        // Regular per-tag read tone (uhf-read-tag.mp3), not the heavier
        // success cue.
        ScanSounds.instance.play(ScanCue.read);
        await _maybeVibrate();
      }
      // 'duplicate' / 'failed' / server-side-inSource → silent (Q16 + spec).
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
          failedEntries: _session.failedEntries,
        ),
      ),
    );
  }

  @override
  void dispose() {
    _heartbeat?.cancel();
    _sseSub?.cancel();
    unawaited(_sse?.dispose() ?? Future<void>.value());
    _directTagSub?.cancel();
    _barcodeSub?.cancel();
    _triggerSub?.cancel();
    // Re-enable the auto per-tag beep for other screens.
    unawaited(ScanSounds.instance.setTagBeepSuppressed(false));
    // Restore the prior scan context so screens we pop back to see the
    // value they had when they pushed us. We can't safely `context.read`
    // here (the element may already be detached), but the manager is a
    // singleton-per-app provider and grabbing it via the captured
    // reference at init time is the established pattern in CountInventory.
    final prev = _previousScanContext;
    if (prev != null) {
      try {
        // RfidManager is a top-level Provider; reading via context here is
        // a no-op if the tree is gone, which is fine for restore.
        // ignore: use_build_context_synchronously
        context.read<RfidManager>().scanContext = prev;
      } catch (_) {/* tree already detached */}
    }
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
              builder: (_, __) => _CounterRow(
                newCount: _session.newCount,
                defectiveCount: _session.failedCount,
              ),
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

class _CounterRow extends StatelessWidget {
  const _CounterRow({required this.newCount, required this.defectiveCount});
  final int newCount;
  final int defectiveCount;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(12.w, 16.h, 12.w, 12.h),
      child: Row(
        children: [
          Expanded(
            child: _CounterTile(
              count: newCount,
              label: 'NEW',
              accent: AppColors.primary,
            ),
          ),
          SizedBox(width: 12.w),
          Expanded(
            child: _CounterTile(
              count: defectiveCount,
              label: 'DEFECTIVE',
              accent: const Color(0xFFD9534F),
            ),
          ),
        ],
      ),
    );
  }
}

class _CounterTile extends StatelessWidget {
  const _CounterTile({
    required this.count,
    required this.label,
    required this.accent,
  });
  final int count;
  final String label;
  final Color accent;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: EdgeInsets.symmetric(vertical: 14.h, horizontal: 8.w),
      decoration: BoxDecoration(
        color: Colors.white,
        border: Border.all(color: accent),
        borderRadius: BorderRadius.circular(2.r),
      ),
      child: Column(
        children: [
          Text(
            '$count',
            style: GoogleFonts.spaceGrotesk(
              fontSize: 56.sp,
              fontWeight: FontWeight.w900,
              color: accent,
              height: 1.0,
            ),
          ),
          SizedBox(height: 4.h),
          Text(
            label,
            style: GoogleFonts.spaceGrotesk(
              fontSize: 11.sp,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.2,
              color: accent,
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
    // One container per EPC. No grouping by SKU, no qty counter — each tag is
    // its own row so the operator sees every individual surprise.
    return ListView.separated(
      padding: EdgeInsets.symmetric(horizontal: 12.w, vertical: 8.h),
      itemCount: entries.length,
      separatorBuilder: (_, __) => SizedBox(height: 8.h),
      itemBuilder: (_, i) => AddOnEpcCard(entry: entries[i]),
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
