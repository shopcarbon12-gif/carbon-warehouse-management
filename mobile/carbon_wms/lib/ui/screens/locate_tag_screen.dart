import 'dart:async';
import 'dart:developer' as developer;
import 'dart:math' as math;

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/audio/geiger_beep_wav.dart';
import 'package:carbon_wms/services/scan_sounds.dart';
import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/hardware/rfid_tag_read.dart';
import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/theme/app_theme.dart';
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
double rssiToProximity01(int? rssi) {
  if (rssi == null) return 0;
  const weak = -80.0;
  const strong = -45.0;
  return ((rssi - weak) / (strong - weak)).clamp(0.0, 1.0);
}

/// Tap-to-locate Geiger screen.
///
/// Behaviour:
///   * **Tap once to start**, tap again to stop. (Operator feedback: holding
///     the trigger felt fatiguing for long sweeps across the warehouse.)
///   * Closer to the target → faster beep cadence, louder, higher %.
///   * Out-of-range → 0%, silence, idle motion only.
///   * If reads come in for OTHER tags but not the target, a subtle diagnostic
///     line surfaces the strongest in-range EPC so the operator can confirm
///     the radio is actually streaming.
///
/// Visual: animated **radar sweep** (rotating teal cone) + a halo whose blur
/// and scale grow with proximity. When the operator gets close, the dial
/// "blooms" — a much stronger affordance than the pre-1.2.39 concentric
/// rings, which read as a static decoration.
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

  @override
  State<LocateTagScreen> createState() => _LocateTagScreenState();
}

