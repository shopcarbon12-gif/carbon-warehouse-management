import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart' show ValueListenable;
import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/services/handheld_runtime_config.dart'
    show kAntennaPowerDbmMax;
import 'package:carbon_wms/services/mobile_permissions.dart';
import 'package:carbon_wms/services/scan_sounds.dart';
import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/hardware/rfid_tag_read.dart';
import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/guards/permission_guard.dart';
import 'package:carbon_wms/ui/screens/encode_screen.dart';
import 'package:carbon_wms/ui/screens/search_and_encode_screen.dart';
import 'package:carbon_wms/ui/screens/status_change_screen.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';
import 'package:carbon_wms/ui/widgets/rfid_power_slider.dart';

/// Map RSSI (dBm) to 0–1 proximity, calibrated to the actual values the
/// SA-2000 + Chainway/Zebra UHF reads in this warehouse. The previous
/// theoretical range (-90 → -30) made the bar feel dead because real
/// "close" reads sit around -50 to -55 dBm, not -30. With the new
/// window:
///   -80 dBm → 0%   (radio can hear it but the operator is far)
///   -45 dBm → 100% (right on top of the tag — saturates at 100)
/// Linear in between. Everything tighter than -45 still maps to 100,
/// which is what the operator wants — "I'm there" — instead of capping
/// at 50% because the room never gets closer to the theoretical -30.
///
/// **This window is only meaningful at the power it was calibrated at.** See
/// [powerNormalisedRssi] — always feed this a normalised value, never a raw
/// read, or the meter silently stops working below full power.
double rssiToProximity01(int? rssi) {
  if (rssi == null) return 0;
  const weak = -80.0;
  const strong = -45.0;
  return ((rssi - weak) / (strong - weak)).clamp(0.0, 1.0);
}

/// Shift a raw RSSI back onto the full-power reference the proximity window
/// above is calibrated against.
///
/// ## Why this is needed — the "geiger only works at 30 dBm" bug
///
/// Proximity was mapped from an ABSOLUTE dBm window (-80 → -45) that was
/// measured with the radio at full power. But for monostatic passive
/// backscatter the received signal is
///
///     P_rx(dBm) = P_tx(dBm) + K − 40·log10(distance)
///
/// — the tag has no transmitter of its own, so it re-radiates the carrier the
/// reader sent it. Turning the reader down by N dB therefore moves EVERY read
/// down by N dB, at every distance. Drop from 30 to 12 dBm and a tag that used
/// to read -50 dBm at arm's length now reads about -68: the same spot on the
/// floor that used to show 86% shows 34%, and nothing anywhere in the aisle can
/// reach 100% any more. The meter looked broken at anything other than the
/// power it happened to be calibrated at, which is exactly what the operator
/// reported.
///
/// Normalising by how far the radio is turned down from ITS OWN maximum
/// ([maxDbm], read from the reader's capabilities — 30 on RFD8500, 23 on the
/// C72E) makes the gradient identical at every power setting. At full power the
/// offset is zero, so the existing warehouse calibration is preserved exactly
/// on both handhelds and nothing about today's behaviour changes.
///
/// What legitimately still changes with power is REACH: at 10 dBm the tag stops
/// answering much sooner because it can't harvest enough energy to power up.
/// That is real physics and the right behaviour — lower power is how an
/// operator narrows a search down inside a dense bin.
int? powerNormalisedRssi(int? rssi, {required int powerDbm, required int maxDbm}) {
  if (rssi == null) return null;
  // Clamped so a bogus capability read can never blow the meter up to 100%.
  final offset = (maxDbm - powerDbm).clamp(0, 25);
  return rssi + offset;
}

/// Tap-to-locate Geiger screen.
///
/// Behaviour:
///   * **Pull the trigger to start**, pull again to stop.
///   * Closer to the target → faster beep cadence, louder, higher %.
///   * Out-of-range → decays to 0%, silence, idle motion only.
///
/// ## Why this screen is built the way it is (1.2.149 rework)
///
/// The complaint was "hot and cold should be instant, but it lags, stutters
/// and sometimes gets stuck". Four things were causing that, all fixed here:
///
///  1. **The read callback drove the UI directly.** On an RFD8500 with the
///     locate pre-filter + SESSION_S0 installed, a single tag in the field
///     reports 200-400 times per second — that is the whole point of the
///     filter. Every one of those reads called `setState()` (twice) and
///     kicked an `AnimationController.animateTo()`, rebuilding and
///     repainting a screen whose centrepiece is a blurred, shadowed,
///     sweep-gradient radar. The UI thread never got a clear frame, and the
///     beep timer — starved along with everything else — fired at whatever
///     cadence it could get, which is exactly the "beeping without logic"
///     the operator described. Reads now only write plain fields; a single
///     fixed-rate engine tick ([_tickMs]) does the signal processing and
///     publishes to [ValueNotifier]s that only small leaf widgets listen to.
///     Nothing above those leaves rebuilds while scanning.
///
///  2. **Every trigger pull re-pushed the whole radio config.** Filter,
///     singulation session and power were re-asserted on each `_startScan`
///     on the theory that "vendor-channel calls are idempotent, so
///     re-asserting is cheap". On an RFD8500 each of those is a real
///     Bluetooth round-trip to the sled, and they are serialised on the
///     controller's single executor — roughly 800 ms of SPP traffic between
///     the trigger pull and `Inventory.perform()`. The radio is now armed
///     ONCE ([_armRadio]) and a trigger pull does nothing but start
///     inventory. (The native side caches the same state, so a redundant
///     call is a no-op there too.)
///
///  3. **No re-entrancy guard on the toggle.** Two quick trigger pulls
///     interleaved `_startScan` and `_stopScan`, and because both await
///     platform calls the subscription and the `_scanning` flag could end up
///     disagreeing with the radio: reader streaming while the screen ignored
///     every read, or reader stopped while the screen said SCANNING. That is
///     the "gets stuck" report. [_toggleScan] is now guarded and debounced.
///
///  4. **Proximity decayed far too slowly.** 1300 ms of hold followed by a
///     15%-per-150 ms ramp meant ~2.7 s to fall from 100% to zero. In a
///     hot/cold game the operator sweeps past the tag and the meter is still
///     showing "hot" a full second later, which reads as lag even when the
///     radio is perfect. Now: [_holdMs] grace, then a time-based exponential
///     with a [_decayTauMs] constant — about a second from pinned to cold.
class LocateTagScreen extends StatefulWidget {
  const LocateTagScreen({
    super.key,
    this.targetEpc,
    this.targetBin,
    this.targetSku,
    this.targetName,
    this.targetColor,
    this.targetSize,
    this.targetPriceText,
    this.cloudGeigerMode = false,
  });

  final String? targetEpc;
  final String? targetBin;

  // Optional item-detail context for the operator. When supplied, an extra
  // container is rendered above the EPC strip (matching the Count screen's
  // row rhythm) so the operator can confirm they're hunting the right item.
  // Pre-1.2.41 the locate screen showed only the raw EPC, which forced the
  // operator to mentally cross-reference the catalog mid-sweep.
  final String? targetSku;
  final String? targetName;
  final String? targetColor;
  final String? targetSize;
  final String? targetPriceText;

  /// True when launched from the Cloud+Geiger screen for a specific EPC.
  /// Enables the "TAKE AN ACTION" button above the trigger affordance
  /// (visible only while NOT scanning) which routes to Status Change /
  /// Encode / Re-encode for that tag.
  final bool cloudGeigerMode;

