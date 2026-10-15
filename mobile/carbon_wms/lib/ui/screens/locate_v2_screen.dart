import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart' show ValueListenable;
import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/hardware_trigger.dart';
import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/hardware/rfid_tag_read.dart';
import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/locate/locate_engine.dart';
import 'package:carbon_wms/locate/locate_prefs.dart';
import 'package:carbon_wms/locate/sweep_estimator.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/handheld_device_identity.dart';
import 'package:carbon_wms/services/scan_sounds.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/locate_action_picker.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Locate 2.0 (docs/LOCATE_TAG_PRECISION_PLAN.md).
///
/// Two jobs, one screen:
///  * **Exact tag** — find this EPC (Cloud + Geiger, catalogue, counts…).
///  * **Any unit** — Store Replenishment: find ANY live unit of the line's exact
///    SKU here that nobody has pulled yet; "Pulled this unit" records it on the
///    server (re-validated, never double-counted).
///
/// Two engines, switchable for the side-by-side comparison:
///  * **Signal** — filtered inventory, exact EPC, acknowledged power, real
///    RSSI only, shown as a plain signal bar (not a distance).
///  * **Zebra Locate** — the reader's own TagLocationing (relative 0–100,
///    labelled "Zebra proximity"), when the connected reader supports it.
///
/// Stages: FIND → SWEEP (guided, two passes must agree) → NARROW (lower power,
/// accepted only if the tag stays heard) → CONFIRM (separate the item; a strong
/// signal alone is never "found").
class LocateV2Screen extends StatefulWidget {
  const LocateV2Screen({
    super.key,
    this.targetEpc,
    this.targetBin,
    this.targetSku,
    this.targetName,
    this.targetColor,
    this.targetSize,
    this.targetPriceText,
    this.cloudGeigerMode = false,
    this.anyUnitLineId,
  });

  final String? targetEpc;
  final String? targetBin;
  final String? targetSku;
  final String? targetName;
  final String? targetColor;
  final String? targetSize;
  final String? targetPriceText;
  final bool cloudGeigerMode;

  /// Store Replenishment sale line → "find any unit" mode.
  final int? anyUnitLineId;

  @override
  State<LocateV2Screen> createState() => _LocateV2ScreenState();
}

enum _Engine { signal, zebra }

enum _Stage { find, sweep, narrow, confirm }

enum _Power { unknown, confirmed, adjusting, fixed }

class _LocateV2ScreenState extends State<LocateV2Screen> {
  static final RegExp _epc24 = RegExp(r'^[0-9A-F]{24}$');
  static const int _tickMs = 16; // beep cadence needs ~16 ms granularity


  static const int _searchDbm = 30;

  /// NARROW goes down to here (owner, 2026-10-15) — or the reader's own
  /// lowest step if that is higher.
  static const int _narrowFloorDbm = 5;

  RfidManager? _rfid;
  // Captured while mounted: dispose posts the session log and must never
  // `context.read` (the element is already detached there — which is why no
  // Locate session ever reached the server).
  WmsApiClient? _api;
  StreamSubscription<RfidTagRead>? _readSub;
  StreamSubscription<String>? _triggerSub;
  StreamSubscription<double>? _yawSub;
  Timer? _ticker;
  Timer? _radioPoll;

  final ValueNotifier<LocateReading> _reading = ValueNotifier(LocateReading.idle);
  final ValueNotifier<bool> _radioLive = ValueNotifier(false);

  /// Gliding 0..1 for the signal bar (every tick, smooth).
  final ValueNotifier<double> _prox = ValueNotifier(0);
  final ValueNotifier<SweepResult> _sweepView =
      ValueNotifier(const SweepResult(SweepStatus.calibrating));

  LocateEngine? _engine;
  final SweepEstimator _sweep = SweepEstimator();
  NarrowTrial? _trial;

  LocateReaderCaps _caps = const LocateReaderCaps();
  _Engine _engineMode = _Engine.signal;
  _Stage _stage = _Stage.find;
  _Power _powerState = _Power.unknown;
  int _powerDbm = _searchDbm;
  int? _minPowerDbm;
  String? _notice;
  bool _scanning = false;
  bool _busy = false;
  bool _showDetails = false;
  bool _confirmed = false;
  DateTime _lastToggle = DateTime.fromMillisecondsSinceEpoch(0);
  int _lastBeepMs = 0;

  // Display pacing — the engine and the beep run every tick (16 ms); what the
  // operator READS changes at a calm pace so nothing jumps.
  static const int _publishMs = 100;
  int _lastPublishMs = 0;
  int _lastSweepPublishMs = 0;
  int _lastDisplayMs = 0;
  double? _displaySignal;
  LocatePresence _shownPresence = LocatePresence.searching;
  LocatePresence _pendingPresence = LocatePresence.searching;
  int _pendingSinceMs = 0;

  // Any-unit mode.
  bool _loadingUnits = false;
  String? _unitsError;
  Map<String, dynamic>? _unitsInfo;
  int _required = 0;
  int _pulled = 0;
  bool _lineDone = false;
  bool _pulling = false;
  final Map<String, String?> _binByEpc = <String, String?>{};

  // Session log.
  final String _sessionId = _uuidV4();
  final DateTime _startedAt = DateTime.now();
  final Stopwatch _clock = Stopwatch()..start();
  int? _readyMs;
  int? _firstSeenMs;
  int? _confirmedMs;
  String? _confirmMethod;
  String? _confirmedEpc;
  final List<Map<String, Object?>> _events = <Map<String, Object?>>[];

  bool get _anyUnit => widget.anyUnitLineId != null;
  late final String _epc = (widget.targetEpc ?? '').trim().toUpperCase();

  // ── Lifecycle ────────────────────────────────────────────────────────────

  @override
  void initState() {
    super.initState();
    unawaited(ScanSounds.instance.init());
    unawaited(ScanSounds.instance.setTagBeepSuppressed(true));
    unawaited(RfidVendorChannel.setZebraTriggerModeRfid());
    unawaited(RfidVendorChannel.enableRfidFunctionMode());
    unawaited(RfidVendorChannel.close2dBarcode());
    if (!_anyUnit && _epc24.hasMatch(_epc)) {
      _engine = LocateEngine(targets: [_epc]);
    }
    unawaited(_loadCaps());
    if (_anyUnit) unawaited(_loadUnits());
    _radioPoll = Timer.periodic(const Duration(milliseconds: 700), (_) => unawaited(_pollRadio()));
    _triggerSub = hardwareTriggerFor(this).listen((e) {
      if (mounted && e == 'down') unawaited(_toggle());
    }, onError: (_) {});
    _log('open', {'mode': _anyUnit ? 'any_unit' : 'exact'});
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _api ??= context.read<WmsApiClient>();
    if (_rfid == null) {
      final m = context.read<RfidManager>();
      _rfid = m;
      m.lifecycleStopTick.addListener(_onLifecycleStop);
      unawaited(m.setSessionPowerOverrideDbm(_powerDbm));
      m.scanContext = 'GEIGER_FIND';
    }
  }

  /// App went to background / screen off: RfidManager already stopped the radio.
  /// Only drop this screen's own scanning state — no cue, no restart.
  void _onLifecycleStop() {
    if (!mounted) return;
    if (_scanning) unawaited(_stop(silent: true));
  }

