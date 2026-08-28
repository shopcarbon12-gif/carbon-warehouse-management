import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart' show ValueListenable;
import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/services/mobile_permissions.dart';
import 'package:carbon_wms/services/scan_sounds.dart';
import 'package:carbon_wms/hardware/locate_bearing.dart';
import 'package:carbon_wms/hardware/locate_proximity.dart';
import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/hardware/rfid_tag_read.dart';
import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/guards/permission_guard.dart';
import 'package:carbon_wms/ui/screens/encode_screen.dart';
import 'package:carbon_wms/ui/screens/search_and_encode_screen.dart';
import 'package:carbon_wms/ui/screens/status_change_screen.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

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

/// What the direction panel is currently able to tell the operator.
enum DirectionStatus {
  /// Operator switched guidance off — panel is a tap target to switch it back.
  off,

  /// Guidance is on but there isn't a usable fix yet: not enough of an arc has
  /// been swept, or the field is too flat to pick a peak out of. Deliberately
  /// silent rather than pointing somewhere plausible-but-wrong.
  searching,

  /// A bearing we're prepared to stand behind.
  locked,
}

/// Immutable snapshot of the direction panel, published at ~10 Hz.
class _DirectionState {
  const _DirectionState({
    required this.status,
    required this.headline,
    required this.detail,
    this.relativeDeg,
  });

  const _DirectionState.off()
      : status = DirectionStatus.off,
        headline = 'OFF DIRECTIONS',
        detail = 'TAP TO ENABLE',
        relativeDeg = null;

  const _DirectionState.searching()
      : status = DirectionStatus.searching,
        headline = 'OFF DIRECTIONS',
        detail = 'SWEEP LEFT ↔ RIGHT TO GET A BEARING',
        relativeDeg = null;

  /// Nothing being heard from the target, so there is nothing to guide with.
  const _DirectionState.noSignal()
      : status = DirectionStatus.searching,
        headline = 'OFF DIRECTIONS',
        detail = 'NO SIGNAL FROM THIS TAG YET',
        relativeDeg = null;

  /// Sensor-free guidance: hotter/colder against the best of the last few
  /// seconds, plus distance and the walking trend. This is what the operator
  /// gets when the phone is not rigidly attached to the sled, so device yaw
  /// cannot stand in for where the antenna points. It names no side — that
  /// genuinely requires the two to be locked together — but it still says
  /// whether the last movement helped.
  const _DirectionState.hotCold({
    required this.headline,
    required this.detail,
  })  : status = DirectionStatus.locked,
        relativeDeg = null;

  final DirectionStatus status;
  final String headline;
  final String detail;
  final double? relativeDeg;
}

