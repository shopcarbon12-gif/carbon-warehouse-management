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
import 'package:carbon_wms/services/handheld_runtime_config.dart'
    show kAntennaPowerDbmMax;
import 'package:carbon_wms/services/beep_pacer.dart';
import 'package:carbon_wms/services/live_catalog_cache.dart';
import 'package:carbon_wms/services/live_catalog_models.dart';
import 'package:carbon_wms/services/mobile_permissions.dart';
import 'package:carbon_wms/services/mobile_settings_repository.dart';
import 'package:carbon_wms/services/scan_sounds.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/guards/permission_guard.dart';
import 'package:carbon_wms/ui/screens/add_on_count_settings_screen.dart';
import 'package:carbon_wms/ui/screens/add_on_count_review_screen.dart';
import 'package:carbon_wms/ui/widgets/add_on_epc_card.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart' show CarbonScaffold;
import 'package:carbon_wms/ui/widgets/rfid_reading_indicator.dart';
import 'package:carbon_wms/hardware/hardware_trigger.dart';

/// Add-On Count scan screen.
///
/// Trigger contract (Q18 lock): trigger toggles start/pause. Single click
/// to start, single click again to pause/stop. No hold-to-scan.
///
/// "New" is decided on the device: an EPC not in the chosen source and not
/// already counted this session (by us or, via SSE, another device) is
/// counted + beeps at once and is flushed to the server in batches. Item
/// info on each line (SKU, name, colour, size, price, BIN) comes from the
/// phone's live catalog copy ([LiveCatalogCache]) — no per-tag network call.
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
  // Captured in initState: dispose() needs them and must never `context.read`
  // (the element may already be detached by then).
  late final WmsApiClient _api;
  late final RfidManager _rfid;
  late final LiveCatalogCache _catalog;
  late final MobileSettingsRepository _settings;
  AddOnSessionRealtime? _sse;
  StreamSubscription<RfidTagRead>? _directTagSub;
  StreamSubscription<String>? _barcodeSub;
  StreamSubscription<AddOnRealtimeEvent>? _sseSub;
  StreamSubscription<String>? _triggerSub;
  Timer? _heartbeat;
  String? _previousScanContext;
  bool? _previousSuppressEdge;
  bool _scannerReady = false;

  // Every start / stop / pause runs on this chain, one after the other, so a
  // stop always waits for a start still in flight (an RFD8500 start is several
  // Bluetooth round-trips). Before, a second pull mid-start flipped the screen
  // to "paused" while the radio still came up, and the next pull had to be
  // pressed twice.
  Future<void> _radioChain = Future<void>.value();
  DateTime _lastToggleAt = DateTime.fromMillisecondsSinceEpoch(0);
  // Cap on how long one radio call may hold the chain. A wedged Bluetooth
  // link can leave a native call unanswered; without a cap every later
  // toggle (including STOP) would queue behind it forever. Timing out only
  // frees the queue — native stop-sequencing still lets the later stop win.
  static const Duration _radioCallCap = Duration(seconds: 8);

  // >0 while the join popup or the review screen is on top. Neither
  // subscribes to the trigger, so pulls still reach this screen; ignore them
  // rather than run the radio behind a screen the operator is looking at.
  int _coveredDepth = 0;

  // True while this screen holds one ref of the catalog's 3 s auto-refresh.
  bool _autoRefreshHeld = false;
  int _enrichedAtVersion = -1;

  // Marked on every raw read (known tags included) so the reading indicator
  // shows the radio is alive while it passes stock that is already counted.
  final RfidReadPulse _readPulse = RfidReadPulse();

  /// [_session] repaints paced like Count's 150 ms flush — it used to repaint
  /// the whole screen once per new tag (owner, 2026-10-15: felt stuck).
  late final _PacedListenable _paced;

  /// One beep per NEW EPC this session (counted or defective), never closer
  /// than the pacer's gap, so a burst can't pile up behind the tags.
  final BeepPacer _beepPacer = BeepPacer();

  /// Tags decided "stay silent" for the rest of the session (ignored
  /// statuses) — a repeat read returns at once, without another lookup.
  final Set<String> _silenced = <String>{};

  // Local-first scan buffer. Each tag is counted instantly in `_session`
  // (ChangeNotifier → smooth per-tag UI) and queued here; a periodic flush
  // POSTs them to the server in batches. This removes the per-tag network
  // round-trip that made scanning stall around ~13–15k EPCs.
  static const int _flushBatchMax = 200;
  final List<Map<String, dynamic>> _flushBuffer = [];
  /// True until the session's server ledger has loaded (or failed to).
  bool _ledgerLoading = true;
  final List<String> _heldBeforeLedger = [];
  Timer? _flushTimer;
  bool _flushing = false;
  // Set by dispose: no timer is left to retry, so a flush still running (or
  // started there) retries failed batches instead of dropping them.
  bool _flushForced = false;

  @override
  void initState() {
    super.initState();
    // RFID-only screen: we deliberately don't subscribe to the camera
    // wedge / 2D-barcode broadcast streams here. Add-On Count surfaces
    // surprise EPCs read by the UHF radio — barcode scans (1D/2D) would
    // pollute the new-EPC list and aren't part of this flow. The single
    // listener below is `rfid.visibleEpcs`, which is the EPC-only stream
    // emitted by `_handleTagRead` after the UHF radio decodes a tag.
    _api = context.read<WmsApiClient>();
    _rfid = context.read<RfidManager>();
    _catalog = context.read<LiveCatalogCache>();
    _settings = context.read<MobileSettingsRepository>();
    _session = AddOnSessionState(
      sessionId: widget.sessionId,
      sourceType: widget.sourceType,
      sourceId: widget.sourceId,
      sourceSlip: widget.sourceSlip,
      sourceEpcs: widget.sourceEpcs,
    );
    _paced = _PacedListenable(_session);
    // App to background / phone screen off: RfidManager has already stopped
    // the radio; we only drop our own scanning state (_onLifecycleStop).
    _rfid.lifecycleStopTick.addListener(_onLifecycleStop);
    // Entry: bring the phone's catalog copy up to date. Lines counted (or
    // hydrated) before it is ready get their item info when it notifies.
    _catalog.addListener(_onCatalogChanged);
    unawaited(_catalog.ensureFresh());
    // Hydrate from the server's epc_ledger + failed_ledger so a resumed
    // session shows every EPC the operator (or any joined device) has
    // already counted. Without this, in-memory state always starts empty
    // and the operator sees "NEW 0" when re-entering a session that has
    // thousands of EPCs on the server. Best-effort: if the GET fails the
    // screen still works for fresh scans.
    final epcConfig = _settings.epcConfig;
    unawaited(_api.getAddOnSession(widget.sessionId).then((s) {
      if (!mounted) return;
      _session.hydrateFromServer(s, epcConfig: epcConfig);
      _enrichFromCatalog();
      _releaseHeldReads();
    }).catchError((Object _) {
      // offline / network — keep empty, and stop holding reads.
      _releaseHeldReads();
    }));
    _sse = AddOnSessionRealtime(api: _api, sessionId: widget.sessionId);
    _sseSub = _sse!.events.listen(_handleSseEvent);
    unawaited(_sse!.start());

    // 30-second heartbeat — server's Q12 60s disconnect kick + Q13 10min
    // idle cancel both depend on these touches keeping last_activity_at fresh.
    _heartbeat = Timer.periodic(const Duration(seconds: 30), (_) {
      _api.touchAddOnSession(widget.sessionId).catchError((Object _) {});
    });

    // Route the physical trigger to RFID + subscribe to trigger-down events
    // so a trigger pull toggles start/pause (Q18 lock). Mirrors the working
    // pattern from count_inventory_screen.dart:_ensureScannerReady — without
    // this the screen has no way for the operator to scan via hardware
    // trigger; only the on-screen START button works.
    unawaited(_ensureScannerReady());

    // Periodic batch flush of locally-counted EPCs to the server. Fast scans
    // also trigger a size-based flush (see _queueFlush) so the buffer can't
    // grow unbounded between ticks.
    _flushTimer = Timer.periodic(
        const Duration(milliseconds: 700), (_) => unawaited(_flush()));
  }

  /// Put the device in RFID-trigger mode and bind the hardware trigger to
  /// [_toggleScanning]. We deliberately keep tag ingest on
  /// `RfidManager.visibleEpcs` (rather than switching to the raw
  /// vendor stream the way Count Inventory does) so the manager's
  /// dedup + RSSI logic still applies and we don't duplicate ingest paths.
  Future<void> _ensureScannerReady() async {
    if (_scannerReady) return;
    _previousScanContext ??= _rfid.scanContext;
    _previousSuppressEdge ??= _rfid.suppressEdgeStreaming;
    // Runs from initState, i.e. mid-build: the manager setters below notify
    // its listeners, which must not happen during a build. Carry on once
    // this frame is done.
    await Future<void>.value();
    if (!mounted) return;
    // Local-first: this screen's EPCs reach the catalog only through the
    // session ledger + scan-finalize, never the edge-ingest firehose.
    _rfid.suppressEdgeStreaming = true;
    // Bulk module → RFD8500 maximum. The override goes in BEFORE the context
    // switch: setting scanContext re-applies handheld settings, and without
    // the override that re-apply pushes the tenant's per-context power
    // (Transfer In's, 24 dBm by default) — about half the read range.
    await _rfid.setSessionPowerOverrideDbm(kAntennaPowerDbmMax);
    // Left during the await: dispose already restored everything — don't
    // re-arm the manager for a screen that is gone.
    if (!mounted) return;
    _rfid.scanContext = 'ADD-ON COUNT';

    // Mirror Count Inventory: silence the 2D laser + relay so a trigger
    // pull goes straight to the UHF radio. setZebraTriggerModeRfid is the
    // RFD8500-side analogue of Chainway's enableRfidFunctionMode broadcast.
    try {
      await RfidVendorChannel.scannerDisableTriggerRelay();
      await RfidVendorChannel.close2dBarcode();
      await RfidVendorChannel.enableRfidFunctionMode();
      await RfidVendorChannel.setZebraTriggerModeRfid();
    } catch (_) {/* best-effort — channel may no-op when sled not connected */}
    if (!mounted) return;
    await RfidVendorChannel.setAntennaPowerDbm(kAntennaPowerDbmMax);
    if (!mounted) return;

    _triggerSub = hardwareTriggerFor(this).listen((event) {
      // Q18 contract: single trigger press toggles start/pause. 'down' is
      // press; we ignore 'up' so a held trigger doesn't keep retoggling.
      if (event == 'down' && _coveredDepth == 0) {
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
        // Another device counted an EPC (or a batch of them). Mark each
        // locally so we don't re-submit. Single events carry `epc`; batched
        // flushes carry `epcs: [...]`.
        final epc = event.payload['epc'] as String?;
        if (epc != null) _session.recordRemoteDuplicate(epc);
        final epcs = event.payload['epcs'];
        if (epcs is List) {
          for (final e in epcs) {
            if (e is String) _session.recordRemoteDuplicate(e);
          }
        }
        break;
      case 'join_requested':
        // We're the owner — show approve/decline popup.
        unawaited(_showJoinRequestPopup(event));
        break;
      case 'cancelled':
      case 'completed':
        // The pop runs dispose, which stops the radio and flushes.
        if (Navigator.of(context).canPop()) Navigator.of(context).pop();
        break;
    }
  }

  Future<void> _showJoinRequestPopup(AddOnRealtimeEvent event) async {
    final requesterUserId = event.payload['requester_user_id'] as String?;
    final requesterDeviceId = event.payload['requester_device_id'] as String?;
    ScanSounds.instance.play(ScanCue.error);
    bool? approved;
    _coveredDepth++;
    try {
      // Pause scanning while the popup is up — spec contract.
      await _pauseRadio();
      if (!mounted) return;
      approved = await showDialog<bool>(
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
    } finally {
      _coveredDepth--;
    }
    if (!mounted) return;
    try {
      await _api.respondJoinAddOnSession(
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

  /// Trigger pull / START-PAUSE button. Queued on [_radioChain]; [_doToggle]
  /// decides start vs stop from the state at the moment it runs.
  Future<void> _toggleScanning() {
    final now = DateTime.now();
    // Trigger bounce: one pull can arrive as two 'down's.
    if (now.difference(_lastToggleAt).inMilliseconds < 250) return _radioChain;
    _lastToggleAt = now;
    return _radioChain =
        _radioChain.then((_) => _doToggle()).catchError((Object _) {});
  }

  Future<void> _doToggle() async {
    if (!mounted) return;
    if (_session.scanning) {
      // Stop side: stop the radio first, then drop the gate. Order
      // matters because the visibleEpcs stream can flush late tags
      // between stop and the listener being torn down — we still
      // _session.scanning-gate them in _onEpc so they go nowhere.
      try {
        await _rfid.stopLocateScanning().timeout(_radioCallCap, onTimeout: () {});
      } catch (_) {/* ignore — best-effort stop */}
      if (!mounted) return;
      _session.setScanning(false);
      _beepPacer.cancel();
      ScanSounds.instance.play(ScanCue.stop);
      _releaseAutoRefresh();
      // Every pause pulls what changed in the catalog meanwhile.
      unawaited(_catalog.refresh());
    } else {
      // The sled trigger still fires with the phone screen off — never start
      // the radio for a screen nobody can see.
      if (_rfid.isBackgrounded) return;
      // Start side: tag stream is already subscribed in
      // _ensureScannerReady (always-on, gated by _session.scanning), so
      // here we just flip the gate and fire the radio. Both Zebra
      // (startInventoryFlutterResult) and Chainway paths terminate on
      // startScanning under the manager. Flipping the gate before the
      // await is safe now that a stop queues behind this start.
      _session.setScanning(true);
      ScanSounds.instance.play(ScanCue.start);
      _holdAutoRefresh();
      // Re-assert max power on every start: another screen or a settings
      // re-apply may have moved it since we armed.
      unawaited(_rfid.setSessionPowerOverrideDbm(kAntennaPowerDbmMax));
      unawaited(RfidVendorChannel.setAntennaPowerDbm(kAntennaPowerDbmMax));
      // Quiet mode: a tag already read stays silent while the sled keeps
      // powering it, so the radio spends its time on tags not read yet. Re-
      // asserted every start (a Locate in between puts the sled back on S0/S1).
      unawaited(RfidVendorChannel.setQuietInventory(true));
      try {
        await _rfid.startLocateScanning().timeout(_radioCallCap, onTimeout: () {});
      } catch (_) {/* radio may be unconnected — tag stream stays cold */}
    }
  }

  /// Pause for the join popup / review screen (no stop cue, as before).
  /// Queued on [_radioChain] so a start still in flight finishes first and
  /// is then stopped — never left running underneath.
  Future<void> _pauseRadio() {
    return _radioChain = _radioChain.then((_) async {
      if (!mounted || !_session.scanning) return;
      try {
        await _rfid.pauseScanning().timeout(_radioCallCap, onTimeout: () {});
      } catch (_) {/* best-effort */}
      if (!mounted) return;
      _session.setScanning(false);
      _beepPacer.cancel();
      _releaseAutoRefresh();
      unawaited(_catalog.refresh());
    }).catchError((Object _) {});
  }

  /// App went to background / screen off: RfidManager already stopped the
  /// radio. Only drop this screen's own scanning state — no cue, no restart.
  void _onLifecycleStop() {
    if (!mounted || !_session.scanning) return;
    _session.setScanning(false);
    _releaseAutoRefresh();
    ScanSounds.instance.stopAll();
  }

  void _holdAutoRefresh() {
    if (_autoRefreshHeld) return;
    _autoRefreshHeld = true;
    _catalog.startAutoRefresh();
  }

  void _releaseAutoRefresh() {
    if (!_autoRefreshHeld) return;
    _autoRefreshHeld = false;
    _catalog.stopAutoRefresh();
  }

  /// Item info for a line from the phone's catalog copy: the EPC's own items
  /// row first, else its decoded system id. Synchronous, no network.
  LiveItemInfo? _catalogInfo(String epc, String? systemId) {
    if (!_catalog.isReady) return null;
    return _catalog.itemInfoForEpc(epc) ??
        (systemId != null ? _catalog.itemInfoForSystemId(systemId) : null);
  }

  static NewEpcEntry _withInfo(NewEpcEntry e, LiveItemInfo info) => e.copyWith(
        customSku: info.sku,
        itemName: info.name,
        color: info.color,
        size: info.size,
        bin: info.binDisplay,
        retailPrice: num.tryParse(info.retailPrice ?? ''),
      );

  void _onCatalogChanged() {
    if (!mounted || !_catalog.isReady) return;
    final v = _catalog.version;
    if (v == _enrichedAtVersion) return;
    _enrichedAtVersion = v;
    _enrichFromCatalog();
  }

  /// Fill item info into lines that have none yet (counted or hydrated
  /// before the catalog copy was ready, or whose SKU arrived in a later
  /// delta). One notify for the whole pass.
  void _enrichFromCatalog() {
    if (!mounted || !_catalog.isReady) return;
    _session.enrichMissing((e) {
      final info = _catalogInfo(e.epc, e.systemId);
      return info == null ? null : _withInfo(e, info);
    });
    // Lines already shown keep up with bin changes too ("" = no bin now).
    _session.refreshBins((e) {
      final info = _catalogInfo(e.epc, e.systemId);
      return info == null ? null : (info.binDisplay ?? '');
    });
  }

  // Local-first: decide new/duplicate/failed on-device and update the counter
  // INSTANTLY (recordNew/recordFailed notify the UI), then queue the EPC for a
  // batched background flush. No per-tag network round-trip — that's what made
  // scanning stall at scale. Cross-device dedup still works: the SSE `epc_new`
  // events mark EPCs another operator counted (see _handleSseEvent).
  void _onEpc(String epc) {
    if (!_session.scanning) return;
    _readPulse.mark();
    final clean = epc.replaceAll(RegExp(r'\s+'), '').toUpperCase();
    if (clean.length != 24) return;
    // Resumed / joined session whose server ledger hasn't landed yet: hold the
    // read and decide it once it has, so an EPC already counted on the server
    // never beeps as NEW (_releaseHeldReads).
    if (_ledgerLoading) {
      _heldBeforeLedger.add(clean);
      return;
    }
    _decideEpc(clean);
  }

  void _releaseHeldReads() {
    if (!_ledgerLoading) return;
    _ledgerLoading = false;
    if (!mounted) return;
    final held = _heldBeforeLedger.toList();
    _heldBeforeLedger.clear();
    for (final epc in held) {
      _decideEpc(epc);
    }
  }

  void _decideEpc(String clean) {
    if (_silenced.contains(clean)) return;
    // Ghost (Statuses page "Ignore": sold, return, damaged, in-transit,
    // pending transaction, …): scanners ignore the tag — no beep, no count —
    // and it stays silent for the rest of the session.
    final known = _catalog.isReady ? _catalog.statusForEpc(clean) : null;
    if (known != null && _catalog.isGhostStatus(known)) {
      _silenced.add(clean);
      return;
    }

    // _session.shouldSubmit returns false for any EPC already in the chosen
    // source list (silent skip per Q16) AND for any EPC already reserved this
    // session — so anything past here is a NEW-to-device, not-in-source tag.
    if (!_session.shouldSubmit(clean)) return;

    // Carbon EPC formula gate. Defective tags go in their own bucket (the
    // DEFECTIVE counter, once per EPC) — not shown in the main list. One beep
    // like any new EPC. We still flush them with validationFailed=true so
    // finalize surfaces them as the Defective sheet.
    final cfg = _settings.epcConfig;
    final decoded = decodeEpc(clean, cfg);
    if (!decoded.valid) {
      final reason = decoded.reason?.name ?? 'invalid';
      _session.recordFailed(FailedEpcEntry(
        epc: clean,
        reason: reason,
        scannedAtUtc: DateTime.now().toUtc(),
      ));
      _beepPacer.request();
      _queueFlush({'epc': clean, 'validationFailed': true, 'failureReason': reason});
      return; // counter only, no line
    }

    // Valid + new-to-this-device → count immediately, beep, buffer. Item info
    // is an in-memory lookup in the phone's catalog copy (null until it is
    // ready — _onCatalogChanged fills those lines in later).
    final sysId = decoded.systemId?.toString();
    final info = _catalogInfo(clean, sysId);
    _session.recordNew(NewEpcEntry(
      epc: clean,
      scannedAtUtc: DateTime.now().toUtc(),
      systemId: sysId,
      customSku: info?.sku,
      itemName: info?.name,
      color: info?.color,
      size: info?.size,
      bin: info?.binDisplay,
      retailPrice: num.tryParse(info?.retailPrice ?? ''),
    ));
    _beepPacer.request();
    unawaited(_maybeVibrate());
    _queueFlush({'epc': clean, 'inSource': false});
  }

  void _queueFlush(Map<String, dynamic> item) {
    _flushBuffer.add(item);
    if (_flushBuffer.length >= _flushBatchMax) unawaited(_flush());
  }

  /// Drain the buffer to the server in [_flushBatchMax]-sized batches. Guarded
  /// so only one flush runs at a time; on a network error the un-sent items
  /// stay buffered and retry on the next tick. [force] is dispose's final
  /// send: it runs after unmount and retries a failed batch (see
  /// [_submitBatch]) because no timer is left to retry it.
  Future<void> _flush({bool force = false}) async {
    if (_flushing || _flushBuffer.isEmpty) return;
    if (!force && !mounted) return;
    _flushing = true;
    try {
      // Re-checks the buffer every pass, so a flush already running when the
      // screen closes also sends what dispose found left.
      while (_flushBuffer.isNotEmpty) {
        final take = _flushBuffer.length > _flushBatchMax
            ? _flushBatchMax
            : _flushBuffer.length;
        final batch = List<Map<String, dynamic>>.from(_flushBuffer.take(take));
        await _submitBatch(batch, force: force);
        _flushBuffer.removeRange(0, take);
      }
    } catch (_) {
      // Keep remaining buffered; periodic timer retries.
    } finally {
      _flushing = false;
    }
  }

  Future<void> _submitBatch(
    List<Map<String, dynamic>> batch, {
    required bool force,
  }) async {
    for (var attempt = 0;; attempt++) {
      try {
        await _api.submitAddOnSessionEpcsBatch(
          sessionId: widget.sessionId,
          items: batch,
        );
        return;
      } catch (_) {
        // Normal ticks give up at once (the next tick retries). Once the
        // screen is closing nothing retries later: up to 3 more tries.
        if (!(force || _flushForced) || attempt >= 3) rethrow;
        await Future<void>.delayed(const Duration(milliseconds: 500));
      }
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
    _coveredDepth++;
    try {
      await _pauseRadio();
      if (!mounted) return;
      // Drain every buffered EPC to the server BEFORE review — SAVE/UPLOAD
      // finalize reads the server's child table, so anything still local would
      // be missing from the upload otherwise.
      _flushTimer?.cancel();
      _flushTimer = null;
      for (var i = 0; i < 40 && mounted && _flushBuffer.isNotEmpty; i++) {
        await _flush();
        if (_flushBuffer.isNotEmpty) {
          await Future<void>.delayed(const Duration(milliseconds: 100));
        }
      }
      if (!mounted) return;
      await context.pushGuarded<void>(
        ScreenIds.addOnCountReview,
        (_) => AddOnCountReviewScreen(
          sessionId: widget.sessionId,
          sourceType: widget.sourceType,
          sourceId: widget.sourceId,
          sourceSlip: widget.sourceSlip,
          newEntries: _session.newEntries,
          failedEntries: _session.failedEntries,
        ),
      );
      if (!mounted) return;
      // Back from review — resume the periodic flush in case the operator keeps
      // scanning into the same session.
      _flushTimer ??= Timer.periodic(
          const Duration(milliseconds: 700), (_) => unawaited(_flush()));
    } finally {
      _coveredDepth--;
    }
  }

  @override
  void dispose() {
    _rfid.lifecycleStopTick.removeListener(_onLifecycleStop);
    _catalog.removeListener(_onCatalogChanged);
    _heartbeat?.cancel();
    _flushTimer?.cancel();
    _flushTimer = null;
    _sseSub?.cancel();
    unawaited(_sse?.dispose() ?? Future<void>.value());
    _directTagSub?.cancel();
    _barcodeSub?.cancel();
    _triggerSub?.cancel();
    // Leaving must never leave the sled transmitting (back button, drawer,
    // SSE cancelled/completed pop). Both calls: the manager's stop covers
    // Chainway; the direct Zebra stop covers a manager whose scanner isn't
    // linked yet. A start still queued natively is superseded by this stop.
    unawaited(_rfid.stopLocateScanning().catchError((Object _) {}));
    unawaited(RfidVendorChannel.stopZebraInventory());
    // Re-enable the auto per-tag beep for other screens, and the default
    // radio session (quiet mode is this screen's only).
    unawaited(ScanSounds.instance.setTagBeepSuppressed(false));
    unawaited(RfidVendorChannel.setQuietInventory(false));
    _beepPacer.dispose();
    // Restore what we changed on the shared manager so screens we pop back
    // to see the value they had when they pushed us. Cached reference — no
    // context.read here. These setters notify the manager's listeners, which
    // the framework forbids while it is tearing this route down, so they run
    // in a microtask right after the frame. Override cleared last: its
    // re-apply then pushes the restored context's power.
    final rfid = _rfid;
    final prevContext = _previousScanContext;
    final prevSuppress = _previousSuppressEdge ?? false;
    scheduleMicrotask(() {
      if (prevContext != null) rfid.scanContext = prevContext;
      rfid.suppressEdgeStreaming = prevSuppress;
      unawaited(rfid.setSessionPowerOverrideDbm(null));
    });
    _releaseAutoRefresh();
    // Send what's still buffered. Never clear _flushBuffer here: a flush that
    // is already running drains it (and its removeRange would throw).
    _flushForced = true;
    unawaited(_flush(force: true));
    _paced.dispose();
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
              listenable: _paced,
              builder: (_, __) => RfidReadingIndicator(
                scanning: _session.scanning,
                pulse: _readPulse,
                catalogSync: _catalog.syncState,
              ),
            ),
            ListenableBuilder(
              listenable: _paced,
              builder: (_, __) => _CounterRow(
                newCount: _session.newCount,
                defectiveCount: _session.failedCount,
              ),
            ),
            Expanded(
              child: ListenableBuilder(
                listenable: _paced,
                builder: (_, __) => _NewList(
                  entries: _session.newEntries,
                  scanning: _session.scanning,
                ),
              ),
            ),
            ListenableBuilder(
              listenable: _paced,
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
  const _NewList({required this.entries, required this.scanning});
  final List<NewEpcEntry> entries;
  final bool scanning;

  @override
  Widget build(BuildContext context) {
    if (entries.isEmpty) {
      return Center(
        child: Text(
          scanning ? 'Scanning — new tags appear here' : 'Pull trigger to start scanning',
          style: GoogleFonts.manrope(color: AppColors.textMuted),
        ),
      );
    }
    // While the radio is on: one plain EPC line per new tag (no product card
    // per tag — owner, 2026-10-15). The full lines show the moment it pauses.
    if (scanning) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: EdgeInsets.fromLTRB(12.w, 4.h, 12.w, 4.h),
            child: Text(
              'PRODUCT DETAILS SHOW WHEN YOU PAUSE',
              style: GoogleFonts.spaceGrotesk(
                fontSize: 11.sp,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.2,
                color: AppColors.textMuted,
              ),
            ),
          ),
          Expanded(
            child: ListView.builder(
              padding: EdgeInsets.symmetric(horizontal: 12.w, vertical: 4.h),
              itemCount: entries.length,
              itemExtent: 34.h,
              itemBuilder: (_, i) => Container(
                alignment: Alignment.centerLeft,
                margin: EdgeInsets.only(bottom: 4.h),
                padding: EdgeInsets.symmetric(horizontal: 10.w),
                color: const Color(0xFFECECEC),
                child: Text(
                  entries[entries.length - 1 - i].epc,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: GoogleFonts.robotoMono(
                    fontSize: 13.sp,
                    fontWeight: FontWeight.w700,
                    color: AppColors.textMain,
                  ),
                ),
              ),
            ),
          ),
        ],
      );
    }
    // One container per EPC. No grouping by SKU, no qty counter — each tag is
    // its own row so the operator sees every individual surprise.
    return ListView.separated(
      padding: EdgeInsets.symmetric(horizontal: 12.w, vertical: 8.h),
      itemCount: entries.length,
      separatorBuilder: (_, __) => SizedBox(height: 8.h),
      // Newest-first: entries are appended (O(1)), so read from the end.
      itemBuilder: (_, i) => AddOnEpcCard(entry: entries[entries.length - 1 - i]),
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

/// Forwards [source]'s notifications at most once per 150 ms (Count's flush
/// pace): the first one at once, the rest coalesced into one trailing notify.
class _PacedListenable extends ChangeNotifier {
  _PacedListenable(this.source) {
    source.addListener(_onSource);
  }

  static const Duration every = Duration(milliseconds: 150);

  final Listenable source;
  final Stopwatch _clock = Stopwatch()..start();
  Duration? _last;
  Timer? _timer;
  bool _disposed = false;

  void _onSource() {
    if (_disposed || _timer != null) return;
    final now = _clock.elapsed;
    final last = _last;
    if (last == null || now - last >= every) {
      _last = now;
      notifyListeners();
      return;
    }
    _timer = Timer(every - (now - last), () {
      _timer = null;
      if (_disposed) return;
      _last = _clock.elapsed;
      notifyListeners();
    });
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    source.removeListener(_onSource);
    super.dispose();
  }
}