  @override
  void dispose() {
    _rfid?.lifecycleStopTick.removeListener(_onLifecycleStop);
    _scanning = false;
    _ticker?.cancel();
    _radioPoll?.cancel();
    unawaited(_readSub?.cancel());
    unawaited(_triggerSub?.cancel());
    unawaited(_yawSub?.cancel());
    // Restore the radio for the next screen — every path, in order.
    unawaited(RfidVendorChannel.nativeLocateStop());
    unawaited(RfidVendorChannel.stopZebraInventory());
    unawaited(RfidVendorChannel.stopChainwayInventory());
    unawaited(_rfid?.stopLocateScanning());
    unawaited(_rfid?.setSessionPowerOverrideDbm(null));
    unawaited(RfidVendorChannel.setEpcInventoryFilter(null));
    unawaited(RfidVendorChannel.setSingulationSession(useSessionZero: false));
    unawaited(ScanSounds.instance.setTagBeepSuppressed(false));
    unawaited(RfidVendorChannel.open2dBarcode());
    unawaited(_postSession());
    _prox.dispose();
    _reading.dispose();
    _radioLive.dispose();
    _sweepView.dispose();
    super.dispose();
  }

  Future<void> _loadCaps() async {
    final c = await RfidVendorChannel.locateCapabilities();
    if (!mounted) return;
    setState(() => _caps = c);
    _log('reader', {'model': c.model, 'fw': c.firmware, 'native': c.locationingSupported, 'levels': c.powerLevelsDbm});
  }

  Future<void> _pollRadio() async {
    final s = await RfidVendorChannel.readerStatus();
    if (!mounted) return;
    final live = s != null && s.connected && s.inventoryActive;
    if (_radioLive.value != live) _radioLive.value = live;
  }