/// Immutable snapshot of the diagnostic counters, published at a low rate so
/// the debug banner never drags the proximity engine down with it.
class _Diag {
  const _Diag({
    this.targetReads = 0,
    this.otherReads = 0,
    this.nullRssiReads = 0,
    this.readsPerSec = 0,
    this.rungDbm = 30,
    this.sessionPeakRssi,
    this.yawDeg,
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

  /// Transmit power the auto-ladder currently sits on. This is the meter's
  /// primary distance signal, so it belongs in the diagnostics.
  final int rungDbm;

  /// Hottest power-normalised read this scan. With the gun touching the tag
  /// this is the ground truth for where 100% should sit.
  final int? sessionPeakRssi;

  /// Latest device yaw, or null when the motion sensor isn't reporting.
  final double? yawDeg;
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
  /// Signal-processing / UI-publish rate. 60 Hz — one pass per display frame,
  /// so the meter can move on every frame the screen can actually draw and the
  /// beep cadence is decided with ~16 ms granularity. This is affordable only
  /// because reads no longer drive rebuilds: the tick does a few dozen
  /// arithmetic ops and writes at most three notifiers.
  static const int _tickMs = 16;

  /// Grace period after the last target read before proximity starts falling.
  /// Covers the natural read gap when the antenna goes momentarily off-axis
  /// without letting a genuine walk-away sit at "hot".
  static const int _holdMs = 180;

  /// Exponential decay time constant once the grace period lapses.
  /// ~1 s from pinned to effectively cold.
  static const double _decayTauMs = 300;

  /// Smoothing time constants, in milliseconds, for the meter closing in and
  /// falling back. Expressed as TIME rather than a per-tick weight so the feel
  /// is identical whatever the tick rate or however late a tick actually
  /// fires — the old fixed alpha silently changed the response curve whenever
  /// the timer slipped under load, which is exactly when it mattered most.
  /// Rising is deliberately faster than falling: chasing the tag should feel
  /// immediate, while backing off shouldn't twitch on read-to-read jitter.
  static const double _riseTauMs = 35;
  static const double _fallTauMs = 80;

  /// Beep interval at zero proximity / at full proximity (ms). Interpolated
  /// geometrically, so the cadence accelerates smoothly and continuously
  /// across the WHOLE range instead of the old two-segment ramp that only
  /// spanned 1.1 → 2.9 Hz below 90%.
  static const double _beepSlowMs = 650;
  static const double _beepFastMs = 45;

  /// Rolling window the signal peak is taken over.
  ///
  /// 16 ms (one frame) was wrong. Tag Test measured the real read rate at
  /// 20-60 per second — one read roughly every 50 ms, not the hundreds/sec
  /// assumed — so a one-frame window was EMPTY about two ticks in three and
  /// the meter kept falling through to its decay path between reads. A 250 ms
  /// window always contains several reads, and taking the strongest of them
  /// rides straight over the multipath nulls the test data is full of.
  static const int _peakWindowMs = 250;

  /// Minimum time on a rung before the ladder may move again. Without it the
  /// ladder oscillates at a boundary, and every move costs a radio blink.
  static const int _rungMinDwellMs = 1100;

  /// Reads needed inside [_peakWindowMs] to justify stepping DOWN a rung.
  /// At a measured 20-60 reads/sec a 250 ms window holds 5-15 when the tag is
  /// solidly heard, so 4 means "really there", not "one lucky read".
  static const int _rungDownReads = 4;

  /// Silence at the current rung before stepping back UP. Longer than the
  /// meter's own grace period so a brief null never widens the search.
  static const int _rungUpSilenceMs = 900;

  /// How long reads are ignored after a deliberate power change. The sled must
  /// stop inventory, write the antenna config and restart; anything arriving
  /// in that window belongs to the previous rung.
  static const int _rungSettleMs = 400;

  /// How far up a rung's band the signal must sit before the ladder will try
  /// the next rung down. Chosen from the Tag Test curve: at 5 ft the reading
  /// clears this and 25 dBm does turn out to be audible there, while at 9 ft
  /// it does not and 25 dBm is genuinely out of reach. It keeps the ladder
  /// from probing rungs that measurement says will fail.
  static const double _rungDownFraction = 0.35;

  /// Lock-out on stepping down again straight after stepping up. Without it a
  /// boundary produces a continuous down-up-down cycle, and every edge of that
  /// cycle is a radio blink.
  static const int _rungDownLockMs = 3000;

  RfidManager? _rfid;
  StreamSubscription<RfidTagRead>? _readSub;
  StreamSubscription<String>? _triggerSub;
  Timer? _engine;

  late final AnimationController _sweep; // radar rotation

  // ── Published UI state — only leaf widgets listen to these ────────────────
  final ValueNotifier<double> _proximity = ValueNotifier<double>(0);
  final ValueNotifier<int?> _rssiOut = ValueNotifier<int?>(null);
  final ValueNotifier<_Diag> _diag = ValueNotifier<_Diag>(const _Diag());
  final ValueNotifier<_DirectionState> _direction =
      ValueNotifier<_DirectionState>(const _DirectionState.searching());

  // ── Direction finding ────────────────────────────────────────────────────
  // Entirely additive. It consumes the SAME power-normalised RSSI the
  // proximity engine already computes and pairs it with device yaw; it does
  // not touch the radio, the proximity maths, the beep cadence or any shared
  // state. With [_directionsOn] false the screen behaves exactly as it did
  // before this feature existed.
  final BearingEstimator _bearing = BearingEstimator();
  StreamSubscription<double>? _yawSub;
  double? _yawDeg;
  bool _directionsOn = true;

  /// Proximity sampled ~600 ms ago, for the closer/further cue. Needs no
  /// sensors at all — it's just the trend of the meter we already have.
  double _trendRefProx = 0;
  DateTime _trendRefAt = DateTime.fromMillisecondsSinceEpoch(0);
  int _trendDir = 0; // -1 moving away, 0 holding, +1 closing in

  /// Latest power-normalised RSSI, used for the distance estimate.
  int? _lastNormRssi;

  /// Best proximity seen in the last few seconds, decaying. The reference the
  /// sensor-free hotter/colder cue is measured against; it decays so the
  /// comparison stays about the CURRENT sweep rather than the whole hunt.
  double _sweepPeakProx = 0;
  static const double _sweepPeakTauMs = 4000;
  int _directionTick = 0;
  HotCold? _hotCold;
  DateTime _directionChangedAt = DateTime.fromMillisecondsSinceEpoch(0);

  /// Minimum time a direction message stays on screen before it may change.
  static const int _directionDwellMs = 1500;

  // ── Radio health indicator ───────────────────────────────────────────────
  // Deliberately NOT derived from [_scanning]. The whole value of this dot is
  // that it can disagree with the button: the RFD8500 rejects config writes
  // mid-stream, so a resume can silently fail and leave the radio stopped while
  // the screen still says SCANNING. Polling the controller's own
  // `inventoryActive` — set only when the SDK's Inventory.perform() actually
  // succeeded — is the one signal that catches that.
  Timer? _radioPoll;
  final ValueNotifier<bool> _radioLive = ValueNotifier<bool>(false);

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

  int get _rungDbm => kLocateRungsDbm[_rungIndex];

  // ── Hot-path fields — written by the read callback, read by the engine.
  //    Never touched by build(), never wrapped in setState. ─────────────────
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

  /// Rolling window of (timestampMs, rssi) for the last [_peakWindowMs].
  final List<(int, int)> _recent = <(int, int)>[];

  /// Current rung into [kLocateRungsDbm]. 0 = 30 dBm = widest search.
  int _rungIndex = 0;
  DateTime _rungChangedAt = DateTime.fromMillisecondsSinceEpoch(0);

  /// While set, the radio is mid power-change: reads are stale and the meter
  /// is held steady so a deliberate rung step reads as a step rather than as
  /// the tag vanishing.
  DateTime? _rungSettleUntil;

  /// Set after a step up; blocks stepping down again until it passes.
  DateTime? _rungDownLockUntil;

  /// Signal strength (as a within-band fraction) at which a probe down from a
  /// given rung last FAILED. Simulated against the measured Tag Test data, a
  /// ladder without this memory re-probed a rung it had already found
  /// unreachable roughly every two seconds — 16 rung changes in 30 s of
  /// standing still, each one a radio blink. With it, the same simulation
  /// settles and produces no further changes at any distance.
  ///
  /// The rule it encodes: only try a narrower power again once the signal here
  /// has genuinely improved, i.e. the operator has actually moved closer.
  /// Standing still is not new information.
  final Map<int, double> _probeFailFraction = <int, double>{};

  /// Strength we had when we last stepped down, so a failure can be attributed
  /// back to the rung it was launched from.
  double? _probeFromFraction;

  /// How much the signal must improve before re-probing a failed rung.
  static const double _probeImproveDelta = 0.08;

  /// Hottest raw reading this scan, for the diagnostic line.
  int? _sessionPeakRssi;

  String? _otherEpc;
  int? _otherRssi;
  DateTime? _otherSeenAt;
  final List<String> _lastSeenEpcs = <String>[];
  int? _lastSeenRssi;
  bool _diagDirty = false;
  int _diagTickCounter = 0;

  DateTime _lastBeepAt = DateTime.fromMillisecondsSinceEpoch(0);
  DateTime _lastTickAt = DateTime.fromMillisecondsSinceEpoch(0);

  /// Computed ONCE. This was a getter doing trim + toUpperCase on every
  /// access, and the read path touches it up to three times per tag — hundreds
  /// of throwaway strings a second on the UI isolate for a value that cannot
  /// change while the screen is alive.
  late final String _epcUpper = (widget.targetEpc ?? '').trim().toUpperCase();

  /// Last 16 hex chars of the target, precomputed for [_matchesTarget].
  late final String? _epcSuffix16 =
      _epcUpper.length >= 16 ? _epcUpper.substring(_epcUpper.length - 16) : null;

  late final bool _epcValid = _epc24.hasMatch(_epcUpper);

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
    unawaited(_applyRungPower());
    // Poll the radio's own state for the whole time we're on this screen, not
    // just while scanning — the operator wants to be able to glance at it any
    // time and know whether the scanner is genuinely running.
    _radioPoll = Timer.periodic(
      const Duration(milliseconds: 700),
      (_) => unawaited(_pollRadio()),
    );
    unawaited(_pollRadio());
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
      unawaited(m.setSessionPowerOverrideDbm(_rungDbm));
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
    _radioPoll?.cancel();
    _stopYaw();
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
    _direction.dispose();
    _radioLive.dispose();
    super.dispose();
  }

  /// Refresh the radio-health dot. Green means the controller reports the
  /// radio genuinely inventorying; red means it is not, whatever the start /
  /// stop button currently says.
  Future<void> _pollRadio() async {
    final status = await RfidVendorChannel.readerStatus();
    if (!mounted) return;
    final live = status != null && status.connected && status.inventoryActive;
    if (_radioLive.value != live) _radioLive.value = live;
  }

  /// Push the current rung's power to the radio and open a settle window.
  ///
  /// The RFD8500 refuses a power change while it is listening, so the native
  /// controller stops inventory, writes the config and restarts. That leaves
  /// a real hole of a few hundred milliseconds with no reads — which the
  /// meter must NOT read as "the tag disappeared". [_rungSettleUntil] both
  /// freezes the meter and suppresses the ladder's own silence detector for
  /// the duration, so a deliberate rung change reads as a step.
  ///
  /// Re-issuing the inventory start afterwards is belt-and-braces: the
  /// controller retries its own resume, but if every retry lands inside the
  /// sled's settle window it gives up and strands the radio stopped while the
  /// screen still says SCANNING. This turns that into a self-heal.
  Future<void> _applyRungPower() async {
    final dbm = _rungDbm;
    _rungSettleUntil =
        DateTime.now().add(const Duration(milliseconds: _rungSettleMs));
    await _rfid?.setSessionPowerOverrideDbm(dbm);
    if (!mounted || !_scanning) return;
    try {
      await RfidVendorChannel.startZebraInventory();
    } catch (_) {}
    try {
      await RfidVendorChannel.startChainwayInventory();
    } catch (_) {}
  }

  /// Move the ladder one rung and re-arm the radio at the new power.
  void _setRung(int next, DateTime now) {
    final clamped = next.clamp(0, kLocateRungsDbm.length - 1);
    if (clamped == _rungIndex) return;
    _rungIndex = clamped;
    _rungChangedAt = now;
    // Evidence gathered at the old power says nothing about the new one.
    _recent.clear();
    unawaited(_applyRungPower());
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
    // Every hunt starts wide and narrows its way in.
    _recent.clear();
    _rungIndex = 0;
    _rungChangedAt = DateTime.fromMillisecondsSinceEpoch(0);
    _rungSettleUntil = null;
    _rungDownLockUntil = null;
    _probeFailFraction.clear();
    _probeFromFraction = null;
    _sessionPeakRssi = null;
    unawaited(_applyRungPower());
    // Bearing evidence is tied to where the operator was standing, so it never
    // carries across hunts.
    _bearing.reset();
    _lastNormRssi = null;
    _trendRefProx = 0;
    _trendRefAt = DateTime.fromMillisecondsSinceEpoch(0);
    _trendDir = 0;
    _sweepPeakProx = 0;
    _directionTick = 0;
    _hotCold = null;
    _directionChangedAt = DateTime.fromMillisecondsSinceEpoch(0);
    _direction.value = _directionsOn
        ? const _DirectionState.searching()
        : const _DirectionState.off();
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

    _startYaw();
    _startEngine();

    // Only the Zebra start is on the critical path to the radio transmitting.
    // The other two are belt-and-braces for hosts where the manager's view of
    // the active driver has drifted, and they are no-ops once inventory is
    // already streaming — so awaiting them just held _busy (and therefore the
    // operator's ability to pull the trigger again to stop) for two extra
    // platform round-trips.
    try {
      await RfidVendorChannel.startZebraInventory();
    } catch (_) {}
    unawaited(RfidVendorChannel.startChainwayInventory().catchError((_) {}));
    unawaited(m.startLocateScanning());
  }

  /// Attach the yaw sensor. Only while scanning with guidance on, so the
  /// sensor is unregistered natively the rest of the time.
  void _startYaw() {
    if (!_directionsOn || _yawSub != null) return;
    _yawSub = RfidVendorChannel.deviceYawStream().listen(
      (deg) => _yawDeg = deg,
      onError: (_) {},
    );
  }

  void _stopYaw() {
    unawaited(_yawSub?.cancel());
    _yawSub = null;
    _yawDeg = null;
  }

  Future<void> _stopScan() async {
    // Everything the operator can SEE or HEAR happens first, synchronously.
    // Previously the screen didn't flip out of SCANNING until three awaited
    // platform calls had come back, so a stop looked frozen for a few hundred
    // milliseconds. The radio calls below don't need to gate the UI: the
    // native stop flips its read gate inline, so tags stop reaching us the
    // instant the call is dispatched.
    ScanSounds.instance.play(ScanCue.stop);
    _engine?.cancel();
    _engine = null;
    _stopYaw();
    _sweep.stop();
    _prox = 0;
    _lastTargetReadAt = null;
    _proximity.value = 0;
    _rssiOut.value = null;
    if (mounted) setState(() => _scanning = false);

    unawaited(_readSub?.cancel());
    _readSub = null;
    try {
      await RfidVendorChannel.stopZebraInventory();
    } catch (_) {}
    unawaited(RfidVendorChannel.stopChainwayInventory().catchError((_) {}));
    unawaited(_rfid?.stopLocateScanning());
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
      _recent.add((DateTime.now().millisecondsSinceEpoch, rssi));
      // Hard cap so a burst can never grow this without bound; the engine
      // prunes by age every tick anyway.
      if (_recent.length > 512) _recent.removeAt(0);
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
    final suffix = _epcSuffix16;
    if (suffix == null || observed.length < 16) return false;
    // One substring instead of two, against a precomputed target suffix.
    return observed.endsWith(suffix);
  }

  // ── Fixed-rate engine ────────────────────────────────────────────────────

  void _startEngine() {
    _engine?.cancel();
    // Seed the dt baseline, or the first tick would see the whole gap since
    // the last hunt and apply a full decay step before any read lands.
    _lastTickAt = DateTime.now();
    _engine = Timer.periodic(
      const Duration(milliseconds: _tickMs),
      (_) => _engineTick(),
    );
  }

  /// The power ladder.
  ///
  /// Steps DOWN (narrowing the search) when the tag is solidly heard at the
  /// current power AND its strength sits well up this rung's band — the second
  /// condition matters, because "audible" alone would march the ladder all the
  /// way to 5 dBm from across the room and then have to climb back.
  ///
  /// Steps UP when the tag goes quiet, which at a narrowed power is the
  /// measurement, not a failure: it means the operator is further away than
  /// this rung reaches.
  ///
  /// Three separate brakes stop it oscillating at a boundary, where "just
  /// audible" and "just silent" alternate: a minimum dwell on every rung, a
  /// longer lock-out on stepping down again right after a step up, and the
  /// asymmetry between the two conditions. Each move costs a radio blink, so
  /// thrash is expensive as well as ugly.
  void _runLadder(DateTime now, int? peak) {
    if (now.difference(_rungChangedAt).inMilliseconds < _rungMinDwellMs) return;
    final last = _lastTargetReadAt;
    final silentMs =
        last == null ? 1 << 20 : now.difference(last).inMilliseconds;

    if (silentMs > _rungUpSilenceMs) {
      if (_rungIndex > 0) {
        // The narrower power cannot hear the tag from here. Remember how
        // strong the signal was when we launched that probe, so we don't
        // repeat it until something actually changes.
        final from = _rungIndex - 1;
        if (_probeFromFraction != null) {
          _probeFailFraction[from] = _probeFromFraction!;
        }
        _rungDownLockUntil =
            now.add(const Duration(milliseconds: _rungDownLockMs));
        _setRung(from, now);
      }
      return;
    }

    final locked =
        _rungDownLockUntil != null && now.isBefore(_rungDownLockUntil!);
    if (locked || peak == null) return;
    if (_rungIndex >= kLocateRungsDbm.length - 1) return;
    if (_recent.length < _rungDownReads) return;

    final fraction = rungFraction(peak);
    if (fraction < _rungDownFraction) return;
    // Already learned this rung is out of reach at roughly this signal level.
    final failedAt = _probeFailFraction[_rungIndex];
    if (failedAt != null && fraction <= failedAt + _probeImproveDelta) return;

    _probeFromFraction = fraction;
    _probeFailFraction.remove(_rungIndex);
    _setRung(_rungIndex + 1, now);
  }

  void _engineTick() {
    if (!mounted || !_scanning) return;
    final now = DateTime.now();
    // Real elapsed time, not the nominal period. Timers slip under load and
    // every filter below is written against actual dt so the feel holds up
    // precisely when the device is busiest.
    final rawDt = now.difference(_lastTickAt).inMicroseconds / 1000.0;
    final dtMs = rawDt.clamp(1.0, 250.0);
    _lastTickAt = now;

    // 1. Trailing-window peak. Reads land in _recent from the read callback;
    //    here we drop anything older than the window and take the strongest
    //    of what's left. Strongest, not average: the Tag Test data is full of
    //    multipath nulls (one step read 4 times, the next 322), and a null is
    //    an artefact of where you're standing, not a statement about distance.
    final nowMs = now.millisecondsSinceEpoch;
    _recent.removeWhere((e) => nowMs - e.$1 > _peakWindowMs);
    int? peak;
    for (final e in _recent) {
      if (peak == null || e.$2 > peak) peak = e.$2;
    }
    _rateAccum += _windowReads;
    _windowReads = 0;
    _rateTicks++;

    // 2. Hold everything steady while a deliberate power change lands. The
    //    radio really is silent here, but the tag has not gone anywhere.
    final settling =
        _rungSettleUntil != null && now.isBefore(_rungSettleUntil!);
    if (settling) {
      _recent.clear();
    } else {
      _rungSettleUntil = null;
      _runLadder(now, peak);
    }

    if (peak != null && !settling) {
      if (_sessionPeakRssi == null || peak > _sessionPeakRssi!) {
        _sessionPeakRssi = peak;
      }
      _lastNormRssi = peak;
      // Direction finding runs off the same reading, on the tick rather than
      // the read callback, so it stays rate-limited and off the hot path.
      final yaw = _yawDeg;
      if (_directionsOn && yaw != null) _bearing.add(yaw, peak, now);

      // The rung carries the distance claim; signal strength only positions
      // the meter inside that rung's band. See locate_proximity.dart for why
      // it is this way round.
      final raw = proximityFor(_rungIndex, peak);
      if (_prox <= 0) {
        // First read of a hunt: snap to it. Easing up from zero is invented
        // lag — the radio has just said exactly where we are.
        _prox = raw;
      } else {
        final tau = raw >= _prox ? _riseTauMs : _fallTauMs;
        final alpha = 1 - math.exp(-dtMs / tau);
        _prox = (_prox + (raw - _prox) * alpha).clamp(0.0, 1.0);
      }
      _lastTargetReadAt = now;
    } else if (!settling) {
      final last = _lastTargetReadAt;
      if (last == null) {
        _prox = 0;
      } else if (now.difference(last).inMilliseconds > _holdMs) {
        _prox *= math.exp(-dtMs / _decayTauMs);
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

    // 2a. Decaying peak of the last few seconds, for the sensor-free
    //     hotter/colder cue.
    _sweepPeakProx = math.max(_prox, _sweepPeakProx * math.exp(-dtMs / _sweepPeakTauMs));

    // 2b. Closer / further trend, sampled on a ~600 ms baseline so it reflects
    //     the operator walking rather than read-to-read jitter.
    if (now.difference(_trendRefAt).inMilliseconds >= 600) {
      final delta = _prox - _trendRefProx;
      _trendDir = delta > 0.04 ? 1 : (delta < -0.04 ? -1 : 0);
      _trendRefProx = _prox;
      _trendRefAt = now;
    }

    // 2c. Direction panel, republished at ~10 Hz.
    // ~3 Hz. Words do not need frame-rate refresh, and a slower cadence is
    // part of what makes them readable.
    _directionTick++;
    if (_directionTick >= 20) {
      _directionTick = 0;
      _publishDirection(now);
    }

    // 3. Publish. Each notifier only rebuilds its own leaf widget.
    // 0.3% is finer than the dial's integer percent and finer than the halo
    // can visibly render, but coarse enough to stop a drifting signal
    // repainting a large-radius BoxShadow on literally every frame.
    if ((_proximity.value - _prox).abs() > 0.003) _proximity.value = _prox;
    final outRssi = _prox <= 0 ? null : _lastRssi;
    if (_rssiOut.value != outRssi) _rssiOut.value = outRssi;

    // 4. Diagnostics at ~5 Hz — counters don't need frame-rate fidelity.
    _diagTickCounter++;
    if (_diagTickCounter >= 12) {
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
          rungDbm: _rungDbm,
          sessionPeakRssi: _sessionPeakRssi,
          yawDeg: _yawDeg,
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

  /// Build the direction panel's state from the current bearing fix, distance
  /// estimate and closer/further trend.
  void _publishDirection(DateTime now) {
    if (!_directionsOn) {
      _setDirection(const _DirectionState.off());
      return;
    }

    // Nothing heard from the target — neither half of direction finding has
    // anything to work with.
    if (_lastNormRssi == null || _prox <= 0.02) {
      _setDirection(const _DirectionState.noSignal());
      return;
    }

    final distText =
        distanceSubLabel(_lastNormRssi) ?? distanceLabel(_lastNormRssi);

    // Best case: the phone is rigidly mounted to the sled, so its yaw IS the
    // antenna's, and a sweep resolves an actual bearing.
    final yaw = _yawDeg;
    BearingResult? bearing;
    if (yaw != null) {
      bearing = _bearing.evaluate(yaw, now);
      final fix = bearing.fix;
      if (fix != null) {
        final aimed = fix.relativeDeg.abs() <= 30;
        final String move;
        if (!aimed) {
          move = 'TURN TO IT';
        } else if (_trendDir > 0) {
          move = 'KEEP GOING';
        } else if (_trendDir < 0) {
          move = 'GO BACK';
        } else {
          move = 'HOLD';
        }
        _setDirection(
          _DirectionState(
            status: DirectionStatus.locked,
            headline: turnLabel(fix.relativeDeg),
            detail: '$distText · $move',
            relativeDeg: fix.relativeDeg,
          ),
        );
        return;
      }
    }

    // Fallback that needs NO orientation sensor and no rigid mounting: compare
    // the signal to the best of the last few seconds. It can't name a side —
    // that genuinely requires the phone and the antenna to move as one — but
    // "you just swept past it" is most of what a geiger is for, and it works
    // however the operator is holding the two pieces.
    // Hysteresis: feed the current state back in so a signal hovering near a
    // boundary holds instead of flipping the word on every dip.
    _hotCold = hotColdFrom(_prox, _sweepPeakProx, previous: _hotCold);
    final String headline;
    switch (_hotCold!) {
      case HotCold.hottest:
        headline = 'HOTTEST HERE';
      case HotCold.warm:
        headline = 'WARM';
      case HotCold.colder:
        headline = 'COLDER · SWEEP BACK';
    }
    // While walking, the trend is the most useful thing to say. While standing
    // still, say what the bearing estimator is waiting for instead — that is
    // the difference between "keep turning" and "this aisle has no usable
    // peak", and the operator can act on each differently.
    final String move;
    if (_trendDir > 0) {
      move = 'KEEP GOING';
    } else if (_trendDir < 0) {
      move = 'GO BACK';
    } else if (yaw == null) {
      move = 'NO BEARING · SENSOR OFF';
    } else if (bearing == null) {
      move = 'SWEEP FOR A BEARING';
    } else if (bearing.reason == BearingReason.fieldTooFlat) {
      move = 'SWEEP WIDER (${bearing.contrastDb.toStringAsFixed(0)}dB)';
    } else {
      move = 'SWEEP ${bearing.coverageDeg.round()}°/60° FOR A BEARING';
    }
    _setDirection(
      _DirectionState.hotCold(headline: headline, detail: '$distText · $move'),
    );
  }

  /// Publish a direction state, with a minimum dwell so the panel stays
  /// readable.
  ///
  /// The words were previously recomputed and republished ten times a second
  /// straight off a jittery number, so they changed faster than anyone could
  /// read them — "HOTTEST HERE" to "COLD" inside a second. Anything that
  /// changes what the operator is being TOLD now has to hold for
  /// [_directionDwellMs] first. Switching guidance off is exempt: that is a
  /// direct response to a tap and must feel immediate.
  void _setDirection(_DirectionState next) {
    final cur = _direction.value;
    if (cur.status == next.status &&
        cur.headline == next.headline &&
        cur.detail == next.detail) {
      return;
    }
    final now = DateTime.now();
    final immediate = next.status == DirectionStatus.off ||
        cur.status == DirectionStatus.off;
    if (!immediate &&
        now.difference(_directionChangedAt).inMilliseconds <
            _directionDwellMs) {
      return;
    }
    _directionChangedAt = now;
    _direction.value = next;
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
                radioLive: _radioLive,
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
              // Direction guidance, directly above the start/stop control.
              // Tapping it toggles guidance on/off.
              if (_scanning) ...[
                _DirectionPanel(
                  direction: _direction,
                  onToggle: () {
                    setState(() => _directionsOn = !_directionsOn);
                    if (_directionsOn) {
                      _bearing.reset();
                      _startYaw();
                    } else {
                      _stopYaw();
                    }
                    _publishDirection(DateTime.now());
                  },
                ),
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
              // The ladder owns transmit power now, so a manual slider here
              // would only fight it. This reports what it is doing instead.
              _RungBar(rungDbm: _rungDbm, proximity: _proximity),
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

/// Reports what the auto power-ladder is doing, and how each rung maps to
/// distance. The rung IS the meter's distance measurement (signal strength is
/// saturated in the near zone — see locate_proximity.dart), so showing it
/// makes the percentage explainable rather than magic.
class _RungBar extends StatelessWidget {
  const _RungBar({required this.rungDbm, required this.proximity});

  final int rungDbm;
  final ValueListenable<double> proximity;

  @override
  Widget build(BuildContext context) {
    final idx = kLocateRungsDbm.indexOf(rungDbm);
    return Container(
      color: const Color(0xFFF0F5F4),
      padding: EdgeInsets.fromLTRB(12.w, 6.h, 12.w, 6.h),
      child: Row(
        children: [
          Text(
            'AUTO PWR',
            style: GoogleFonts.spaceGrotesk(
              fontSize: 10.sp,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.4,
              color: const Color(0xFF6D7979),
            ),
          ),
          SizedBox(width: 10.w),
          // One pip per rung, filled up to the current one. Narrowing the
          // search lights more pips, so the ladder's progress is visible.
          for (var i = 0; i < kLocateRungsDbm.length; i++) ...[
            Container(
              width: 14.w,
              height: 6.h,
              margin: EdgeInsets.only(right: 3.w),
              color: i <= idx
                  ? AppColors.primary
                  : AppColors.primary.withValues(alpha: 0.18),
            ),
          ],
          const Spacer(),
          Text(
            '$rungDbm dBm · ${rungDistanceHint(idx < 0 ? 0 : idx)}',
            style: GoogleFonts.spaceGrotesk(
              fontSize: 11.sp,
              fontWeight: FontWeight.w800,
              color: AppColors.textMain,
            ),
          ),
        ],
      ),
    );
  }
}

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
    required this.radioLive,
  });

  final bool scanning;
  final ValueListenable<int?> rssi;
  final bool epcValid;

  /// The radio's OWN state, polled from the native controller. Intentionally
  /// independent of [scanning] — see [_RadioDot].
  final ValueListenable<bool> radioLive;

  @override
  Widget build(BuildContext context) {
    final String label;
    if (!epcValid) {
      label = 'NO TARGET';
    } else if (scanning) {
      label = 'SCANNING';
    } else {
      label = 'IDLE';
    }
    final dotColor = scanning ? AppColors.primary : const Color(0xFFBCC9C9);
    return Container(
      height: 40.h,
      padding: EdgeInsets.symmetric(horizontal: 12.w),
      decoration: const BoxDecoration(
        color: Color(0xFFF0F5F4),
        borderRadius: BorderRadius.all(Radius.circular(2)),
      ),
      child: Row(
        children: [
          _BlinkingDot(active: scanning, color: dotColor),
          SizedBox(width: 6.w),
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
          _RadioDot(live: radioLive),
          SizedBox(width: 10.w),
          // Only this label rebuilds as RSSI moves.
          ValueListenableBuilder<int?>(
            valueListenable: rssi,
            builder: (_, v, __) => Text(
              v != null ? '$v dBm' : '— dBm',
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

/// Hardware truth light for the UHF radio.
///
/// Green = the controller reports the radio genuinely inventorying. Red = it
/// is not, **regardless of what the start/stop button says**. That
/// disagreement is the entire reason this exists: the RFD8500 rejects config
/// writes while inventory streams, so a resume can quietly fail and strand the
/// radio stopped while the screen still shows SCANNING. Wiring this dot to the
/// scan flag would make it agree with the button by construction and tell the
/// operator nothing.
class _RadioDot extends StatelessWidget {
  const _RadioDot({required this.live});

  final ValueListenable<bool> live;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<bool>(
      valueListenable: live,
      builder: (_, on, __) {
        final color =
            on ? const Color(0xFF1B7F4F) : const Color(0xFFB23A3A);
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 10,
              height: 10,
              decoration: BoxDecoration(
                color: color,
                shape: BoxShape.circle,
                boxShadow: [
                  BoxShadow(
                    color: color.withValues(alpha: 0.45),
                    blurRadius: 5,
                    spreadRadius: 1,
                  ),
                ],
              ),
            ),
            SizedBox(width: 5.w),
            Text(
              'RFID',
              style: GoogleFonts.spaceGrotesk(
                fontSize: 10.sp,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.2,
                color: color,
              ),
            ),
          ],
        );
      },
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

/// Direction guidance strip, sitting directly above the start/stop control.
///
/// Green whenever there is a bearing worth acting on. Red "OFF DIRECTIONS"
/// otherwise — which covers both "the operator switched guidance off" and "the
/// operator isn't sweeping, so a single-antenna reader has nothing to say about
/// direction". The second case is a hard physical limit, not a shortcoming of
/// the estimator, so the panel asks for the sweep rather than inventing an
/// arrow. Tap anywhere on it to turn guidance off and back on.
class _DirectionPanel extends StatelessWidget {
  const _DirectionPanel({required this.direction, required this.onToggle});

  final ValueListenable<_DirectionState> direction;
  final VoidCallback onToggle;

  static const Color _green = Color(0xFF1B7F4F);
  static const Color _red = Color(0xFFB23A3A);

  IconData _arrow(_DirectionState d) {
    final rel = d.relativeDeg;
    if (d.status != DirectionStatus.locked || rel == null) {
      return Icons.explore_off_outlined;
    }
    final a = rel.abs();
    if (a <= 20) return Icons.arrow_upward;
    if (a >= 135) return Icons.arrow_downward;
    return rel < 0 ? Icons.arrow_back : Icons.arrow_forward;
  }

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<_DirectionState>(
      valueListenable: direction,
      builder: (_, d, __) {
        final locked = d.status == DirectionStatus.locked;
        final tone = locked ? _green : _red;
        return Material(
          color: tone.withValues(alpha: 0.10),
          child: InkWell(
            onTap: onToggle,
            child: Container(
              height: 56.h,
              padding: EdgeInsets.symmetric(horizontal: 14.w),
              decoration: BoxDecoration(
                border: Border.all(color: tone.withValues(alpha: 0.55), width: 1.5),
              ),
              child: Row(
                children: [
                  Icon(_arrow(d), size: 26.sp, color: tone),
                  SizedBox(width: 12.w),
                  Expanded(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          d.headline,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: GoogleFonts.spaceGrotesk(
                            fontSize: 16.sp,
                            fontWeight: FontWeight.w800,
                            letterSpacing: 1.4,
                            color: tone,
                          ),
                        ),
                        SizedBox(height: 2.h),
                        Text(
                          d.detail,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: GoogleFonts.spaceGrotesk(
                            fontSize: 10.sp,
                            fontWeight: FontWeight.w700,
                            letterSpacing: 1.1,
                            color: tone.withValues(alpha: 0.85),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
      },
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
                  // The MATCH x/s badge that used to sit here was dropped in
                  // favour of the direction panel above the trigger control.
                  // The read rate it carried is the tell for pre-filter health
                  // — with the filter installed a tag in range should sit in
                  // the hundreds, and a double-digit rate means it didn't take
                  // — so it moves inline rather than being lost.
                  Expanded(
                    child: Text(
                      '${d.targetReads > 0 ? "${d.readsPerSec}/s" : (d.otherReads > 0 ? "NO MATCH" : "NO READS")}'
                      ' · TGT ${d.targetReads} · OTH ${d.otherReads}'
                      '${d.nullRssiReads > 0 ? ' · NULL-RSSI ${d.nullRssiReads}' : ''}'
                      '${d.lastSeenRssi != null ? ' · ${d.lastSeenRssi}dBm' : ''}'
                      // Explains a "-68 dBm but the dial reads 86%" pairing:
                      // the meter is normalised back to full power.
                      ' · PWR ${d.rungDbm}dBm'
                      // Read this with the gun ON the tag: it is where 100%
                      // actually sits for this gun/tag pair.
                      '${d.sessionPeakRssi != null ? ' · PEAK ${d.sessionPeakRssi}' : ''}'
                      // YAW is the direction finder's input. "—" here means the
                      // motion sensor never reported and no sweep can help.
                      ' · YAW ${d.yawDeg == null ? "—" : d.yawDeg!.round()}',
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