  @override
  State<LocateTagScreen> createState() => _LocateTagScreenState();
}

/// Immutable snapshot of the diagnostic counters, published at a low rate so
/// the debug banner never drags the proximity engine down with it.
class _Diag {
  const _Diag({
    this.targetReads = 0,
    this.otherReads = 0,
    this.nullRssiReads = 0,
    this.readsPerSec = 0,
    this.powerOffsetDb = 0,
    this.lastSeenEpcs = const <String>[],
    this.lastSeenRssi,
    this.otherEpc,
    this.otherRssi,
    this.otherFresh = false,
  });

  final int targetReads;
  final int otherReads;
  final int nullRssiReads;
  final int readsPerSec;

  /// dB the proximity maths adds to each raw read to compensate for the radio
  /// running below its maximum. 0 at full power.
  final int powerOffsetDb;
  final List<String> lastSeenEpcs;
  final int? lastSeenRssi;
  final String? otherEpc;
  final int? otherRssi;
  final bool otherFresh;
}

class _LocateTagScreenState extends State<LocateTagScreen>
    with SingleTickerProviderStateMixin {
  static final RegExp _epc24 = RegExp(r'^[0-9A-F]{24}$');

  // ── Engine tuning ─────────────────────────────────────────────────────────
  /// Signal-processing / UI-publish rate. 30 Hz is smooth to the eye and
  /// gives ~33 ms beep-cadence granularity, while being ~10x less work than
  /// the old "rebuild on every read" behaviour at RFD8500 read rates.
  static const int _tickMs = 33;

  /// Grace period after the last target read before proximity starts falling.
  /// Covers the natural read gap when the antenna goes momentarily off-axis
  /// without letting a genuine walk-away sit at "hot".
  static const int _holdMs = 220;

  /// Exponential decay time constant once the grace period lapses.
  /// ~1 s from pinned to effectively cold.
  static const double _decayTauMs = 320;

  /// Beep interval at zero proximity / at full proximity (ms). Interpolated
  /// geometrically, so the cadence accelerates smoothly and continuously
  /// across the WHOLE range instead of the old two-segment ramp that only
  /// spanned 1.1 → 2.9 Hz below 90%.
  static const double _beepSlowMs = 650;
  static const double _beepFastMs = 45;

  /// Default locate power. Held as a session override on [RfidManager] so a
  /// settings sync can't quietly stomp it back to the global config power
  /// mid-sweep (which stopped and restarted the radio, freezing the meter).
  static const int _defaultPowerDbm = 30;

  RfidManager? _rfid;
  StreamSubscription<RfidTagRead>? _readSub;
  StreamSubscription<String>? _triggerSub;
  Timer? _engine;

  late final AnimationController _sweep; // radar rotation

  // ── Published UI state — only leaf widgets listen to these ────────────────
  final ValueNotifier<double> _proximity = ValueNotifier<double>(0);
  final ValueNotifier<int?> _rssiOut = ValueNotifier<int?>(null);
  final ValueNotifier<_Diag> _diag = ValueNotifier<_Diag>(const _Diag());

  /// Coarse state that genuinely changes the layout. setState is fine here —
  /// it fires at most once per trigger pull.
  bool _scanning = false;

  /// Re-entrancy guard for [_toggleScan]. Start/stop both await platform
  /// calls; without this a second trigger pull could interleave them.
  bool _busy = false;
  DateTime _lastToggleAt = DateTime.fromMillisecondsSinceEpoch(0);

  /// True once filter + session + power have been pushed to the radio for
  /// this screen. Reset by [_showActionPicker]'s hand-off, which deliberately
  /// tears that config down for the destination screen.
  bool _radioArmed = false;

  int _powerDbm = _defaultPowerDbm;

  /// The radio's own ceiling, read from its capabilities (30 dBm on RFD8500,
  /// 23 on the C72E). Proximity is normalised against this so the meter reads
  /// the same at every slider position — see [powerNormalisedRssi]. Seeded
  /// optimistically at 30 so the very first reads before the capability query
  /// lands behave exactly as they did before.
  int _maxPowerDbm = _defaultPowerDbm;

  /// dB the radio is currently turned down from [_maxPowerDbm]. Recomputed
  /// whenever either side changes; surfaced in the diagnostic banner so a
  /// "-68 dBm but the dial says 86%" reading is explainable on the floor.
  int get _powerOffsetDb =>
      (_maxPowerDbm - math.min(_powerDbm, _maxPowerDbm)).clamp(0, 25).toInt();

  // ── Hot-path fields — written by the read callback, read by the engine.
  //    Never touched by build(), never wrapped in setState. ─────────────────
  /// Strongest RSSI seen for the target inside the current engine window.
  /// Peak (not mean) is deliberate: multipath in a racking aisle causes
  /// *fades*, not gains, so the strongest read in a 33 ms window is the
  /// honest distance estimate and the dips are the artefact.
  int? _windowPeakRssi;
  int _windowReads = 0;
  int _readsPerSec = 0;
  int _rateAccum = 0;
  int _rateTicks = 0;

  int _targetReads = 0;
  int _otherReads = 0;
  int _nullRssiReads = 0;
  int? _lastRssi;
  DateTime? _lastTargetReadAt;

  /// Engine-owned smoothed proximity. [_proximity] mirrors it at tick rate.
  double _prox = 0;

  String? _otherEpc;
  int? _otherRssi;
  DateTime? _otherSeenAt;
  final List<String> _lastSeenEpcs = <String>[];
  int? _lastSeenRssi;
  bool _diagDirty = false;
  int _diagTickCounter = 0;

  DateTime _lastBeepAt = DateTime.fromMillisecondsSinceEpoch(0);

  String get _epcUpper => (widget.targetEpc ?? '').trim().toUpperCase();
  bool get _epcValid => _epc24.hasMatch(_epcUpper);

  @override
  void initState() {
    super.initState();
    _sweep = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 2200),
    );
    unawaited(ScanSounds.instance.init());
    // Silence the native per-tag-read beep that ScanSoundPool fires from
    // inside the controllers' emit path. Without this, every tag in the
    // field beeps — at close range on a filtered RFD8500 that is hundreds of
    // beeps a second, which completely swamps the proximity cadence that is
    // the actual signal. Restored on dispose so Count / Status Change /
    // Encode keep their per-tag beep.
    unawaited(ScanSounds.instance.setTagBeepSuppressed(true));
    // Lock the device to RFID-only mode on entry. Geiger search uses 2D; when
    // the operator picks a result and lands here we must flip the trigger back
    // to UHF and physically close the 2D engine on Chainway so a stray laser
    // can't fire mid-sweep. Both calls are no-ops on the native side when the
    // radio is already in the requested mode.
    unawaited(RfidVendorChannel.setZebraTriggerModeRfid());
    unawaited(RfidVendorChannel.enableRfidFunctionMode());
    unawaited(RfidVendorChannel.close2dBarcode());
    // Arm the radio once, here — NOT on every trigger pull. See the class doc.
    unawaited(_armRadio());
    // Learn the radio's real power ceiling so proximity can be normalised
    // against it at any slider position.
    unawaited(_loadPowerRange());
    // Subscribe to the physical trigger immediately on entry so the very
    // first pull lights up the locate flow — count_inventory_screen does
    // the same. Trigger 'down' is the only thing we care about; 'up' is
    // ignored (the locate UX is press-to-toggle, not press-and-hold).
    _triggerSub = RfidVendorChannel.hardwareTriggerStream().listen((event) {
      if (!mounted) return;
      if (event == 'down') {
        unawaited(_toggleScan());
      }
    }, onError: (_) {});
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_rfid == null) {
      final m = context.read<RfidManager>();
      _rfid = m;
      // Claim the power BEFORE switching scan context. The context setter
      // triggers reapplyHandheldHardwareSettings(), which honours the session
      // override when one is set — so claiming first means the radio takes a
      // single power write instead of "config power, then locate power".
      unawaited(m.setSessionPowerOverrideDbm(_powerDbm));
      m.scanContext = 'GEIGER_FIND';
    }
  }

  @override
  void dispose() {
    // Close the read path first. A tag event already queued on the platform
    // channel can still be delivered after cancel(), and _onGeigerRead only
    // touches plain fields — but flipping this makes it an explicit no-op
    // rather than something that happens to be harmless.
    _scanning = false;
    _engine?.cancel();
    _sweep.dispose();
    unawaited(_readSub?.cancel());
    unawaited(_triggerSub?.cancel());
    // Stop the radio through every path. Backing out of the screen while
    // scanning must never leave the sled transmitting for the next screen.
    unawaited(RfidVendorChannel.stopZebraInventory());
    unawaited(RfidVendorChannel.stopChainwayInventory());
    unawaited(_rfid?.stopLocateScanning());
    // Release the locate power claim so the next screen inherits the global
    // handheld-config power again.
    unawaited(_rfid?.setSessionPowerOverrideDbm(null));
    // Clear the target-EPC pre-filter so the next screen's inventory
    // sees the full field again.
    unawaited(RfidVendorChannel.setEpcInventoryFilter(null));
    // Restore inventory session back to S1 so the next screen's multi-tag
    // passes (count, transfer, etc.) get the throughput they expect — S0
    // floods the read pipe with re-reads of every visible tag, which is the
    // right thing for locate but wrong for inventory.
    unawaited(RfidVendorChannel.setSingulationSession(useSessionZero: false));
    // Restore the per-tag native beep so Count / Status Change / etc.
    // get their feedback back on the next screen.
    unawaited(ScanSounds.instance.setTagBeepSuppressed(false));
    // Re-open the 2D engine so the next screen (which may need barcode
    // scanning) doesn't inherit a powered-off imager.
    unawaited(RfidVendorChannel.open2dBarcode());
    _proximity.dispose();
    _rssiOut.dispose();
    _diag.dispose();
    super.dispose();
  }

  /// Ask the connected radio what it can actually transmit. RFD8500 reports
  /// 30 dBm, the C72E is hard-capped at 23. Retried a couple of times because
  /// the query returns null until the reader link is up, and we enter this
  /// screen straight off a navigation.
  Future<void> _loadPowerRange() async {
    for (var attempt = 0; attempt < 3; attempt++) {
      if (!mounted) return;
      final range = await RfidVendorChannel.getPowerRangeDbm();
      if (range != null) {
        final max = range.maxDbm.clamp(5, kAntennaPowerDbmMax);
        _maxPowerDbm = max;
        // The native controllers clamp internally, so a slider sitting above
        // the radio's ceiling means the radio is really at the ceiling. Track
        // that or the normalisation offset would be computed against a power
        // the hardware never used.
        if (_powerDbm > max) _powerDbm = max;
        return;
      }
      await Future<void>.delayed(const Duration(milliseconds: 400));
    }
  }

  // ── Radio arming ─────────────────────────────────────────────────────────

  /// Push the locate-specific radio configuration. Called once on entry and
  /// again only if [_showActionPicker]'s hand-off tore it down.
  ///
  /// Ordering matters and is preserved by the native single-thread executor:
  /// pre-filter first (so the radio knows which tag it cares about), then the
  /// session flip, then inventory start from [_startScan].
  Future<void> _armRadio() async {
    if (_radioArmed) return;
    _radioArmed = true;
    final target = _epcUpper;
    if (_epc24.hasMatch(target)) {
      // Gate inventory to the target EPC. Without this the radio's per-cycle
      // time slots are shared across every tag in range — in a bin area with
      // hundreds of tags the target gets a handful of reads per second and
      // wildly variable RSSI (multipath from competing responses). With the
      // filter the radio spends all its slots on the target: dense reads,
      // stable RSSI, distance-honest proximity.
      await RfidVendorChannel.setEpcInventoryFilter(target);
    }
    // SESSION_S0 so the target re-responds on every inventory round. Under
    // the default S1 the tag falls silent for seconds after its first reply,
    // and the meter sagged from 100 → 80 → 64 → 51 while the operator stood
    // perfectly still on top of the tag.
    await RfidVendorChannel.setSingulationSession(useSessionZero: true);
    await ScanSounds.instance.setTagBeepSuppressed(true);
  }

  /// Apply a new transmit power. Two things have to happen beyond pushing the
  /// value: the proximity normalisation has to learn the new offset (so the
  /// meter keeps the same gradient at the new power), and the radio has to be
  /// confirmed still streaming.
  ///
  /// That second part matters because the RFD8500 rejects
  /// `setAntennaRfConfig` while inventory is running, so the native controller
  /// does stop → apply → `resumeInventoryWithRetry`. If every resume attempt
  /// lands inside the sled's settle window the retry gives up, leaving
  /// `inventoryActive=false` while this screen still says SCANNING — a dead
  /// meter that looks exactly like "the geiger doesn't work at this dBm".
  /// Re-issuing the start is a no-op when the resume succeeded and a clean
  /// recovery when it didn't.
  void _onPowerCommitted(int dbm) {
    _powerDbm = dbm.clamp(1, _maxPowerDbm);
    unawaited(() async {
      await _rfid?.setSessionPowerOverrideDbm(dbm);
      if (!mounted || !_scanning) return;
      try {
        await RfidVendorChannel.startZebraInventory();
      } catch (_) {}
      try {
        await RfidVendorChannel.startChainwayInventory();
      } catch (_) {}
    }());
  }

  // ── Toggle scan ──────────────────────────────────────────────────────────

  Future<void> _toggleScan() async {
    // Guard against re-entrancy AND against the sled's trigger repeating.
    // Both start and stop await platform calls; letting a second pull in
    // mid-flight is what left the radio and the screen disagreeing.
    if (_busy) return;
    final now = DateTime.now();
    if (now.difference(_lastToggleAt).inMilliseconds < 250) return;
    _lastToggleAt = now;
    _busy = true;
    try {
      if (_scanning) {
        await _stopScan();
      } else {
        await _startScan();
      }
    } finally {
      _busy = false;
    }
  }

  void _resetSignal() {
    _windowPeakRssi = null;
    _windowReads = 0;
    _readsPerSec = 0;
    _rateAccum = 0;
    _rateTicks = 0;
    _targetReads = 0;
    _otherReads = 0;
    _nullRssiReads = 0;
    _lastRssi = null;
    _lastTargetReadAt = null;
    _prox = 0;
    _otherEpc = null;
    _otherRssi = null;
    _otherSeenAt = null;
    _lastSeenEpcs.clear();
    _lastSeenRssi = null;
    _diagDirty = false;
    _diagTickCounter = 0;
    _lastBeepAt = DateTime.fromMillisecondsSinceEpoch(0);
    _proximity.value = 0;
    _rssiOut.value = null;
    _diag.value = const _Diag();
  }

  Future<void> _startScan() async {
    final m = _rfid;
    if (m == null || !_epcValid) return;
    ScanSounds.instance.play(ScanCue.start);
    _resetSignal();
    setState(() => _scanning = true);
    _sweep
      ..reset()
      ..repeat();

    // Subscribe to the RAW vendor tag stream. The manager path goes through
    // `_active.startScanning`, which silently fails when the manager's
    // active-driver state is out of sync with the actual sled (seen after the
    // encode screen drove the radio via RfidVendorChannel directly). Listening
    // to the vendor stream guarantees reads reach _onGeigerRead regardless.
    await _readSub?.cancel();
    _readSub =
        RfidVendorChannel.tagReadStream().listen(_onGeigerRead, onError: (_) {});

    // Only re-arms if the action-picker hand-off cleared the config; a normal
    // trigger pull skips straight past this.
    await _armRadio();

    _startEngine();

    // Start via BOTH vendor paths plus the manager. All three are cheap
    // no-ops on the native side once inventory is already streaming, and the
    // manager path keeps its internal state consistent for other screens.
    // Wrapped individually: on a Zebra-only host `startChainwayInventory`
    // resolves to a native no-op, and on a Chainway-only host
    // `startZebraInventory` rejects with NOT_CONNECTED — neither should
    // surface as an unhandled async error.
    try {
      await RfidVendorChannel.startZebraInventory();
    } catch (_) {}
    try {
      await RfidVendorChannel.startChainwayInventory();
    } catch (_) {}
    await m.startLocateScanning();
  }

  Future<void> _stopScan() async {
    ScanSounds.instance.play(ScanCue.stop);
    _engine?.cancel();
    _engine = null;
    _sweep.stop();
    await _readSub?.cancel();
    _readSub = null;
    try {
      await RfidVendorChannel.stopZebraInventory();
    } catch (_) {}
    try {
      await RfidVendorChannel.stopChainwayInventory();
    } catch (_) {}
    await _rfid?.stopLocateScanning();
    if (!mounted) return;
    setState(() => _scanning = false);
    _prox = 0;
    _lastTargetReadAt = null;
    _proximity.value = 0;
    _rssiOut.value = null;
  }

  // ── Read path ────────────────────────────────────────────────────────────
  // Runs up to several hundred times per second. It must stay allocation-free
  // and must never touch setState, an AnimationController, or the logger.

  void _onGeigerRead(RfidTagRead read) {
    if (!_scanning) return;
    final epc = read.epcHex24;
    // Treat a zero / positive / absurd RSSI as "not reported". A literal 0 is
    // otherwise read as an extremely strong signal and saturates the meter at
    // 100% regardless of distance.
    var rssi = read.rssi;
    if (rssi != null && (rssi >= 0 || rssi <= -110)) rssi = null;

    if (_lastSeenEpcs.isEmpty || _lastSeenEpcs.first != epc) {
      _lastSeenEpcs.insert(0, epc);
      if (_lastSeenEpcs.length > 3) _lastSeenEpcs.removeLast();
      _diagDirty = true;
    }
    if (rssi != null) _lastSeenRssi = rssi;

    if (_matchesTarget(epc)) {
      _targetReads++;
      _windowReads++;
      if (rssi == null) {
        _nullRssiReads++;
        // Keep the meter alive through a null-RSSI burst by reusing the last
        // real reading; -65 dBm (mid-range) only seeds the very first one.
        rssi = _lastRssi ?? -65;
      } else {
        _lastRssi = rssi;
      }
      final peak = _windowPeakRssi;
      if (peak == null || rssi > peak) _windowPeakRssi = rssi;
      _diagDirty = true;
      return;
    }

    _otherReads++;
    // Track the strongest non-target tag purely as a "radio is alive, wrong
    // tag in range" diagnostic. It never affects the percentage.
    if (rssi != null && rssi > (_otherRssi ?? -200)) {
      _otherEpc = epc;
      _otherRssi = rssi;
      _otherSeenAt = DateTime.now();
    }
    _diagDirty = true;
  }

  /// Match the live read EPC against the target. Exact equality first;
  /// if that fails, fall back to a suffix match on the last 16 hex
  /// chars (item + serial bits — the company-prefix bits sometimes
  /// arrive padded or shifted on different SDK versions, which is what
  /// kept biting earlier "% stays at 0" attempts). Both forms are
  /// uppercase + alphanumeric only.
  bool _matchesTarget(String observed) {
    if (observed == _epcUpper) return true;
    if (_epcUpper.length < 16 || observed.length < 16) return false;
    return observed.substring(observed.length - 16) ==
        _epcUpper.substring(_epcUpper.length - 16);
  }

  // ── Fixed-rate engine ────────────────────────────────────────────────────

  void _startEngine() {
    _engine?.cancel();
    _engine = Timer.periodic(
      const Duration(milliseconds: _tickMs),
      (_) => _engineTick(),
    );
  }

  void _engineTick() {
    if (!mounted || !_scanning) return;
    final now = DateTime.now();

    // 1. Fold this window's reads into the smoothed proximity.
    final peak = _windowPeakRssi;
    _windowPeakRssi = null;
    _rateAccum += _windowReads;
    _windowReads = 0;
    _rateTicks++;

    if (peak != null) {
      // Normalise to full power BEFORE mapping. Without this the meter only
      // works at the power the -80/-45 window was calibrated at; see
      // powerNormalisedRssi.
      final raw = rssiToProximity01(
        powerNormalisedRssi(peak, powerDbm: _powerDbm, maxDbm: _maxPowerDbm),
      );
      // Asymmetric EMA at a FIXED rate — the old version ran per read, so at
      // 300 reads/sec it converged in ~10 ms and the meter was effectively raw
      // (and jittery). Anchoring it to the tick makes the response time a real
      // constant: ~60 ms closing in, ~110 ms falling back.
      final alpha = raw >= _prox ? 0.55 : 0.30;
      _prox = (_prox + (raw - _prox) * alpha).clamp(0.0, 1.0);
      _lastTargetReadAt = now;
    } else {
      final last = _lastTargetReadAt;
      if (last == null) {
        _prox = 0;
      } else if (now.difference(last).inMilliseconds > _holdMs) {
        // Time-based exponential so the fall-off is identical regardless of
        // how punctual the timer is under load.
        _prox *= math.exp(-_tickMs / _decayTauMs);
        if (_prox < 0.02) _prox = 0;
      }
    }

    // 2. Proximity beep. Decided every tick against the CURRENT proximity, so
    //    closing in speeds the cadence up immediately instead of waiting out
    //    an interval that was computed when the operator was still far away.
    if (_prox > 0.02) {
      if (now.difference(_lastBeepAt).inMilliseconds >= _beepDelayMs(_prox)) {
        _playProximityBeep(_prox);
        _lastBeepAt = now;
      }
    }

    // 3. Publish. Each notifier only rebuilds its own leaf widget.
    if ((_proximity.value - _prox).abs() > 0.0005) _proximity.value = _prox;
    final outRssi = _prox <= 0 ? null : _lastRssi;
    if (_rssiOut.value != outRssi) _rssiOut.value = outRssi;

    // 4. Diagnostics at ~5 Hz — counters don't need frame-rate fidelity.
    _diagTickCounter++;
    if (_diagTickCounter >= 6) {
      final elapsedMs = _rateTicks * _tickMs;
      if (elapsedMs > 0) {
        _readsPerSec = (_rateAccum * 1000 / elapsedMs).round();
      }
      _rateAccum = 0;
      _rateTicks = 0;
      _diagTickCounter = 0;
      if (_diagDirty) {
        _diagDirty = false;
        final seenAt = _otherSeenAt;
        _diag.value = _Diag(
          targetReads: _targetReads,
          otherReads: _otherReads,
          nullRssiReads: _nullRssiReads,
          readsPerSec: _readsPerSec,
          powerOffsetDb: _powerOffsetDb,
          lastSeenEpcs: List<String>.unmodifiable(_lastSeenEpcs),
          lastSeenRssi: _lastSeenRssi,
          otherEpc: _otherEpc,
          otherRssi: _otherRssi,
          otherFresh: seenAt != null &&
              now.difference(seenAt) < const Duration(seconds: 5),
        );
      }
    }
  }

  /// Geometric cadence curve: `slow * (fast/slow)^p`. Unlike the old
  /// two-segment ramp (which only spanned 1.1 → 2.9 Hz across the entire
  /// lower 90% and then jumped), this accelerates continuously and
  /// perceptually evenly the whole way — 1.5 Hz at arm's length, ~6 Hz at
  /// half, ~22 Hz on top of the tag.
  int _beepDelayMs(double p) {
    final clamped = p.clamp(0.0, 1.0);
    return (_beepSlowMs * math.pow(_beepFastMs / _beepSlowMs, clamped))
        .round()
        .clamp(_beepFastMs.round(), _beepSlowMs.round());
  }

  /// Proximity beep routed through the native SoundPool (same path that
  /// already drives start/stop/success/error cues reliably). It is
  /// unaffected by `setTagBeepSuppressed`, which only gates the auto-beep the
  /// SDK fires per raw tag read.
  void _playProximityBeep(double proximity) {
    final volume = (0.40 + 0.60 * proximity).clamp(0.0, 1.0);
    ScanSounds.instance.play(ScanCue.read, volume: volume);
  }

  /// Cloud+Geiger only — show a bottom sheet with the action choices
  /// (Status Change / Encode / Re-encode) and route to the picked screen.
  /// EPC stays on the Cloud+Geiger list; the operator decides what to do
  /// after taking the action.
  void _showActionPicker() {
    if (!mounted) return;

    // Hand the radio off to the next screen in a clean state. This screen
    // installs a single-EPC pre-filter, flips to SESSION_S0 and suppresses the
    // per-tag native beep — all correct for proximity work, all WRONG for a
    // screen the operator is about to scan many fresh tags on. Because we
    // navigate via Navigator.push, locate stays in the stack and its dispose()
    // doesn't run, so those settings would persist into Status Change / Encode
    // / Re-encode and silently filter inventory down to one tag.
    Future<void> handOffRadio() async {
      // Mark the radio as no longer ours, so coming back and pulling the
      // trigger re-arms it instead of scanning with no filter and S1.
      _radioArmed = false;
      try {
        await RfidVendorChannel.stopChainwayInventory();
      } catch (_) {}
      try {
        await RfidVendorChannel.stopZebraInventory();
      } catch (_) {}
      try {
        await RfidVendorChannel.setEpcInventoryFilter(null);
      } catch (_) {}
      try {
        await RfidVendorChannel.setSingulationSession(useSessionZero: false);
      } catch (_) {}
      try {
        await ScanSounds.instance.setTagBeepSuppressed(false);
      } catch (_) {}
    }

    showModalBottomSheet<void>(
      context: context,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (sheetCtx) {
        Widget tile({
          required IconData icon,
          required String label,
          required VoidCallback onTap,
        }) {
          return InkWell(
            onTap: onTap,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 18),
              child: Row(
                children: [
                  Icon(icon, size: 24, color: AppColors.primary),
                  const SizedBox(width: 14),
                  Text(
                    label,
                    style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w700,
                      color: Color(0xFF171D1D),
                    ),
                  ),
                ],
              ),
            ),
          );
        }

        return SafeArea(
          top: false,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Padding(
                padding: EdgeInsets.fromLTRB(20, 16, 20, 8),
                child: Text(
                  'TAKE AN ACTION',
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 1.6,
                    color: Color(0xFF6D7979),
                  ),
                ),
              ),
              // Phase 2 — drop tiles for actions the operator's role can't
              // open. context.read is safe inside the modal builder since
              // it doesn't subscribe to rebuilds.
              // Cloud + Geiger contract: when the operator opens an action
              // from here, the target EPC is the row that was sent to
              // them — we pass it down so the destination can call the
              // dismiss endpoint after the action completes, removing
              // the row from the Cloud + Geiger list across all devices.
              if (context.read<MobilePermissions>().canView(ScreenIds.statusChange)) ...[
                const Divider(height: 1),
                tile(
                  icon: Icons.swap_horiz,
                  label: 'Status change',
                  onTap: () async {
                    Navigator.of(sheetCtx).pop();
                    await handOffRadio();
                    if (!mounted) return;
                    await context.pushGuarded<void>(
                      ScreenIds.statusChange,
                      (_) => StatusChangeScreen(
                        cloudGeigerResolveEpc:
                            widget.cloudGeigerMode ? _epcUpper : null,
                      ),
                    );
                  },
                ),
              ],
              if (context.read<MobilePermissions>().canView(ScreenIds.encode)) ...[
                const Divider(height: 1),
                tile(
                  icon: Icons.tag,
                  label: 'Encode',
                  onTap: () async {
                    Navigator.of(sheetCtx).pop();
                    await handOffRadio();
                    if (!mounted) return;
                    await context.pushGuarded<void>(
                      ScreenIds.encode,
                      (_) => EncodeScreen(
                        cloudGeigerResolveEpc:
                            widget.cloudGeigerMode ? _epcUpper : null,
                      ),
                    );
                  },
                ),
              ],
              if (context.read<MobilePermissions>().canView(ScreenIds.searchAndEncode)) ...[
                const Divider(height: 1),
                tile(
                  icon: Icons.refresh,
                  label: 'Re-encode',
                  onTap: () async {
                    Navigator.of(sheetCtx).pop();
                    await handOffRadio();
                    if (!mounted) return;
                    await context.pushGuarded<void>(
                      ScreenIds.searchAndEncode,
                      (_) => SearchAndEncodeScreen(
                        cloudGeigerResolveEpc:
                            widget.cloudGeigerMode ? _epcUpper : null,
                      ),
                    );
                  },
                ),
              ],
              const SizedBox(height: 8),
            ],
          ),
        );
      },
    );
  }

  // ── UI ────────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final hasItemContext = (widget.targetSku?.isNotEmpty ?? false) ||
        (widget.targetName?.isNotEmpty ?? false) ||
        (widget.targetColor?.isNotEmpty ?? false) ||
        (widget.targetSize?.isNotEmpty ?? false) ||
        (widget.targetBin?.isNotEmpty ?? false);
    return CarbonScaffold(
      pageTitle: 'LOCATE TAG',
      body: SafeArea(
        top: false,
        child: Padding(
          padding: EdgeInsets.fromLTRB(24.w, 8.h, 24.w, 0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              SizedBox(height: 12.h),
              if (hasItemContext) ...[
                _ItemDetailsContainer(
                  sku: widget.targetSku,
                  name: widget.targetName,
                  color: widget.targetColor,
                  size: widget.targetSize,
                  priceText: widget.targetPriceText,
                  bin: widget.targetBin,
                ),
                SizedBox(height: 10.h),
              ],
              _HeaderRow(epc: _epcUpper),
              SizedBox(height: 16.h),
              _StatusBar(
                scanning: _scanning,
                rssi: _rssiOut,
                epcValid: _epcValid,
              ),
              SizedBox(height: 24.h),
              Expanded(
                child: Center(
                  child: RepaintBoundary(
                    child: _RadarVisualizer(
                      sweep: _sweep,
                      proximity: _proximity,
                      scanning: _scanning,
                    ),
                  ),
                ),
              ),
              _DiagnosticHint(scanning: _scanning, diag: _diag),
              if (_scanning)
                _LiveDiagnosticBanner(diag: _diag, targetEpc: _epcUpper),
              SizedBox(height: 12.h),
              // Cloud+Geiger mode only: "Take an action" routes the operator
              // straight from this located tag into Status Change / Encode /
              // Re-encode. Hidden while scanning so the trigger flow is
              // never ambiguous (and the operator can't accidentally tap
              // while the radio is sweeping).
              if (widget.cloudGeigerMode && !_scanning) ...[
                _TakeActionButton(onPressed: _showActionPicker),
                SizedBox(height: 8.h),
              ],
              _ToggleScanButton(
                scanning: _scanning,
                enabled: _epcValid,
                // The button is a real control now, not just a status strip.
                // It shares the guarded/debounced _toggleScan with the gun
                // trigger, so tapping and pulling do exactly the same thing
                // and can't fight each other.
                onPressed: _epcValid ? () => unawaited(_toggleScan()) : null,
              ),
              SizedBox(height: 8.h),
              RfidPowerSlider(
                defaultDbm: _defaultPowerDbm,
                // Route through the session override rather than pushing
                // straight to the radio, so a later settings sync can't
                // silently undo the operator's choice mid-sweep.
                onCommit: _onPowerCommitted,
              ),
              SizedBox(height: 4.h),
            ],
          ),
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Header — EPC
// ═══════════════════════════════════════════════════════════════════════════

class _HeaderRow extends StatelessWidget {
  const _HeaderRow({required this.epc});
  final String epc;

  @override
  Widget build(BuildContext context) {
    // BIN was previously rendered here; in 1.2.41 it moved into
    // [_ItemDetailsContainer] above so the EPC row stays a single
    // information stream (the radio-level identity of the tag).
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'EPC',
          style: GoogleFonts.spaceGrotesk(
            fontSize: 11.sp,
            fontWeight: FontWeight.w700,
            letterSpacing: 2.4,
            color: const Color(0xFF6D7979),
          ),
        ),
        SizedBox(height: 2.h),
        Text(
          epc.isEmpty ? '—' : epc,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: GoogleFonts.spaceGrotesk(
            fontSize: 18.sp,
            fontWeight: FontWeight.w700,
            letterSpacing: 0.5,
            color: AppColors.textMain,
          ),
        ),
      ],
    );
  }
}