  Future<void> _loadUnits() async {
    setState(() {
      _loadingUnits = true;
      _unitsError = null;
    });
    try {
      final r = await context.read<WmsApiClient>().fetchReplenishmentUnits(widget.anyUnitLineId!);
      final cands = (r['candidates'] as List? ?? const [])
          .whereType<Map>()
          .map((m) => (m['epc']?.toString() ?? '').toUpperCase())
          .where((e) => _epc24.hasMatch(e))
          .toList();
      _binByEpc
        ..clear()
        ..addEntries((r['candidates'] as List? ?? const [])
            .whereType<Map>()
            .map((m) => MapEntry((m['epc']?.toString() ?? '').toUpperCase(), m['bin']?.toString())));
      if (!mounted) return;
      setState(() {
        _unitsInfo = r;
        _required = (r['required'] as num?)?.toInt() ?? 0;
        _pulled = (r['pickedUnits'] as num?)?.toInt() ?? 0;
        _lineDone = _required > 0 && _pulled >= _required;
        _engine = cands.isEmpty ? null : LocateEngine(targets: cands);
        _loadingUnits = false;
      });
      _log('units', {'candidates': cands.length, 'required': _required, 'pulled': _pulled});
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loadingUnits = false;
        _unitsError = 'Could not load units: $e';
      });
    }
  }

  // ── Scan control ─────────────────────────────────────────────────────────

  Future<void> _toggle() async {
    if (_busy) return;
    final now = DateTime.now();
    if (now.difference(_lastToggle).inMilliseconds < 250) return;
    _lastToggle = now;
    _busy = true;
    try {
      if (_scanning) {
        await _stop();
      } else {
        await _start();
      }
    } finally {
      _busy = false;
    }
  }

  /// The connected reader's highest power step (30 dBm on the RFD8500).
  int get _maxDbm => _caps.powerLevelsDbm.isNotEmpty ? _caps.powerLevelsDbm.reduce(math.max) : _searchDbm;

  Future<void> _start() async {
    final engine = _engine;
    if (engine == null) return;
    // FIND always searches at full power (owner, 2026-10-15) — a range
    // narrowed earlier never carries into a new search.
    if (_stage == _Stage.find) {
      _trial = null;
      _powerDbm = _maxDbm;
    }
    ScanSounds.instance.play(ScanCue.start);
    setState(() {
      _scanning = true;
      _notice = null;
      _powerState = _Power.adjusting;
    });
    _log('start', {'engine': _engineMode.name});
    await _readSub?.cancel();
    // Every await below can span a stop (screen left, app backgrounded, line
    // done): once _scanning is false, never send another start to the radio.
    if (!mounted || !_scanning) return;
    _readSub = RfidVendorChannel.tagReadStream().listen(_onRead, onError: (_) {});

    if (_engineMode == _Engine.zebra) {
      await RfidVendorChannel.stopZebraInventory();
      if (!mounted || !_scanning) return;
      final r = await RfidVendorChannel.nativeLocateStart(_epc);
      if (r.error == 'superseded') {
        // The native side saw a stop asked for after this start — the stop
        // wins. Not a failure: no Signal fallback. Drop the UI state if the
        // stop came from outside this screen.
        _log('native_superseded', {});
        if (mounted && _scanning) unawaited(_stop(silent: true));
        return;
      }
      if (!mounted || !_scanning) return;
      if (r.error != null) {
        _log('native_failed', {'error': r.error});
        if (!mounted) return;
        setState(() {
          _notice = 'Zebra Locate could not start (${r.error}) — switched to Signal.';
          _engineMode = _Engine.signal;
        });
        await _startSignal(engine);
      } else {
        engine.resetForGeneration(r.generation);
        if (mounted) setState(() => _powerState = _Power.fixed);
      }
    } else {
      await _startSignal(engine);
    }
    if (!mounted || !_scanning) return;
    _readyMs ??= _clock.elapsedMilliseconds;
    _ticker?.cancel();
    _ticker = Timer.periodic(const Duration(milliseconds: _tickMs), (_) => _tick());
    if (_stage == _Stage.sweep) _startYaw();
  }

  Future<void> _startSignal(LocateEngine engine) async {
    // Exact single target → reader pre-filter; any-unit → exact set in
    // software (a pre-filter cannot express "one of these 23 EPCs").
    if (!mounted || !_scanning) return;
    final filtered = await RfidVendorChannel.setEpcInventoryFilter(_anyUnit ? null : _epc, force: true);
    if (!mounted || !_scanning) return;
    if (!_anyUnit && !filtered && _caps.isZebra) {
      // The sled refused the exact-tag filter → it answers for every tag in
      // range, not just this one. Say so instead of hiding it.
      _log('prefilter_rejected', {});
      setState(() => _notice = 'The reader did not accept the exact-tag filter — it is reading every tag nearby, so finding can be slower.');
    }
    await RfidVendorChannel.setSingulationSession(useSessionZero: true, force: true);
    if (!mounted || !_scanning) return;
    await _applyPower(_powerDbm, engine, reason: 'start');
    if (!mounted || !_scanning) return;
    try {
      await RfidVendorChannel.startZebraInventory();
    } catch (_) {}
    if (!mounted || !_scanning) return;
    unawaited(RfidVendorChannel.startChainwayInventory().catchError((_) {}));
    unawaited(_rfid?.startLocateScanning());
  }

  /// Apply power and only believe what the radio confirms.
  Future<bool> _applyPower(int dbm, LocateEngine engine, {required String reason}) async {
    if (mounted) setState(() => _powerState = _Power.adjusting);
    final ack = await RfidVendorChannel.setPowerAck(dbm);
    _log('power', {'reason': reason, 'requested': dbm, 'applied': ack.appliedDbm, 'ok': ack.ok, 'gen': ack.generation, 'error': ack.error});
    if (!mounted) return false;
    if (ack.ok && ack.appliedDbm != null) {
      engine.resetForGeneration(ack.generation);
      _sweep.reset();
      unawaited(_rfid?.setSessionPowerOverrideDbm(ack.appliedDbm));
      setState(() {
        _powerDbm = ack.appliedDbm!;
        _powerState = _Power.confirmed;
      });
      if (_scanning) {
        // Belt and braces: the controller resumes, but never leave it stopped.
        try {
          await RfidVendorChannel.startZebraInventory();
        } catch (_) {}
      }
      return true;
    }
    // Reader cannot confirm (Chainway / not connected) → fixed power, no narrowing.
    engine.clearEvidence();
    unawaited(_rfid?.setSessionPowerOverrideDbm(dbm));
    setState(() {
      _powerDbm = dbm;
      _powerState = _Power.fixed;
    });
    return false;
  }

  /// [silent] skips only the stop cue (app backgrounded / screen off).
  Future<void> _stop({bool silent = false}) async {
    if (!silent) ScanSounds.instance.play(ScanCue.stop);
    _ticker?.cancel();
    _ticker = null;
    _trial = null;
    _engine?.clearEvidence();
    _reading.value = LocateReading.idle;
    _prox.value = 0;
    _beepLevel = 0;
    _lastBeepTickMs = 0;
    _displaySignal = null;
    _lastDisplayMs = 0;
    _shownPresence = LocatePresence.searching;
    _pendingPresence = LocatePresence.searching;
    await _yawSub?.cancel();
    _yawSub = null;
    if (mounted) setState(() => _scanning = false);
    await _readSub?.cancel();
    _readSub = null;
    await RfidVendorChannel.nativeLocateStop();
    try {
      await RfidVendorChannel.stopZebraInventory();
    } catch (_) {}
    unawaited(RfidVendorChannel.stopChainwayInventory().catchError((_) {}));
    unawaited(_rfid?.stopLocateScanning());
    _log('stop', {});
  }

  void _startYaw() {
    if (_yawSub != null) return;
    _yawSub = RfidVendorChannel.deviceYawStream().listen(
      (deg) => _sweep.onYaw(deg, _clock.elapsedMilliseconds),
      onError: (_) {},
    );
  }

  // ── Read path (fields only, no setState) ─────────────────────────────────

  void _onRead(RfidTagRead r) {
    final engine = _engine;
    if (!_scanning || engine == null) return;
    final now = _clock.elapsedMilliseconds;
    final exact = r.exactEpc96;
    final counted = engine.add(LocateObservation(
      epc: exact ?? (r.raw ?? r.epcHex24),
      receivedMs: now,
      rssi: r.rssi,
      generation: r.generation,
      relativeProximity: r.relativeProximity,
      formatError: exact == null,
    ));
    if (!counted) return;
    _firstSeenMs ??= now;
    if (_stage == _Stage.sweep && exact == engine.followed && r.rssi != null) {
      _sweep.onSignal(r.rssi!);
    }
  }

  // ── Engine tick ──────────────────────────────────────────────────────────

  void _tick() {
    final engine = _engine;
    if (!_scanning || engine == null) return;
    final now = _clock.elapsedMilliseconds;
    final reading = engine.tick(now);
    _publish(reading, now);

    if (_stage == _Stage.sweep) {
      _sweep.calibrate();
      if (now - _lastSweepPublishMs >= 250) {
        _lastSweepPublishMs = now;
        // A fresh instance (no ==), so the "left/right of where you point
        // now" wording follows the operator — 4× a second, not 60.
        _sweepView.value = _sweep.result();
      }
    }

    final trial = _trial;
    if (trial != null) {
      final d = trial.decide(engine, now, engine.followed);
      if (d != null) {
        _trial = null;
        if (d) {
          _minPowerDbm = _minPowerDbm == null ? trial.toDbm : math.min(_minPowerDbm!, trial.toDbm);
          _log('narrow_ok', {'dbm': trial.toDbm});
          setState(() => _notice = 'Range narrowed to ${trial.toDbm} dBm — still heard.');
        } else {
          // The step STAYS (owner, 2026-10-15: narrow all the way to 5 dBm) —
          // at a low range the tag is only heard up close, so move the reader
          // closer, or WIDEN.
          _log('narrow_not_heard', {'dbm': trial.toDbm});
          setState(() => _notice = 'Not heard at ${trial.toDbm} dBm yet — move closer to the rack, or WIDEN.');
        }
      }
    }

    // Audio: the original Locate beep, faster and louder as it gets closer
    // (classic cadence 650 ms → 45 ms). Once found it keeps beeping through
    // short read gaps — holds 0.6 s, then fades over ~0.8 s — instead of
    // cutting off the moment one read is missed.
    final dt = _lastBeepTickMs == 0 ? 0 : now - _lastBeepTickMs;
    _lastBeepTickMs = now;
    final level = _levelOf(reading);
    if (level != null) {
      _beepLevel = level.clamp(0.0, 1.0);
      _beepHeardMs = now;
    } else if (now - _beepHeardMs > 600) {
      _beepLevel *= math.exp(-dt / 800.0);
      if (_beepLevel < 0.02) _beepLevel = 0;
    }
    if (_beepLevel > 0.02) {
      final p = _beepLevel;
      final interval = (_beepSlowMs * math.pow(_beepFastMs / _beepSlowMs, p)).round();
      if (now - _lastBeepMs >= interval) {
        _lastBeepMs = now;
        ScanSounds.instance.play(ScanCue.read, volume: (0.40 + 0.60 * p).clamp(0.0, 1.0));
        _beepsPlayed++;
      }
    } else if (reading.presence == LocatePresence.detectedNoStrength && now - _lastBeepMs >= 1000) {
      _lastBeepMs = now;
      ScanSounds.instance.play(ScanCue.read, volume: 0.5);
    }
  }

  int _beepsPlayed = 0;

  /// The one 0..1 level used for the dial AND the beep: Zebra's relative
  /// proximity when the reader sends it, otherwise the RSSI signal (so Zebra
  /// mode never sits at 0 % just because the reader omits proximity).
  double? _levelOf(LocateReading r) {
    if (r.relativeProximity != null) return r.relativeProximity! / 100.0;
    if (r.presence == LocatePresence.detected) return r.signal;
    return null;
  }

  static const double _beepSlowMs = 650;
  static const double _beepFastMs = 45;
  double _beepLevel = 0;
  int _beepHeardMs = 0;
  int _lastBeepTickMs = 0;

  /// Calm view of [r]: the bar/number glide (≈0.35 s), the status words only
  /// change once a new state has held (0.3 s up, 0.8 s down), and the screen
  /// is repainted 5× a second instead of 60.
  void _publish(LocateReading r, int now) {
    final dt = _lastDisplayMs == 0 ? 0 : now - _lastDisplayMs;
    _lastDisplayMs = now;
    final raw = _levelOf(r);
    if (raw == null) {
      // Hold the last value through short gaps; clear once "searching" shows.
      if (_shownPresence == LocatePresence.searching) _displaySignal = null;
    } else {
      final cur = _displaySignal ?? raw;
      // Fast up (closing in must feel instant), a little slower down.
      final a = dt <= 0 ? 1.0 : 1 - math.exp(-dt / (raw > cur ? 70.0 : 180.0));
      _displaySignal = cur + (raw - cur) * a;
    }

    _prox.value = (_displaySignal ?? 0).clamp(0.0, 1.0);

    if (r.presence != _pendingPresence) {
      _pendingPresence = r.presence;
      _pendingSinceMs = now;
    }
    final hold = _pendingPresence == LocatePresence.searching ? 700 : 150;
    var changed = false;
    if (_pendingPresence != _shownPresence && now - _pendingSinceMs >= hold) {
      _shownPresence = _pendingPresence;
      changed = true;
    }
    if (!changed && now - _lastPublishMs < _publishMs) return;
    _lastPublishMs = now;
    final shown = _displaySignal;
    _reading.value = LocateReading(
      presence: _shownPresence == LocatePresence.searching && shown != null
          ? LocatePresence.detected
          : _shownPresence,
      followedEpc: r.followedEpc,
      signal: shown,
      medianRssi: r.medianRssi,
      relativeProximity: r.relativeProximity == null || shown == null ? null : (shown * 100).round(),
      readsPerSec: r.readsPerSec,
      windowsHit: r.windowsHit,
      lastSeenAgeMs: r.lastSeenAgeMs,
      candidatesHeard: r.candidatesHeard,
    );
  }

  // ── Stage actions ────────────────────────────────────────────────────────

  void _setStage(_Stage s) {
    if (_stage == s) return;
    setState(() => _stage = s);
    _log('stage', {'stage': s.name});
    // Back to FIND mid-search → full power again (Signal engine; Zebra Locate
    // manages its own power).
    final engine = _engine;
    if (s == _Stage.find && _scanning && engine != null && _engineMode == _Engine.signal && _powerDbm != _maxDbm) {
      _trial = null;
      unawaited(_applyPower(_maxDbm, engine, reason: 'find_max'));
    }
    if (s == _Stage.sweep) {
      _sweep.reset();
      _sweepView.value = const SweepResult(SweepStatus.calibrating);
      if (_scanning) _startYaw();
    } else {
      unawaited(_yawSub?.cancel());
      _yawSub = null;
    }
  }

  Future<void> _narrow() async {
    final engine = _engine;
    if (engine == null || !_scanning || _trial != null) return;
    final next = nextPowerDown(_caps.powerLevelsDbm.where((l) => l >= _narrowFloorDbm).toList(), _powerDbm);
    if (next == null) {
      setState(() => _notice = 'Already at the lowest range ($_powerDbm dBm).');
      return;
    }
    final from = _powerDbm;
    final ok = await _applyPower(next, engine, reason: 'narrow');
    if (!mounted) return;
    if (!ok) {
      setState(() => _notice = 'This reader cannot confirm power changes — narrowing is off.');
      return;
    }
    _trial = NarrowTrial(fromDbm: from, toDbm: _powerDbm, startedMs: _clock.elapsedMilliseconds);
    setState(() => _notice = 'Checking $_powerDbm dBm…');
  }

  Future<void> _widen() async {
    final engine = _engine;
    if (engine == null) return;
    final next = nextPowerUp(_caps.powerLevelsDbm, _powerDbm) ?? _searchDbm;
    _trial = null;
    await _applyPower(next, engine, reason: 'widen');
    if (mounted) setState(() => _notice = 'Search widened to $_powerDbm dBm.');
  }

  Future<void> _confirm() async {
    final engine = _engine;
    final reading = _reading.value;
    final epc = reading.followedEpc;
    if (engine == null || epc == null) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(_anyUnit ? 'Pulled this unit?' : 'Is this the item?'),
        content: Text(_anyUnit
            ? 'Take the item off the rack, hold it away from the others and keep it in front of the reader. Only confirm once it is in your hand.'
            : 'Separate the item from the garments around it and keep it in front of the reader. A strong signal alone is not proof — confirm only once you have it isolated.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Not yet')),
          FilledButton(onPressed: () => Navigator.of(ctx).pop(true), child: Text(_anyUnit ? 'Pulled it' : 'I have it')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    // Re-check the evidence AFTER isolation: still heard repeatedly, exact EPC.
    final again = engine.tick(_clock.elapsedMilliseconds);
    if (!(again.followedEpc == epc && again.windowsHit >= 2)) {
      setState(() => _notice = 'The tag is no longer being heard — keep it in front of the reader and try again.');
      _log('confirm_rejected', {'epc': epc, 'windows': again.windowsHit});
      return;
    }
    if (_anyUnit) {
      await _pullUnit(epc);
      return;
    }
    ScanSounds.instance.play(ScanCue.success);
    _confirmedMs ??= _clock.elapsedMilliseconds;
    _confirmMethod = 'isolation_exact_reads';
    _confirmedEpc = epc;
    _log('confirmed', {'epc': epc, 'method': _confirmMethod, 'power': _powerDbm});
    setState(() {
      _confirmed = true;
      _notice = 'Confirmed: exact tag …${epc.substring(epc.length - 6)} isolated.';
    });
    if (widget.cloudGeigerMode) {
      if (_scanning) await _stop();
      if (mounted) showLocateActionPicker(context, epc: _epc, cloudGeigerMode: true);
    }
  }

  Future<void> _pullUnit(String epc) async {
    if (_pulling) return;
    setState(() => _pulling = true);
    try {
      final r = await context.read<WmsApiClient>().pickReplenishmentUnit(
            widget.anyUnitLineId!,
            epc,
            method: 'locate_any_unit_${_engineMode.name}',
          );
      if (!mounted) return;
      ScanSounds.instance.play(ScanCue.success);
      _engine?.removeTarget(epc);
      _confirmedMs ??= _clock.elapsedMilliseconds;
      _confirmMethod = 'any_unit_isolation';
      _confirmedEpc = epc;
      _log('unit_pulled', {'epc': epc});
      setState(() {
        _pulled = (r['pickedUnits'] as num?)?.toInt() ?? _pulled + 1;
        _required = (r['required'] as num?)?.toInt() ?? _required;
        _lineDone = r['linePicked'] == true;
        _notice = _lineDone
            ? 'Line complete — $_pulled of $_required pulled.'
            : 'Pulled $_pulled of $_required. Keep going for the next unit.';
      });
      if (_lineDone && _scanning) await _stop();
    } on WmsApiException catch (e) {
      if (!mounted) return;
      ScanSounds.instance.play(ScanCue.error);
      String msg = e.body;
      final m = RegExp(r'"error"\s*:\s*"([^"]+)"').firstMatch(e.body);
      if (m != null) msg = m.group(1)!;
      setState(() => _notice = 'Not saved: $msg');
      _log('unit_rejected', {'epc': epc, 'error': msg});
      if (e.statusCode == 409) _engine?.removeTarget(epc);
    } catch (e) {
      if (mounted) setState(() => _notice = 'Not saved: $e');
    } finally {
      if (mounted) setState(() => _pulling = false);
    }
  }

  Future<void> _switchEngine(_Engine e) async {
    if (_engineMode == e) return;
    final wasScanning = _scanning;
    if (wasScanning) await _stop();
    setState(() {
      _engineMode = e;
      if (e == _Engine.zebra && _stage == _Stage.narrow) _stage = _Stage.find;
    });
    _log('engine', {'engine': e.name});
    if (wasScanning) await _start();
  }

  Future<void> _useClassic() async {
    await LocatePrefs.setUseNewLocate(false);
    if (!mounted) return;
    Navigator.of(context).pop();
    if (mounted) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        const SnackBar(content: Text('Classic Locate is on for this handheld. Open Locate again.')),
      );
    }
  }

  // ── Session log ──────────────────────────────────────────────────────────

  void _log(String type, Map<String, Object?> data) {
    if (_events.length >= 300) return;
    _events.add({'t': _clock.elapsedMilliseconds, 'e': type, ...data});
  }

  Future<void> _postSession() async {
    try {
      final api = _api;
      if (api == null) return;
      final info = await PackageInfo.fromPlatform();
      final device = await HandheldDeviceIdentity.primaryDeviceIdForServer();
      final ended = _clock.elapsedMilliseconds;
      await api.postLocateSession({
        'id': _sessionId,
        'deviceId': device,
        'appVersion': info.version,
        'readerModel': _caps.model,
        'readerFirmware': _caps.firmware,
        'engine': _engineMode.name,
        'mode': _anyUnit ? 'any_unit' : 'exact',
        'targetEpc': _anyUnit ? null : _epc,
        'targetSku': widget.targetSku ?? _unitsInfo?['sku']?.toString(),
        'candidateCount': _engine?.targets.length,
        'startedAt': _startedAt.toUtc().toIso8601String(),
        'readyMs': _readyMs,
        'firstSeenMs': _firstSeenMs,
        'confirmedMs': _confirmedMs,
        'endedMs': ended,
        'outcome': _confirmedMs != null
            ? (_anyUnit ? (_lineDone ? 'line_complete' : 'unit_pulled') : 'confirmed')
            : (_firstSeenMs != null ? 'abandoned_after_detect' : 'abandoned'),
        'confirmMethod': _confirmMethod,
        'confirmedEpc': _confirmedEpc,
        'minPowerDbm': _minPowerDbm,
        'events': _events,
      });
    } catch (_) {
      // Telemetry never blocks or bothers the operator.
    }
  }

  // ── UI ───────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final engine = _engine;
    final nativeOk = _caps.locationingSupported && !_anyUnit;
    return CarbonScaffold(
      pageTitle: _anyUnit ? 'FIND ANY UNIT' : 'LOCATE',
      body: SafeArea(
        top: false,
        child: ListView(
          padding: EdgeInsets.fromLTRB(16.w, 10.h, 16.w, 16.h),
          children: [
            _ItemCard(
              sku: widget.targetSku ?? _unitsInfo?['sku']?.toString(),
              name: widget.targetName ?? _unitsInfo?['name']?.toString(),
              color: widget.targetColor ?? _unitsInfo?['color']?.toString(),
              size: widget.targetSize ?? _unitsInfo?['size']?.toString(),
              price: widget.targetPriceText,
              bin: widget.targetBin,
              epc: _anyUnit ? null : _epc,
            ),
            if (_anyUnit) ...[
              SizedBox(height: 8.h),
              _AnyUnitPanel(
                loading: _loadingUnits,
                error: _unitsError,
                required: _required,
                pulled: _pulled,
                candidates: engine?.targets.length ?? 0,
                done: _lineDone,
                reading: _reading,
                binByEpc: _binByEpc,
                onTryAnother: _scanning
                    ? () => _engine?.tryAnotherUnit(_clock.elapsedMilliseconds)
                    : null,
                onReload: _scanning ? null : _loadUnits,
              ),
            ],
            if (engine == null && !_anyUnit)
              Padding(
                padding: EdgeInsets.only(top: 12.h),
                child: const _Notice('This tag id is not a valid 24-character EPC — Locate needs the exact EPC.', error: true),
              ),
            SizedBox(height: 10.h),
            Row(
              children: [
                Expanded(
                  child: _Segmented(
                    labels: const ['SIGNAL', 'ZEBRA LOCATE'],
                    selected: _engineMode.index,
                    enabled: [true, nativeOk],
                    onTap: (i) => unawaited(_switchEngine(_Engine.values[i])),
                  ),
                ),
              ],
            ),
            SizedBox(height: 8.h),
            _StageChips(
              stage: _stage,
              narrowEnabled: _engineMode == _Engine.signal,
              onTap: _setStage,
            ),
            SizedBox(height: 10.h),
            _StatusLine(
              scanning: _scanning,
              radioLive: _radioLive,
              reading: _reading,
              power: _powerState,
              connected: _caps.connected || _radioLive.value,
            ),
            SizedBox(height: 8.h),
            // Owner, 2026-10-15: no round dial, no % — the signal bar and the
            // moving line, which climbs as you close in and drops as you move
            // away. The hot/cold beep is unchanged.
            RepaintBoundary(
              child: _SignalView(
                proximity: _prox,
                engine: engine,
                reading: _reading,
                zebra: _engineMode == _Engine.zebra,
              ),
            ),
            SizedBox(height: 6.h),
            SizedBox(
              height: 36.h,
              child: _PowerLine(state: _powerState, dbm: _powerDbm, minDbm: _minPowerDbm, zebra: _engineMode == _Engine.zebra),
            ),
            SizedBox(height: 8.h),
            // Always reserves its space — a message arriving never pushes the
            // buttons down under the operator's thumb.
            SizedBox(
              height: 58.h,
              child: _notice == null ? null : _Notice(_notice!),
            ),
            if (_stage == _Stage.sweep) ...[
              SizedBox(height: 10.h),
              _SweepPanel(view: _sweepView, sweep: _sweep, scanning: _scanning),
            ],
            if (_stage == _Stage.narrow && _engineMode == _Engine.signal) ...[
              SizedBox(height: 10.h),
              Row(
                children: [
                  Expanded(
                    child: _ActionButton(
                      label: 'NARROW RANGE',
                      icon: Icons.compress,
                      onPressed: _scanning && _powerState == _Power.confirmed && _trial == null ? _narrow : null,
                    ),
                  ),
                  SizedBox(width: 8.w),
                  Expanded(
                    child: _ActionButton(
                      label: 'WIDEN',
                      icon: Icons.expand,
                      secondary: true,
                      onPressed: _scanning && _powerState != _Power.adjusting ? _widen : null,
                    ),
                  ),
                ],
              ),
              SizedBox(height: 4.h),
              Text(
                'Stand still at the rack and narrow step by step, down to 5 dBm. At a low range the tag is only heard up close — '
                'move the reader along the rack, and WIDEN if you lose it. Compare neighbouring sections at the same range.',
                style: GoogleFonts.manrope(fontSize: 12.sp, color: AppColors.textMuted, fontWeight: FontWeight.w600),
              ),
            ],
            if (_stage == _Stage.confirm || _anyUnit) ...[
              SizedBox(height: 10.h),
              ValueListenableBuilder<LocateReading>(
                valueListenable: _reading,
                builder: (_, r, __) {
                  final ready = _scanning && r.followedEpc != null && r.windowsHit >= 3 && !_pulling && !_lineDone;
                  return _ActionButton(
                    label: _anyUnit
                        ? (_pulling ? 'SAVING…' : 'PULLED THIS UNIT')
                        : (_confirmed ? 'CONFIRMED ✓' : 'I HAVE THE ITEM'),
                    icon: Icons.check_circle_outline,
                    onPressed: ready ? _confirm : null,
                  );
                },
              ),
              SizedBox(height: 4.h),
              Text(
                _anyUnit
                    ? 'Enabled once a unit is heard repeatedly. Pull it, hold it apart from the rest, then confirm — the server re-checks it is a live unit of this exact SKU.'
                    : 'Enabled once the exact tag is heard repeatedly. Separate the item from the garments around it before confirming.',
                style: GoogleFonts.manrope(fontSize: 12.sp, color: AppColors.textMuted, fontWeight: FontWeight.w600),
              ),
            ],
            SizedBox(height: 12.h),
            _ActionButton(
              label: _scanning ? 'PAUSE' : 'START (or pull the trigger)',
              icon: _scanning ? Icons.pause : Icons.play_arrow,
              big: true,
              onPressed: engine == null || _lineDone ? null : () => unawaited(_toggle()),
            ),
            if (widget.cloudGeigerMode && !_scanning) ...[
              SizedBox(height: 8.h),
              _ActionButton(
                label: 'TAKE AN ACTION',
                icon: Icons.bolt,
                secondary: true,
                onPressed: () => showLocateActionPicker(context, epc: _epc, cloudGeigerMode: true),
              ),
            ],
            SizedBox(height: 10.h),
            TextButton(
              onPressed: () => setState(() => _showDetails = !_showDetails),
              child: Text(_showDetails ? 'Hide details' : 'Details'),
            ),
            if (_showDetails)
              _Details(
                engine: engine,
                reading: _reading,
                caps: _caps,
                powerDbm: _powerDbm,
                powerState: _powerState,
                onUseClassic: _useClassic,
                beepsPlayed: () => _beepsPlayed,
              ),
          ],
        ),
      ),
    );
  }
}