class _LocateTagScreenState extends State<LocateTagScreen>
    with TickerProviderStateMixin {
  static final RegExp _epc24 = RegExp(r'^[0-9A-F]{24}$');

  late final AudioPlayer _audio;
  Uint8List? _beepBytes;

  RfidManager? _rfid;
  StreamSubscription<RfidTagRead>? _readSub;
  StreamSubscription<String>? _triggerSub;
  Timer? _beepTimer;
  Timer? _staleTimer;

  late final AnimationController _sweep; // radar rotation
  late final AnimationController _bloom; // proximity-driven halo bloom

  bool _scanning = false;
  int? _liveRssi;
  double _proximity01 = 0;
  DateTime? _lastTargetReadAt;

  // Diagnostic counters — surfaced as a small overlay so the operator
  // (and us) can tell at a glance whether the radio is hearing the target
  // tag at all. Pre-fix, the % was stuck at 0 because reads were either
  // not arriving for the target EPC or arriving with null RSSI (Zebra's
  // streaming inventory occasionally drops RSSI on weak reads). The
  // counter makes that distinction visible without ADB logcat.
  int _targetReads = 0;
  int _otherReads = 0;
  int _nullRssiReads = 0;

  /// Last 3 EPCs heard, in order (newest first). Used by the on-screen
  /// diagnostic banner so the operator can see "is the radio hearing
  /// anything" and "does the target's EPC actually match what's coming
  /// off the air" without leaving the screen for logcat.
  final List<String> _lastSeenEpcs = <String>[];
  int? _lastSeenRssi;

  // Diagnostic: strongest non-target EPC + RSSI we've seen this session.
  // Surfaces a "WE SEE ANOTHER TAG" hint so the operator can tell the radio
  // is alive and the issue is "wrong tag in range" not "scanner broken".
  String? _otherEpc;
  int? _otherRssi;
  DateTime? _otherSeenAt;

  String get _epcUpper => (widget.targetEpc ?? '').trim().toUpperCase();
  bool get _epcValid => _epc24.hasMatch(_epcUpper);

  @override
  void initState() {
    super.initState();
    _audio = AudioPlayer()
      ..setReleaseMode(ReleaseMode.stop)
      ..setPlayerMode(PlayerMode.lowLatency);
    _beepBytes = buildGeigerBeepWav();
    _sweep = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 2200),
    );
    _bloom = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 280),
      lowerBound: 0,
      upperBound: 1,
    );
    // Switch the manager into geiger routing immediately. Pre-1.2.41 this
    // ran in a postFrame callback, which left a small window where the
    // listener was attached but reads were still going to the unified
    // sink. Setting it here closes that window — and we re-assert it on
    // every scan toggle for belt-and-braces safety.
    unawaited(ScanSounds.instance.init());
    // CRITICAL for Locate UX: silence the native per-tag-read beep that
    // ScanSoundPool fires from inside CarbonChainwayRfidController.emitEpc
    // / CarbonZebraRfidController.emitTag. Without this, every tag in the
    // antenna's field fires a beep — at 8 dBm in a packed bin area the
    // operator gets a constant rattle that swamps the proximity beep
    // _playBeep() drives. Result the operator sees today: "beeping like
    // crazy without logic, doesn't slow/speed when I pull away." With
    // this suppressed the only beep is _scheduleBeeps' proximity-driven
    // cadence (target match only), which actually correlates with the %
    // bar. Restored on dispose so Count / Status Change / Encode still
    // get their per-tag beep.
    unawaited(ScanSounds.instance.setTagBeepSuppressed(true));
    // Lock the device to RFID-only mode on entry. Geiger search uses 2D;
    // when the operator picks a result and lands here we must flip the
    // trigger back to UHF and physically close the 2D engine on Chainway
    // so a stray laser can't fire mid-sweep.
    unawaited(RfidVendorChannel.setZebraTriggerModeRfid());
    unawaited(RfidVendorChannel.enableRfidFunctionMode());
    unawaited(RfidVendorChannel.close2dBarcode());
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
      _rfid = context.read<RfidManager>();
      _rfid!.scanContext = 'GEIGER_FIND';
    }
  }

  @override
  void dispose() {
    _beepTimer?.cancel();
    _staleTimer?.cancel();
    _sweep.dispose();
    _bloom.dispose();
    unawaited(_readSub?.cancel());
    unawaited(_triggerSub?.cancel());
    unawaited(_rfid?.stopLocateScanning());
    unawaited(_audio.dispose());
    // Restore the per-tag native beep so Count / Status Change / etc.
    // get their feedback back on the next screen.
    unawaited(ScanSounds.instance.setTagBeepSuppressed(false));
    // Re-open the 2D engine so the next screen (which may need barcode
    // scanning) doesn't inherit a powered-off imager.
    unawaited(RfidVendorChannel.open2dBarcode());
    super.dispose();
  }

  // ── Toggle scan ──────────────────────────────────────────────────────────

  Future<void> _toggleScan() async {
    if (_scanning) {
      await _stopScan();
    } else {
      await _startScan();
    }
  }

  Future<void> _startScan() async {
    final m = _rfid;
    if (m == null || !_epcValid) return;
    ScanSounds.instance.play(ScanCue.start);
    // Re-assert the geiger routing flag every start. If the operator
    // navigated through another scan-using screen (Count, Putaway) and
    // came back, the manager's _scanContext could have been flipped to
    // a non-geiger context — that would silently send reads only to the
    // unified sink and leave this screen on 0%.
    m.scanContext = 'GEIGER_FIND';
    setState(() {
      _scanning = true;
      _liveRssi = null;
      _proximity01 = 0;
      _lastTargetReadAt = null;
      _otherEpc = null;
      _otherRssi = null;
      _otherSeenAt = null;
      _targetReads = 0;
      _otherReads = 0;
      _nullRssiReads = 0;
      _lastSeenEpcs.clear();
      _lastSeenRssi = null;
    });
    _sweep
      ..reset()
      ..repeat();
    _bloom.value = 0;
    // Attach the listener BEFORE starting the inventory so the very first
    // tag-read after sled bring-up is captured. Pre-fix, attach happened
    // after startLocateScanning, which on fast Zebras meant the first ~50ms
    // of reads bypassed _onGeigerRead entirely.
    await _readSub?.cancel();
    _readSub = m.geigerTagReads.listen(_onGeigerRead);
    await m.startLocateScanning();
    _scheduleBeeps();
    _scheduleStaleSweep();
  }

  Future<void> _stopScan() async {
    ScanSounds.instance.play(ScanCue.stop);
    _beepTimer?.cancel();
    _beepTimer = null;
    _staleTimer?.cancel();
    _staleTimer = null;
    _sweep.stop();
    _bloom.animateTo(0, duration: const Duration(milliseconds: 220));
    await _readSub?.cancel();
    _readSub = null;
    await _rfid?.stopLocateScanning();
    if (!mounted) return;
    setState(() {
      _scanning = false;
      _liveRssi = null;
      _proximity01 = 0;
      _lastTargetReadAt = null;
    });
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

  void _onGeigerRead(RfidTagRead read) {
    if (!_scanning) return;
    if (!mounted) return;
    final epc = read.epcHex24.toUpperCase();
    final matched = _matchesTarget(epc);
    // Logcat trace for every read seen by this screen — survives release
    // builds (developer.log writes to platform logging, unlike print()).
    // Pair with LOCATE_RFID logs from rfid_manager; together they reveal
    // whether reads arrive at all AND whether the match logic accepts
    // them. Filter on device: `adb logcat -s flutter:*`.
    developer.log(
      'epc=$epc target=$_epcUpper match=$matched rssi=${read.rssi}',
      name: 'LOCATE_SCREEN',
    );
    // Maintain a rolling 3-deep buffer of EPCs heard (any tag) so the
    // on-screen diagnostic banner can show whether reads are arriving
    // at all. The previous "stuck at 0%" reports were impossible to
    // diagnose without this — operator couldn't tell whether the radio
    // was silent or whether the target match was failing.
    final readRssi = read.rssi;
    setState(() {
      if (readRssi != null) _lastSeenRssi = readRssi;
      if (_lastSeenEpcs.isEmpty || _lastSeenEpcs.first != epc) {
        _lastSeenEpcs.insert(0, epc);
        if (_lastSeenEpcs.length > 3) _lastSeenEpcs.removeLast();
      }
    });
    if (matched) {
      // RSSI fallback: some Zebra firmware streams matches with rssi=null
      // for a few ticks before settling. Pre-fix, that meant the % stayed
      // at 0 even though the tag was clearly in range. We now treat
      // "matched EPC but rssi unknown" as a mid-strength signal
      // (~-65 dBm → ~43%) so the operator gets immediate feedback that
      // the radio has heard the target — and the value updates as soon
      // as a real RSSI arrives.
      const fallbackRssiOnNull = -65;
      final effectiveRssi = read.rssi ?? _liveRssi ?? fallbackRssiOnNull;
      setState(() {
        _liveRssi = effectiveRssi;
        _proximity01 = rssiToProximity01(effectiveRssi);
        _lastTargetReadAt = DateTime.now();
        _targetReads += 1;
        if (read.rssi == null) _nullRssiReads += 1;
      });
      // Drive the proximity bloom — animates 0..1 → halo grows / glow gets
      // brighter as the operator closes in. Smoother than direct setState
      // because the controller eases between values.
      _bloom.animateTo(_proximity01, duration: const Duration(milliseconds: 180));
      return;
    }
    setState(() => _otherReads += 1);
    // Track the strongest non-target tag. Only used as a "we're alive but
    // wrong tag in range" diagnostic — does not affect the percentage.
    final r = read.rssi;
    if (r != null && (r > (_otherRssi ?? -200))) {
      setState(() {
        _otherEpc = epc;
        _otherRssi = r;
        _otherSeenAt = DateTime.now();
      });
    }
  }

  /// Decay the target proximity if we haven't heard from the tag in a while.
  /// Pre-1.2.39 used a 750 ms window which made the meter look broken when
  /// the reader's tag-rate dipped to 1 Hz on weak signals. 1500 ms keeps
  /// the dial steady on real-world reads.
  void _scheduleStaleSweep() {
    _staleTimer?.cancel();
    _staleTimer = Timer.periodic(const Duration(milliseconds: 250), (_) {
      if (!mounted || !_scanning) return;
      final last = _lastTargetReadAt;
      if (last == null) return;
      final age = DateTime.now().difference(last).inMilliseconds;
      if (age > 1500 && _proximity01 > 0) {
        // Smooth decay rather than hard reset to 0 — 0.85x per tick → reaches
        // ~0.05 in 1.5s of silence, feels like the signal "fading out".
        final next = (_proximity01 * 0.85);
        setState(() {
          _proximity01 = next < 0.04 ? 0 : next;
          if (_proximity01 == 0) _liveRssi = null;
        });
        _bloom.animateTo(_proximity01,
            duration: const Duration(milliseconds: 220));
      }
    });
  }

  void _scheduleBeeps() {
    _beepTimer?.cancel();
    void tick() {
      if (!_scanning || !mounted) return;
      if (_proximity01 <= 0.02) {
        // Out of range — silent, only the radar sweep continues.
        _beepTimer = Timer(const Duration(milliseconds: 220), tick);
        return;
      }
      unawaited(_playBeep(_proximity01));
      const minMs = 60;
      const maxMs = 820;
      final delayMs =
          (maxMs - _proximity01 * (maxMs - minMs)).round().clamp(minMs, maxMs);
      _beepTimer = Timer(Duration(milliseconds: delayMs), tick);
    }

    tick();
  }

  Future<void> _playBeep(double proximity) async {
    final bytes = _beepBytes;
    if (bytes == null) return;
    final volume = (0.30 + 0.70 * proximity).clamp(0.0, 1.0);
    try {
      await _audio.stop();
      await _audio.setVolume(volume);
      await _audio.play(BytesSource(bytes));
    } catch (_) {
      /* audio unavailable — silent fallback */
    }
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
                rssi: _liveRssi,
                epcValid: _epcValid,
              ),
              SizedBox(height: 24.h),
              Expanded(
                child: Center(
                  child: _RadarVisualizer(
                    sweep: _sweep,
                    bloom: _bloom,
                    scanning: _scanning,
                    proximity01: _proximity01,
                  ),
                ),
              ),
              _DiagnosticHint(
                scanning: _scanning,
                hasTargetSignal: _liveRssi != null,
                otherEpc: _otherEpc,
                otherRssi: _otherRssi,
                otherSeenAt: _otherSeenAt,
              ),
              if (_scanning)
                _LiveDiagnosticBanner(
                  targetReads: _targetReads,
                  otherReads: _otherReads,
                  nullRssiReads: _nullRssiReads,
                  lastSeenEpcs: _lastSeenEpcs,
                  lastSeenRssi: _lastSeenRssi,
                  targetEpc: _epcUpper,
                  liveProximity01: _proximity01,
                ),
              SizedBox(height: 12.h),
              _ToggleScanButton(
                scanning: _scanning,
                enabled: _epcValid,
              ),
              SizedBox(height: 8.h),
              const RfidPowerSlider(),
              SizedBox(height: 4.h),
            ],
          ),
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Header — EPC (left) / BIN (right)
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
  final int? rssi;
  final bool epcValid;

  @override
  Widget build(BuildContext context) {
    final String label;
    if (!epcValid) {
      label = 'NO TARGET';
    } else if (scanning) {
      label = 'SCANNING · PULL TRIGGER TO STOP';
    } else {
      label = 'PULL TRIGGER TO LOCATE';
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
          Text(
            rssi != null ? 'RSSI: $rssi dBm' : 'RSSI: —',
            style: GoogleFonts.spaceGrotesk(
              fontSize: 11.sp,
              fontWeight: FontWeight.w500,
              color: const Color(0xFF3D4949),
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
    )..repeat(reverse: true);
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
    return AnimatedBuilder(
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
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Radar visualizer — sweeping cone + proximity bloom + central dial
// ═══════════════════════════════════════════════════════════════════════════

class _RadarVisualizer extends StatelessWidget {
  const _RadarVisualizer({
    required this.sweep,
    required this.bloom,
    required this.scanning,
    required this.proximity01,
  });

  final AnimationController sweep;
  final AnimationController bloom;
  final bool scanning;
  final double proximity01;

  @override
  Widget build(BuildContext context) {
    final pct = (proximity01 * 100).round();
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
                // Outer faint disc — establishes the radar "field"
                Container(
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: AppColors.primary.withValues(alpha: 0.04),
                  ),
                ),
                // Three faint range circles (no animation, subtle reference)
                ..._rangeCircles(size),
                // Bloom halo — scales + glows with proximity
                AnimatedBuilder(
                  animation: bloom,
                  builder: (_, __) {
                    final p = bloom.value;
                    return Container(
                      width: (size * (0.55 + 0.30 * p)),
                      height: (size * (0.55 + 0.30 * p)),
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: AppColors.primary
                            .withValues(alpha: 0.10 + 0.20 * p),
                        boxShadow: [
                          BoxShadow(
                            color: AppColors.primary
                                .withValues(alpha: 0.25 + 0.40 * p),
                            blurRadius: 30 + 70 * p,
                            spreadRadius: 4 + 12 * p,
                          ),
                        ],
                      ),
                    );
                  },
                ),
                // Rotating sweep cone
                if (scanning)
                  AnimatedBuilder(
                    animation: sweep,
                    builder: (_, __) => CustomPaint(
                      size: Size(size, size),
                      painter: _SweepPainter(
                        angle: sweep.value * 2 * math.pi,
                        proximity: proximity01,
                      ),
                    ),
                  ),
                // Central dial
                _CoreDial(percent: pct),
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
  const _DiagnosticHint({
    required this.scanning,
    required this.hasTargetSignal,
    required this.otherEpc,
    required this.otherRssi,
    required this.otherSeenAt,
  });

  final bool scanning;
  final bool hasTargetSignal;
  final String? otherEpc;
  final int? otherRssi;
  final DateTime? otherSeenAt;

  bool get _showOther {
    if (!scanning || hasTargetSignal) return false;
    if (otherEpc == null || otherSeenAt == null) return false;
    return DateTime.now().difference(otherSeenAt!) <
        const Duration(seconds: 5);
  }

  @override
  Widget build(BuildContext context) {
    if (!_showOther) {
      return SizedBox(height: 32.h);
    }
    return Container(
      height: 32.h,
      alignment: Alignment.center,
      child: Text(
        'TARGET NOT IN RANGE · NEAREST: ${otherEpc!.substring(otherEpc!.length - 8)} (${otherRssi}dBm)',
        textAlign: TextAlign.center,
        style: GoogleFonts.spaceGrotesk(
          fontSize: 10.sp,
          fontWeight: FontWeight.w600,
          letterSpacing: 1.2,
          color: const Color(0xFF6D7979),
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Trigger-only banner. Operator feedback (1.2.41): on-screen tap-to-locate
// was an extra step the operator had to remember mid-sweep. The locate flow
// is now driven entirely by the physical trigger; this widget is a status
// affordance, not a button — it never receives taps.
// ═══════════════════════════════════════════════════════════════════════════

class _ToggleScanButton extends StatelessWidget {
  const _ToggleScanButton({
    required this.scanning,
    required this.enabled,
  });

  final bool scanning;
  final bool enabled;

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
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            scanning ? Icons.stop_circle_outlined : Icons.sensors,
            color: Colors.white,
            size: 22.sp,
          ),
          SizedBox(width: 12.w),
          Text(
            scanning ? 'PULL TRIGGER TO STOP' : 'PULL TRIGGER TO LOCATE',
            style: GoogleFonts.manrope(
              fontSize: 15.sp,
              fontWeight: FontWeight.w800,
              letterSpacing: 2.0,
              color: Colors.white,
            ),
          ),
        ],
      ),
    );
  }
}

/// Live diagnostic banner — visible only while scanning. Shows the data
/// that lets the operator (and the dev) see exactly why the % is or
/// isn't climbing:
///   * counts: target / others / no-RSSI
///   * last seen EPC + RSSI (any tag)
///   * computed proximity %
/// If TARGET stays at 0 while OTHERS climbs, the radio hears tags but
/// the EPC match is failing — operator should compare LAST SEEN against
/// TARGET to spot a format mismatch. If both stay at 0, the radio isn't
/// hearing anything.
class _LiveDiagnosticBanner extends StatelessWidget {
  const _LiveDiagnosticBanner({
    required this.targetReads,
    required this.otherReads,
    required this.nullRssiReads,
    required this.lastSeenEpcs,
    required this.lastSeenRssi,
    required this.targetEpc,
    required this.liveProximity01,
  });

  final int targetReads;
  final int otherReads;
  final int nullRssiReads;
  final List<String> lastSeenEpcs;
  final int? lastSeenRssi;
  final String targetEpc;
  final double liveProximity01;

  @override
  Widget build(BuildContext context) {
    final pctNum = (liveProximity01 * 100).clamp(0, 100).toStringAsFixed(0);
    final tone = targetReads > 0
        ? const Color(0xFF1B7F4F)            // green — match found
        : (otherReads > 0
            ? const Color(0xFFB87A00)         // amber — radio alive, no match
            : const Color(0xFFB23A3A));       // red — radio silent
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
                padding: EdgeInsets.symmetric(horizontal: 6.w, vertical: 2.h),
                color: tone,
                child: Text(
                  targetReads > 0
                      ? 'MATCH $pctNum%'
                      : (otherReads > 0 ? 'NO MATCH' : 'NO READS'),
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 10.sp,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 1.4,
                    color: Colors.white,
                  ),
                ),
              ),
              SizedBox(width: 8.w),
              Text(
                'TGT $targetReads · OTH $otherReads'
                '${nullRssiReads > 0 ? ' · NULL-RSSI $nullRssiReads' : ''}'
                '${lastSeenRssi != null ? ' · ${lastSeenRssi}dBm' : ''}',
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 10.sp,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 0.8,
                  color: const Color(0xFF333333),
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
          if (lastSeenEpcs.isNotEmpty)
            ...lastSeenEpcs.map(
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
  }
}