/// Item-details container — placed above the EPC strip when item context
/// is supplied. Mirrors the visual rhythm of `_CountItemContainer`:
/// SKU + price on row 1, name · color · size on row 2, BIN as a teal
/// pill on the right. Renders with the same `0xFFECECEC` surface as the
/// Count rows so the operator's eye tracks consistently.
class _ItemDetailsContainer extends StatelessWidget {
  const _ItemDetailsContainer({
    required this.sku,
    required this.name,
    required this.color,
    required this.size,
    required this.priceText,
    required this.bin,
  });

  final String? sku;
  final String? name;
  final String? color;
  final String? size;
  final String? priceText;
  final String? bin;

  @override
  Widget build(BuildContext context) {
    final skuStr = (sku ?? '').trim();
    final nameStr = (name ?? '').trim();
    final colorStr = (color ?? '').trim();
    final sizeStr = (size ?? '').trim();
    final priceStr = (priceText ?? '').trim();
    final binStr = (bin ?? '').trim();

    final descBits = [
      if (nameStr.isNotEmpty) nameStr,
      if (colorStr.isNotEmpty) colorStr,
      if (sizeStr.isNotEmpty) sizeStr,
    ];
    final descLine = descBits.join(' · ');

    final skuStyle = GoogleFonts.robotoMono(
      fontSize: 17.sp,
      fontWeight: FontWeight.w700,
      color: AppColors.textMain,
      height: 1.2,
    );
    final descStyle = GoogleFonts.manrope(
      fontSize: 13.sp,
      fontWeight: FontWeight.w700,
      color: AppColors.textMain,
      height: 1.2,
    );
    final priceStyle = GoogleFonts.manrope(
      fontSize: 13.sp,
      fontWeight: FontWeight.w800,
      color: AppColors.textMain,
      height: 1.2,
    );
    final binLabelStyle = GoogleFonts.spaceGrotesk(
      fontSize: 10.sp,
      fontWeight: FontWeight.w700,
      letterSpacing: 1.6,
      color: Colors.white.withValues(alpha: 0.85),
      height: 1.0,
    );
    final binValueStyle = GoogleFonts.spaceGrotesk(
      fontSize: 18.sp,
      fontWeight: FontWeight.w800,
      color: Colors.white,
      height: 1.05,
    );

    return Material(
      color: const Color(0xFFECECEC),
      borderRadius: BorderRadius.zero,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.baseline,
                    textBaseline: TextBaseline.alphabetic,
                    children: [
                      Expanded(
                        child: Text(
                          skuStr.isEmpty ? 'SKU: —' : 'SKU: $skuStr',
                          style: skuStyle,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      if (priceStr.isNotEmpty) ...[
                        SizedBox(width: 8.w),
                        Text(priceStr, style: priceStyle),
                      ],
                    ],
                  ),
                  if (descLine.isNotEmpty) ...[
                    SizedBox(height: 3.h),
                    Text(
                      descLine,
                      style: descStyle,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ],
              ),
            ),
            SizedBox(width: 8.w),
            Container(
              padding:
                  EdgeInsets.symmetric(horizontal: 12.w, vertical: 6.h),
              color: AppColors.primary,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text('BIN', style: binLabelStyle),
                  SizedBox(height: 2.h),
                  Text(
                    binStr.isEmpty ? '—' : binStr,
                    style: binValueStyle,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Status bar
// ═══════════════════════════════════════════════════════════════════════════

class _StatusBar extends StatelessWidget {
  const _StatusBar({
    required this.scanning,
    required this.rssi,
    required this.epcValid,
  });

  final bool scanning;
  final ValueListenable<int?> rssi;
  final bool epcValid;

  @override
  Widget build(BuildContext context) {
    final String label;
    if (!epcValid) {
      label = 'NO TARGET';
    } else if (scanning) {
      label = 'SCANNING · TAP OR TRIGGER TO STOP';
    } else {
      label = 'TAP OR PULL TRIGGER TO LOCATE';
    }
    final dotColor = scanning ? AppColors.primary : const Color(0xFFBCC9C9);
    return Container(
      height: 40.h,
      padding: EdgeInsets.symmetric(horizontal: 16.w),
      decoration: const BoxDecoration(
        color: Color(0xFFF0F5F4),
        borderRadius: BorderRadius.all(Radius.circular(2)),
      ),
      child: Row(
        children: [
          _BlinkingDot(active: scanning, color: dotColor),
          SizedBox(width: 8.w),
          Text(
            label,
            style: GoogleFonts.spaceGrotesk(
              fontSize: 11.sp,
              fontWeight: FontWeight.w700,
              letterSpacing: 1.5,
              color: const Color(0xFF3D4949),
            ),
          ),
          const Spacer(),
          // Only this label rebuilds as RSSI moves.
          ValueListenableBuilder<int?>(
            valueListenable: rssi,
            builder: (_, v, __) => Text(
              v != null ? 'RSSI: $v dBm' : 'RSSI: —',
              style: GoogleFonts.spaceGrotesk(
                fontSize: 11.sp,
                fontWeight: FontWeight.w500,
                color: const Color(0xFF3D4949),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _BlinkingDot extends StatefulWidget {
  const _BlinkingDot({required this.active, required this.color});
  final bool active;
  final Color color;

  @override
  State<_BlinkingDot> createState() => _BlinkingDotState();
}

class _BlinkingDotState extends State<_BlinkingDot>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;
  @override
  void initState() {
    super.initState();
    _c = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 900),
    );
    if (widget.active) _c.repeat(reverse: true);
  }

  @override
  void didUpdateWidget(covariant _BlinkingDot old) {
    super.didUpdateWidget(old);
    // Don't leave a ticker spinning while idle — it wakes the engine every
    // frame for a dot nobody is watching.
    if (widget.active && !_c.isAnimating) {
      _c.repeat(reverse: true);
    } else if (!widget.active && _c.isAnimating) {
      _c.stop();
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.active) {
      return Container(
        width: 8,
        height: 8,
        decoration:
            BoxDecoration(color: widget.color, shape: BoxShape.circle),
      );
    }
    return RepaintBoundary(
      child: AnimatedBuilder(
        animation: _c,
        builder: (_, __) => Opacity(
          opacity: 0.4 + 0.6 * _c.value,
          child: Container(
            width: 8,
            height: 8,
            decoration:
                BoxDecoration(color: widget.color, shape: BoxShape.circle),
          ),
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Radar visualizer — sweeping cone + proximity bloom + central dial
// ═══════════════════════════════════════════════════════════════════════════

class _RadarVisualizer extends StatelessWidget {
  const _RadarVisualizer({
    required this.sweep,
    required this.proximity,
    required this.scanning,
  });

  final AnimationController sweep;
  final ValueListenable<double> proximity;
  final bool scanning;

  @override
  Widget build(BuildContext context) {
    return AspectRatio(
      aspectRatio: 1,
      child: LayoutBuilder(
        builder: (context, constraints) {
          final size = math.min(constraints.maxWidth, 360.w);
          return SizedBox(
            width: size,
            height: size,
            child: Stack(
              alignment: Alignment.center,
              children: [
                Container(
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: AppColors.primary.withValues(alpha: 0.04),
                  ),
                ),
                ..._rangeCircles(size),
                // Proximity halo. blurRadius/spreadRadius are deliberately
                // capped well below the previous 30→100 / 4→16 ramp: a
                // large-radius BoxShadow is one of the most expensive things
                // you can repaint, and at 30 Hz on a rugged handheld's GPU it
                // was a measurable share of the frame budget by itself.
                ValueListenableBuilder<double>(
                  valueListenable: proximity,
                  builder: (_, p, __) {
                    return Container(
                      width: size * (0.55 + 0.30 * p),
                      height: size * (0.55 + 0.30 * p),
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: AppColors.primary
                            .withValues(alpha: 0.10 + 0.20 * p),
                        boxShadow: [
                          BoxShadow(
                            color: AppColors.primary
                                .withValues(alpha: 0.25 + 0.40 * p),
                            blurRadius: 20 + 28 * p,
                            spreadRadius: 3 + 7 * p,
                          ),
                        ],
                      ),
                    );
                  },
                ),
                if (scanning)
                  RepaintBoundary(
                    child: AnimatedBuilder(
                      animation: Listenable.merge([sweep, proximity]),
                      builder: (_, __) => CustomPaint(
                        size: Size(size, size),
                        painter: _SweepPainter(
                          angle: sweep.value * 2 * math.pi,
                          proximity: proximity.value,
                        ),
                      ),
                    ),
                  ),
                // Central dial — tracks the engine's smoothed value with no
                // further tweening. The smoothing already happens at a fixed
                // rate in _engineTick; layering a widget animation on top of
                // it would just add visible lag between the operator's aim
                // and the number on screen.
                ValueListenableBuilder<double>(
                  valueListenable: proximity,
                  builder: (_, p, __) =>
                      _CoreDial(percent: (p * 100).round()),
                ),
              ],
            ),
          );
        },
      ),
    );
  }

  List<Widget> _rangeCircles(double size) {
    return [0.85, 0.65, 0.45].map((scale) {
      final s = size * scale;
      return SizedBox(
        width: s,
        height: s,
        child: DecoratedBox(
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            border: Border.all(
              color: AppColors.primary.withValues(alpha: 0.10),
              width: 1,
            ),
          ),
        ),
      );
    }).toList();
  }
}

/// Rotating cone (radar sweep). The "leading edge" is bright primary and
/// fades over a 90° arc. Drawn with a SweepGradient + circular clip so it
/// reads as a glowing wedge orbiting the dial.
class _SweepPainter extends CustomPainter {
  _SweepPainter({required this.angle, required this.proximity});
  final double angle;
  final double proximity;

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final radius = size.width / 2;
    final rect = Rect.fromCircle(center: center, radius: radius);
    final gradient = SweepGradient(
      startAngle: 0,
      endAngle: 2 * math.pi,
      transform: GradientRotation(angle - math.pi / 2),
      colors: [
        AppColors.primary.withValues(alpha: 0.0),
        AppColors.primary.withValues(alpha: 0.08 + 0.40 * proximity),
        AppColors.primary.withValues(alpha: 0.0),
        AppColors.primary.withValues(alpha: 0.0),
      ],
      stops: const [0.0, 0.10, 0.25, 1.0],
    );
    final paint = Paint()..shader = gradient.createShader(rect);
    canvas.drawCircle(center, radius, paint);
  }

  @override
  bool shouldRepaint(covariant _SweepPainter old) =>
      old.angle != angle || old.proximity != proximity;
}

class _CoreDial extends StatelessWidget {
  const _CoreDial({required this.percent});
  final int percent;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 192.w,
      height: 192.w,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: Colors.white,
        border: Border.all(color: AppColors.primary, width: 4),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.06),
            blurRadius: 24,
            offset: const Offset(0, 8),
          ),
        ],
      ),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text(
            '$percent%',
            style: GoogleFonts.spaceGrotesk(
              fontSize: 56.sp,
              fontWeight: FontWeight.w900,
              color: AppColors.textMain,
              height: 1.0,
            ),
          ),
          SizedBox(height: 4.h),
          Text(
            'PROXIMITY',
            style: GoogleFonts.spaceGrotesk(
              fontSize: 11.sp,
              fontWeight: FontWeight.w700,
              letterSpacing: 2.4,
              color: const Color(0xFF6D7979),
            ),
          ),
        ],
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// "We see another tag" hint — visible only when scanning, target silent,
// other tags streaming. Fixes the 1.2.39 confusion where 0% looked like the
// scanner was broken even though the radio was streaming reads of OTHER tags.
// ═══════════════════════════════════════════════════════════════════════════

class _DiagnosticHint extends StatelessWidget {
  const _DiagnosticHint({required this.scanning, required this.diag});

  final bool scanning;
  final ValueListenable<_Diag> diag;

  @override
  Widget build(BuildContext context) {
    if (!scanning) return SizedBox(height: 32.h);
    return ValueListenableBuilder<_Diag>(
      valueListenable: diag,
      builder: (_, d, __) {
        final show = d.targetReads == 0 &&
            d.otherFresh &&
            d.otherEpc != null &&
            d.otherRssi != null;
        if (!show) return SizedBox(height: 32.h);
        final epc = d.otherEpc!;
        return Container(
          height: 32.h,
          alignment: Alignment.center,
          child: Text(
            'TARGET NOT IN RANGE · NEAREST: '
            '${epc.substring(epc.length - 8)} (${d.otherRssi}dBm)',
            textAlign: TextAlign.center,
            style: GoogleFonts.spaceGrotesk(
              fontSize: 10.sp,
              fontWeight: FontWeight.w600,
              letterSpacing: 1.2,
              color: const Color(0xFF6D7979),
            ),
          ),
        );
      },
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Start/stop control. 1.2.41 made this a passive status strip on the theory
// that the physical trigger was the only thing the operator should reach for.
// In practice both are wanted: the trigger for one-handed sweeping, the button
// for when the handheld is resting on a shelf or the operator's other hand is
// full. Both routes call the same guarded, debounced _toggleScan, so a tap and
// a trigger pull can never end up fighting each other.
// ═══════════════════════════════════════════════════════════════════════════

class _ToggleScanButton extends StatelessWidget {
  const _ToggleScanButton({
    required this.scanning,
    required this.enabled,
    required this.onPressed,
  });

  final bool scanning;
  final bool enabled;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final Color bg;
    if (!enabled) {
      bg = const Color(0xFFBCC9C9);
    } else if (scanning) {
      bg = const Color(0xFFBA1A1A);
    } else {
      bg = AppColors.primary;
    }
    return AnimatedContainer(
      duration: const Duration(milliseconds: 150),
      height: 64.h,
      decoration: BoxDecoration(
        color: bg,
        boxShadow: const [
          BoxShadow(
            color: Color(0x24000000),
            blurRadius: 18,
            offset: Offset(0, 8),
          ),
        ],
      ),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onPressed,
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(
                scanning ? Icons.stop_circle_outlined : Icons.sensors,
                color: Colors.white,
                size: 22.sp,
              ),
              SizedBox(width: 12.w),
              Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(
                    scanning ? 'STOP' : 'START LOCATE',
                    style: GoogleFonts.manrope(
                      fontSize: 15.sp,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 2.0,
                      color: Colors.white,
                    ),
                  ),
                  SizedBox(height: 2.h),
                  Text(
                    'TAP OR PULL TRIGGER',
                    style: GoogleFonts.spaceGrotesk(
                      fontSize: 9.sp,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 1.4,
                      color: Colors.white.withValues(alpha: 0.75),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Cloud+Geiger-only secondary affordance shown above the scan toggle
/// while the radio is idle. Opens a bottom sheet with Status Change /
/// Encode / Re-encode so the operator can act on the located tag
/// without backing out to the dashboard.
class _TakeActionButton extends StatelessWidget {
  const _TakeActionButton({required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: double.infinity,
      child: OutlinedButton.icon(
        onPressed: onPressed,
        icon: const Icon(Icons.bolt, size: 20, color: AppColors.primary),
        label: const Text(
          'TAKE AN ACTION',
          style: TextStyle(
            fontSize: 14,
            fontWeight: FontWeight.w800,
            letterSpacing: 1.6,
            color: AppColors.primary,
          ),
        ),
        style: OutlinedButton.styleFrom(
          side: const BorderSide(color: AppColors.primary, width: 1.5),
          padding: const EdgeInsets.symmetric(vertical: 14),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(6),
          ),
        ),
      ),
    );
  }
}

/// Live diagnostic banner — visible only while scanning. Shows the data
/// that lets the operator (and the dev) see exactly why the % is or
/// isn't climbing:
///   * counts: target / others / no-RSSI, plus the live target read rate
///   * last seen EPC + RSSI (any tag)
/// If TARGET stays at 0 while OTHERS climbs, the radio hears tags but
/// the EPC match is failing — operator should compare LAST SEEN against
/// TARGET to spot a format mismatch. If both stay at 0, the radio isn't
/// hearing anything. TGT/s is the tell for pre-filter health: with the
/// filter installed a tag in range should sit in the hundreds, and a
/// double-digit rate means the filter didn't take.
///
/// Repaints at ~5 Hz off the diag notifier, independently of the meter.
class _LiveDiagnosticBanner extends StatelessWidget {
  const _LiveDiagnosticBanner({required this.diag, required this.targetEpc});

  final ValueListenable<_Diag> diag;
  final String targetEpc;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<_Diag>(
      valueListenable: diag,
      builder: (_, d, __) {
        final tone = d.targetReads > 0
            ? const Color(0xFF1B7F4F) // green — match found
            : (d.otherReads > 0
                ? const Color(0xFFB87A00) // amber — radio alive, no match
                : const Color(0xFFB23A3A)); // red — radio silent
        return Container(
          margin: EdgeInsets.only(top: 8.h),
          padding: EdgeInsets.fromLTRB(12.w, 10.h, 12.w, 10.h),
          decoration: BoxDecoration(
            color: tone.withValues(alpha: 0.06),
            border: Border.all(color: tone.withValues(alpha: 0.4)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    padding:
                        EdgeInsets.symmetric(horizontal: 6.w, vertical: 2.h),
                    color: tone,
                    child: Text(
                      d.targetReads > 0
                          ? 'MATCH ${d.readsPerSec}/s'
                          : (d.otherReads > 0 ? 'NO MATCH' : 'NO READS'),
                      style: GoogleFonts.spaceGrotesk(
                        fontSize: 10.sp,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 1.4,
                        color: Colors.white,
                      ),
                    ),
                  ),
                  SizedBox(width: 8.w),
                  Expanded(
                    child: Text(
                      'TGT ${d.targetReads} · OTH ${d.otherReads}'
                      '${d.nullRssiReads > 0 ? ' · NULL-RSSI ${d.nullRssiReads}' : ''}'
                      '${d.lastSeenRssi != null ? ' · ${d.lastSeenRssi}dBm' : ''}'
                      // Explains a "-68 dBm but the dial reads 86%" pairing:
                      // the meter is normalised back to full power.
                      '${d.powerOffsetDb > 0 ? ' · PWR+${d.powerOffsetDb}dB' : ''}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: GoogleFonts.spaceGrotesk(
                        fontSize: 10.sp,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 0.8,
                        color: const Color(0xFF333333),
                      ),
                    ),
                  ),
                ],
              ),
              SizedBox(height: 4.h),
              Text(
                'TGT  $targetEpc',
                style: GoogleFonts.firaCode(
                  fontSize: 9.sp,
                  color: const Color(0xFF555555),
                ),
                overflow: TextOverflow.ellipsis,
              ),
              ...d.lastSeenEpcs.map(
                (e) => Text(
                  'SEEN $e',
                  style: GoogleFonts.firaCode(
                    fontSize: 9.sp,
                    color: e == targetEpc
                        ? const Color(0xFF1B7F4F)
                        : const Color(0xFF555555),
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}