String _uuidV4() {
  final r = math.Random.secure();
  final b = List<int>.generate(16, (_) => r.nextInt(256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  String h(int i) => b[i].toRadixString(16).padLeft(2, '0');
  final s = [for (var i = 0; i < 16; i++) h(i)].join();
  return '${s.substring(0, 8)}-${s.substring(8, 12)}-${s.substring(12, 16)}-${s.substring(16, 20)}-${s.substring(20)}';
}

// ═══════════════════════════════════════════════════════════════════════════
// Widgets
// ═══════════════════════════════════════════════════════════════════════════

TextStyle _label() => GoogleFonts.spaceGrotesk(
      fontSize: 11.sp,
      fontWeight: FontWeight.w800,
      letterSpacing: 1.2,
      color: AppColors.textMuted,
    );

class _ItemCard extends StatelessWidget {
  const _ItemCard({this.sku, this.name, this.color, this.size, this.price, this.bin, this.epc});

  final String? sku;
  final String? name;
  final String? color;
  final String? size;
  final String? price;
  final String? bin;
  final String? epc;

  @override
  Widget build(BuildContext context) {
    final variant = [color, size].where((s) => (s ?? '').isNotEmpty).join(' · ');
    return Container(
      color: const Color(0xFFECECEC),
      padding: EdgeInsets.fromLTRB(14.w, 10.h, 14.w, 10.h),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  (name ?? '').isEmpty ? 'Item' : name!.toUpperCase(),
                  style: GoogleFonts.spaceGrotesk(fontSize: 17.sp, fontWeight: FontWeight.w900, color: Colors.black),
                ),
              ),
              if ((price ?? '').isNotEmpty)
                Text(price!, style: GoogleFonts.spaceGrotesk(fontSize: 15.sp, fontWeight: FontWeight.w800)),
            ],
          ),
          if (variant.isNotEmpty)
            Text(variant.toUpperCase(), style: GoogleFonts.spaceGrotesk(fontSize: 14.sp, fontWeight: FontWeight.w800)),
          if ((sku ?? '').isNotEmpty)
            Text('SKU $sku', style: GoogleFonts.robotoMono(fontSize: 13.sp, fontWeight: FontWeight.w700)),
          if ((bin ?? '').isNotEmpty)
            Text('RECORDED BIN $bin', style: GoogleFonts.spaceGrotesk(fontSize: 14.sp, fontWeight: FontWeight.w900, color: Colors.black)),
          if ((epc ?? '').isNotEmpty)
            Text('EPC …${epc!.length > 8 ? epc!.substring(epc!.length - 8) : epc}',
                style: GoogleFonts.robotoMono(fontSize: 12.sp, color: AppColors.textMuted, fontWeight: FontWeight.w700)),
        ],
      ),
    );
  }
}

class _AnyUnitPanel extends StatelessWidget {
  const _AnyUnitPanel({
    required this.loading,
    required this.error,
    required this.required,
    required this.pulled,
    required this.candidates,
    required this.done,
    required this.reading,
    required this.binByEpc,
    required this.onTryAnother,
    required this.onReload,
  });

  final bool loading;
  final String? error;
  final int required;
  final int pulled;
  final int candidates;
  final bool done;
  final ValueListenable<LocateReading> reading;
  final Map<String, String?> binByEpc;
  final VoidCallback? onTryAnother;
  final VoidCallback? onReload;

  @override
  Widget build(BuildContext context) {
    if (loading) return const _Notice('Loading the units you can pull…');
    if (error != null) return _Notice(error!, error: true);
    return Container(
      padding: EdgeInsets.all(12.r),
      color: done ? const Color(0xFFD6F5E6) : const Color(0xFFF0F5F4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            done ? 'LINE COMPLETE · PULLED $pulled / $required' : 'PULLED $pulled / $required',
            style: GoogleFonts.spaceGrotesk(
              fontSize: 18.sp,
              fontWeight: FontWeight.w900,
              color: done ? const Color(0xFF16A34A) : Colors.black,
            ),
          ),
          Text(
            '$candidates live unit${candidates == 1 ? '' : 's'} of this exact SKU here not yet pulled',
            style: GoogleFonts.manrope(fontSize: 12.sp, fontWeight: FontWeight.w700, color: AppColors.textMuted),
          ),
          ValueListenableBuilder<LocateReading>(
            valueListenable: reading,
            builder: (_, r, __) {
              final epc = r.followedEpc;
              final bin = epc == null ? null : binByEpc[epc];
              return Padding(
                padding: EdgeInsets.only(top: 6.h),
                child: Text(
                  epc == null
                      ? 'NO UNIT HEARD YET'
                      : 'FOLLOWING UNIT …${epc.substring(epc.length - 6)}${bin != null ? ' · BIN $bin' : ''}'
                          '  ·  ${r.candidatesHeard} heard',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: GoogleFonts.robotoMono(fontSize: 13.sp, fontWeight: FontWeight.w800),
                ),
              );
            },
          ),
          SizedBox(height: 6.h),
          Row(
            children: [
              Expanded(
                child: _ActionButton(label: 'TRY ANOTHER UNIT', icon: Icons.swap_horiz, secondary: true, onPressed: onTryAnother),
              ),
              SizedBox(width: 8.w),
              Expanded(
                child: _ActionButton(label: 'REFRESH LIST', icon: Icons.refresh, secondary: true, onPressed: onReload),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _Segmented extends StatelessWidget {
  const _Segmented({required this.labels, required this.selected, required this.enabled, required this.onTap});

  final List<String> labels;
  final int selected;
  final List<bool> enabled;
  final ValueChanged<int> onTap;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        for (var i = 0; i < labels.length; i++)
          Expanded(
            child: Padding(
              padding: EdgeInsets.only(right: i < labels.length - 1 ? 6.w : 0),
              child: SizedBox(
                height: 44,
                child: FilledButton(
                  onPressed: enabled[i] ? () => onTap(i) : null,
                  style: FilledButton.styleFrom(
                    backgroundColor: i == selected ? AppColors.primary : const Color(0xFFE2E7E7),
                    foregroundColor: i == selected ? Colors.white : AppColors.textMain,
                    disabledBackgroundColor: const Color(0xFFF0F0F0),
                    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
                  ),
                  child: Text(labels[i], style: GoogleFonts.spaceGrotesk(fontWeight: FontWeight.w900, fontSize: 13.sp)),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

class _StageChips extends StatelessWidget {
  const _StageChips({required this.stage, required this.narrowEnabled, required this.onTap});

  final _Stage stage;
  final bool narrowEnabled;
  final ValueChanged<_Stage> onTap;

  @override
  Widget build(BuildContext context) {
    const names = ['FIND', 'SWEEP', 'NARROW', 'CONFIRM'];
    return Row(
      children: [
        for (final s in _Stage.values)
          Expanded(
            child: GestureDetector(
              onTap: (s == _Stage.narrow && !narrowEnabled) ? null : () => onTap(s),
              child: Container(
                margin: EdgeInsets.only(right: s == _Stage.confirm ? 0 : 4.w),
                padding: EdgeInsets.symmetric(vertical: 8.h),
                alignment: Alignment.center,
                color: s == stage ? Colors.black : const Color(0xFFE2E7E7),
                child: Text(
                  names[s.index],
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 12.sp,
                    fontWeight: FontWeight.w900,
                    letterSpacing: 1,
                    color: s == stage
                        ? Colors.white
                        : (s == _Stage.narrow && !narrowEnabled ? AppColors.textMuted : AppColors.textMain),
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

class _StatusLine extends StatelessWidget {
  const _StatusLine({
    required this.scanning,
    required this.radioLive,
    required this.reading,
    required this.power,
    required this.connected,
  });

  final bool scanning;
  final ValueListenable<bool> radioLive;
  final ValueListenable<LocateReading> reading;
  final _Power power;
  final bool connected;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<LocateReading>(
      valueListenable: reading,
      builder: (_, r, __) {
        String text;
        Color color;
        if (!scanning) {
          text = connected ? 'PAUSED — pull the trigger to search' : 'READER NOT CONNECTED';
          color = connected ? AppColors.textMuted : const Color(0xFFBF2E2E);
        } else if (power == _Power.adjusting) {
          text = 'ADJUSTING RANGE…';
          color = const Color(0xFF334466);
        } else {
          switch (r.presence) {
            case LocatePresence.searching:
              text = 'SEARCHING — target not detected';
              color = AppColors.textMain;
            case LocatePresence.detectedNoStrength:
              text = 'TARGET DETECTED — strength unavailable';
              color = AppColors.primary;
            case LocatePresence.detected:
              text = 'TARGET DETECTED';
              color = const Color(0xFF16A34A);
          }
        }
        return Row(
          children: [
            ValueListenableBuilder<bool>(
              valueListenable: radioLive,
              builder: (_, live, __) => Container(
                width: 12,
                height: 12,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: live ? const Color(0xFF16A34A) : const Color(0xFFBCC9C9),
                ),
              ),
            ),
            SizedBox(width: 8.w),
            Expanded(
              child: Text(
                text,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: GoogleFonts.spaceGrotesk(fontSize: 16.sp, fontWeight: FontWeight.w900, color: color),
              ),
            ),
          ],
        );
      },
    );
  }
}

/// Signal bar + a big moving line of the last 5 seconds. No numbers: higher
/// is stronger, not a distance.
class _SignalView extends StatelessWidget {
  const _SignalView({
    required this.proximity,
    required this.engine,
    required this.reading,
    required this.zebra,
  });

  final ValueListenable<double> proximity;
  final LocateEngine? engine;
  final ValueListenable<LocateReading> reading;
  final bool zebra;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(zebra ? 'ZEBRA PROXIMITY' : 'SIGNAL', style: _label()),
        SizedBox(height: 4.h),
        SizedBox(
          height: 30,
          child: ValueListenableBuilder<double>(
            valueListenable: proximity,
            builder: (_, p, __) => Stack(
              children: [
                Container(color: const Color(0xFFE2E7E7)),
                FractionallySizedBox(
                  widthFactor: p.clamp(0.0, 1.0),
                  child: Container(color: AppColors.primary),
                ),
              ],
            ),
          ),
        ),
        SizedBox(height: 8.h),
        ValueListenableBuilder<LocateReading>(
          valueListenable: reading,
          builder: (_, __, ___) => SizedBox(
            height: 150,
            child: CustomPaint(
              painter: _HistoryPainter(List.of(engine?.history ?? const <(int, double?)>[])),
              size: Size.infinite,
            ),
          ),
        ),
        SizedBox(height: 4.h),
        Text(
          zebra
              ? 'Zebra\'s relative value — higher is closer. Not a distance.'
              : 'Signal strength at the current range — higher is stronger. Not a distance.',
          textAlign: TextAlign.center,
          style: GoogleFonts.manrope(fontSize: 11.sp, color: AppColors.textMuted, fontWeight: FontWeight.w600),
        ),
      ],
    );
  }
}

class _HistoryPainter extends CustomPainter {
  _HistoryPainter(this.points);

  final List<(int, double?)> points;

  @override
  void paint(Canvas canvas, Size size) {
    final bg = Paint()..color = const Color(0xFFF0F5F4);
    canvas.drawRect(Offset.zero & size, bg);
    if (points.length < 2) return;
    final t1 = points.last.$1;
    final t0 = t1 - 5000;
    final line = Paint()
      ..color = AppColors.primary
      ..strokeWidth = 4
      ..strokeJoin = StrokeJoin.round
      ..style = PaintingStyle.stroke;
    final fill = Paint()..color = AppColors.primary.withValues(alpha: 0.16);
    Path? path;
    double startX = 0;
    double lastX = 0;
    void flush() {
      final p = path;
      if (p == null) return;
      // Shade under the line so the level reads at a glance.
      final area = Path.from(p)
        ..lineTo(lastX, size.height)
        ..lineTo(startX, size.height)
        ..close();
      canvas.drawPath(area, fill);
      canvas.drawPath(p, line);
    }
    for (final p in points) {
      final x = ((p.$1 - t0) / 5000.0) * size.width;
      if (p.$2 == null) {
        flush();
        path = null;
        continue;
      }
      final y = size.height - p.$2!.clamp(0.0, 1.0) * (size.height - 6) - 3;
      if (path == null) {
        path = Path()..moveTo(x, y);
        startX = x;
      } else {
        path.lineTo(x, y);
      }
      lastX = x;
    }
    flush();
  }

  @override
  bool shouldRepaint(covariant _HistoryPainter old) => true;
}

class _PowerLine extends StatelessWidget {
  const _PowerLine({required this.state, required this.dbm, required this.minDbm, required this.zebra});

  final _Power state;
  final int dbm;
  final int? minDbm;
  final bool zebra;

  @override
  Widget build(BuildContext context) {
    String text;
    switch (state) {
      case _Power.unknown:
        text = 'RANGE: set when you start';
      case _Power.adjusting:
        text = 'RANGE: adjusting…';
      case _Power.confirmed:
        text = 'RANGE: $dbm dBm (confirmed by the reader)';
      case _Power.fixed:
        text = zebra
            ? 'RANGE: managed by Zebra Locate'
            : 'RANGE: $dbm dBm fixed — this reader cannot confirm changes, narrowing is off';
    }
    return Text(
      minDbm == null ? text : '$text · lowest heard $minDbm dBm',
      maxLines: 2,
      overflow: TextOverflow.ellipsis,
      style: GoogleFonts.spaceGrotesk(fontSize: 13.sp, fontWeight: FontWeight.w800, color: Colors.black),
    );
  }
}

class _SweepPanel extends StatelessWidget {
  const _SweepPanel({required this.view, required this.sweep, required this.scanning});

  final ValueListenable<SweepResult> view;
  final SweepEstimator sweep;
  final bool scanning;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<SweepResult>(
      valueListenable: view,
      builder: (_, res, __) {
        final words = !scanning ? 'Start scanning, stand still, then sweep.' : res.instruction(sweep.relativeHeading);
        return Container(
          padding: EdgeInsets.all(12.r),
          color: const Color(0xFFF0F5F4),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('SWEEP — keep your feet in one place', style: _label()),
              SizedBox(height: 6.h),
              Text(
                words,
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 20.sp,
                  fontWeight: FontWeight.w900,
                  color: res.status == SweepStatus.found ? const Color(0xFF16A34A) : Colors.black,
                ),
              ),
              Opacity(
                opacity: scanning && sweep.turningTooFast ? 1 : 0,
                child: Text('Slower — too fast to read', style: GoogleFonts.manrope(fontSize: 13.sp, fontWeight: FontWeight.w800, color: const Color(0xFFBF2E2E))),
              ),
              SizedBox(height: 8.h),
              SizedBox(
                height: 90,
                child: CustomPaint(
                  painter: _SweepPainter(
                    covered: Set.of(sweep.covered),
                    best: res.status == SweepStatus.found ? res.bestRelativeDeg : null,
                    heading: sweep.relativeHeading,
                  ),
                  size: Size.infinite,
                ),
              ),
              Text(
                'Moved to a new spot? Tap SWEEP again to start fresh — the old reading does not carry over.',
                style: GoogleFonts.manrope(fontSize: 11.sp, color: AppColors.textMuted, fontWeight: FontWeight.w600),
              ),
            ],
          ),
        );
      },
    );
  }
}

/// Half-dial: covered 30° sectors (grey), the agreed strongest sector (green),
/// and where the reader points now (black line). Left is left.
class _SweepPainter extends CustomPainter {
  _SweepPainter({required this.covered, required this.best, required this.heading});

  final Set<int> covered;
  final double? best;
  final double? heading;

  @override
  void paint(Canvas canvas, Size size) {
    final c = Offset(size.width / 2, size.height - 4);
    final r = math.min(size.width / 2, size.height) - 6;
    final rect = Rect.fromCircle(center: c, radius: r);
    double toRad(double deg) => (-90 + deg) * math.pi / 180; // 0° = up
    final base = Paint()..color = const Color(0xFFE2E7E7);
    canvas.drawArc(rect, math.pi, math.pi, true, base);
    final cov = Paint()..color = const Color(0xFFBCC9C9);
    for (final s in covered) {
      final a0 = s * 30.0;
      if (a0 < -90 || a0 >= 90) continue;
      canvas.drawArc(rect, toRad(a0), 30 * math.pi / 180, true, cov);
    }
    if (best != null && best! >= -90 && best! <= 90) {
      final g = Paint()..color = const Color(0xFF16A34A);
      canvas.drawArc(rect, toRad(best! - 15), 30 * math.pi / 180, true, g);
    }
    if (heading != null) {
      final h = heading!.clamp(-90.0, 90.0);
      final p = Paint()
        ..color = Colors.black
        ..strokeWidth = 3;
      canvas.drawLine(c, c + Offset(math.cos(toRad(h)) * r, math.sin(toRad(h)) * r), p);
    }
  }

  @override
  bool shouldRepaint(covariant _SweepPainter old) => true;
}

class _Notice extends StatelessWidget {
  const _Notice(this.text, {this.error = false});

  final String text;
  final bool error;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: EdgeInsets.symmetric(horizontal: 12.w, vertical: 8.h),
      color: error ? const Color(0xFFFFF4F4) : const Color(0xFFF0F5F4),
      child: Text(
        text,
        style: GoogleFonts.manrope(
          fontSize: 14.sp,
          fontWeight: FontWeight.w800,
          color: error ? const Color(0xFFBF2E2E) : Colors.black,
        ),
      ),
    );
  }
}

class _ActionButton extends StatelessWidget {
  const _ActionButton({
    required this.label,
    required this.icon,
    required this.onPressed,
    this.secondary = false,
    this.big = false,
  });

  final String label;
  final IconData icon;
  final VoidCallback? onPressed;
  final bool secondary;
  final bool big;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: big ? 60 : 48,
      child: FilledButton.icon(
        onPressed: onPressed,
        icon: Icon(icon, size: big ? 24 : 18),
        label: Text(
          label,
          textAlign: TextAlign.center,
          style: GoogleFonts.spaceGrotesk(fontSize: big ? 17.sp : 13.sp, fontWeight: FontWeight.w900, letterSpacing: 0.8),
        ),
        style: FilledButton.styleFrom(
          backgroundColor: secondary ? const Color(0xFF2BA3A3) : AppColors.primary,
          foregroundColor: Colors.white,
          disabledBackgroundColor: const Color(0xFFBCC9C9),
          shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
        ),
      ),
    );
  }
}

class _Details extends StatelessWidget {
  const _Details({
    required this.engine,
    required this.reading,
    required this.caps,
    required this.powerDbm,
    required this.powerState,
    required this.onUseClassic,
    required this.beepsPlayed,
  });

  final int Function() beepsPlayed;
  final LocateEngine? engine;
  final ValueListenable<LocateReading> reading;
  final LocateReaderCaps caps;
  final int powerDbm;
  final _Power powerState;
  final VoidCallback onUseClassic;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<LocateReading>(
      valueListenable: reading,
      builder: (_, r, __) {
        final e = engine;
        final rows = <(String, String)>[
          ('Followed EPC', r.followedEpc ?? '—'),
          ('Median RSSI', r.medianRssi == null ? '—' : '${r.medianRssi} dBm'),
          ('Reads / s', '${r.readsPerSec}'),
          ('Steady windows', '${r.windowsHit} / 4'),
          ('Last heard', r.lastSeenAgeMs == null ? '—' : '${r.lastSeenAgeMs} ms ago'),
          ('Power', '$powerDbm dBm (${powerState.name})'),
          ('Accepted generation', '${e?.acceptGeneration ?? '—'}'),
          ('Target reads / no-RSSI', '${e?.targetReads ?? 0} / ${e?.nullRssiTargetReads ?? 0}'),
          ('Other tags / stale dropped', '${e?.otherTagReads ?? 0} / ${e?.staleDropped ?? 0}'),
          ('ID format errors', '${e?.formatErrors ?? 0}'),
          ('Zebra proximity reads', '${e?.locReads ?? 0}'),
          ('Beeps played', '${beepsPlayed()}'),
          ('Reader', '${caps.model ?? '—'} · fw ${caps.firmware ?? '—'}'),
          ('Zebra Locate supported', caps.locationingSupported ? 'yes' : 'no'),
          ('Power steps', caps.powerLevelsDbm.isEmpty ? '—' : '${caps.powerLevelsDbm.first}–${caps.powerLevelsDbm.last} dBm'),
        ];
        return Container(
          color: const Color(0xFFF7F7F7),
          padding: EdgeInsets.all(12.r),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (final row in rows)
                Padding(
                  padding: EdgeInsets.symmetric(vertical: 2.h),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      SizedBox(width: 150.w, child: Text(row.$1, style: _label())),
                      Expanded(child: SelectableText(row.$2, style: GoogleFonts.robotoMono(fontSize: 12.sp, fontWeight: FontWeight.w700))),
                    ],
                  ),
                ),
              if ((e?.formatErrors ?? 0) > 0)
                const Padding(
                  padding: EdgeInsets.only(top: 6),
                  child: _Notice('The reader is sending tag ids that are not clean 24-character EPCs — they are ignored, not guessed. Report this if the item cannot be found.', error: true),
                ),
              SizedBox(height: 8.h),
              _ActionButton(label: 'USE CLASSIC LOCATE ON THIS HANDHELD', icon: Icons.history, secondary: true, onPressed: onUseClassic),
            ],
          ),
        );
      },
    );
  }
}
