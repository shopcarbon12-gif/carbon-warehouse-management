import 'dart:async';
import 'dart:math' as math;

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/audio/geiger_beep_wav.dart';
import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/hardware/rfid_tag_read.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Map RSSI (dBm) to 0–1 proximity. Typical UHF range:
///   -90 dBm → far edge (0.0)
///   -30 dBm → on top of the tag (1.0)
double rssiToProximity01(int? rssi) {
  if (rssi == null) return 0;
  const weak = -90.0;
  const strong = -30.0;
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
  });

  final String? targetEpc;
  final String? targetBin;

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
  Timer? _beepTimer;
  Timer? _staleTimer;

  late final AnimationController _sweep; // radar rotation
  late final AnimationController _bloom; // proximity-driven halo bloom

  bool _scanning = false;
  int? _liveRssi;
  double _proximity01 = 0;
  DateTime? _lastTargetReadAt;

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
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      context.read<RfidManager>().scanContext = 'GEIGER_FIND';
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _rfid ??= context.read<RfidManager>();
  }

  @override
  void dispose() {
    _beepTimer?.cancel();
    _staleTimer?.cancel();
    _sweep.dispose();
    _bloom.dispose();
    unawaited(_readSub?.cancel());
    unawaited(_rfid?.stopLocateScanning());
    unawaited(_audio.dispose());
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
    setState(() {
      _scanning = true;
      _liveRssi = null;
      _proximity01 = 0;
      _lastTargetReadAt = null;
      _otherEpc = null;
      _otherRssi = null;
      _otherSeenAt = null;
    });
    _sweep
      ..reset()
      ..repeat();
    _bloom.value = 0;
    await m.startLocateScanning();
    await _readSub?.cancel();
    _readSub = m.geigerTagReads.listen(_onGeigerRead);
    _scheduleBeeps();
    _scheduleStaleSweep();
  }

  Future<void> _stopScan() async {
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

  void _onGeigerRead(RfidTagRead read) {
    if (!_scanning) return;
    if (!mounted) return;
    final epc = read.epcHex24.toUpperCase();
    if (epc == _epcUpper) {
      setState(() {
        _liveRssi = read.rssi ?? _liveRssi;
        _proximity01 = rssiToProximity01(_liveRssi);
        _lastTargetReadAt = DateTime.now();
      });
      // Drive the proximity bloom — animates 0..1 → halo grows / glow gets
      // brighter as the operator closes in. Smoother than direct setState
      // because the controller eases between values.
      _bloom.animateTo(_proximity01, duration: const Duration(milliseconds: 180));
      return;
    }
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
              _HeaderRow(epc: _epcUpper, bin: widget.targetBin),
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
              SizedBox(height: 12.h),
              _ToggleScanButton(
                scanning: _scanning,
                enabled: _epcValid,
                onTap: () => unawaited(_toggleScan()),
              ),
              SizedBox(height: 16.h),
              Container(
                width: double.infinity,
                height: 16.h,
                color: const Color(0xFFBA1A1A),
              ),
              SizedBox(height: 8.h),
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
  const _HeaderRow({required this.epc, required this.bin});
  final String epc;
  final String? bin;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Expanded(
          child: Column(
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
          ),
        ),
        SizedBox(width: 12.w),
        Column(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Text(
              'BIN',
              style: GoogleFonts.spaceGrotesk(
                fontSize: 11.sp,
                fontWeight: FontWeight.w700,
                letterSpacing: 2.4,
                color: const Color(0xFF6D7979),
              ),
            ),
            SizedBox(height: 2.h),
            Text(
              (bin == null || bin!.isEmpty) ? '—' : bin!,
              style: GoogleFonts.spaceGrotesk(
                fontSize: 20.sp,
                fontWeight: FontWeight.w700,
                color: AppColors.primary,
              ),
            ),
          ],
        ),
      ],
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
      label = 'SCANNING ACTIVE';
    } else {
      label = 'TAP TO START';
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
// Tap-to-toggle button (was hold-to-locate in the first 1.2.39 cut)
// ═══════════════════════════════════════════════════════════════════════════

class _ToggleScanButton extends StatelessWidget {
  const _ToggleScanButton({
    required this.scanning,
    required this.enabled,
    required this.onTap,
  });

  final bool scanning;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final Color bg;
    if (!enabled) {
      bg = const Color(0xFFBCC9C9);
    } else if (scanning) {
      // Stop state — tonal red so the operator can find it instantly without
      // reading the label. Still rectangular per the design system's "no
      // soft corners" rule.
      bg = const Color(0xFFBA1A1A);
    } else {
      bg = AppColors.primary;
    }
    return GestureDetector(
      onTap: enabled ? onTap : null,
      child: AnimatedContainer(
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
              scanning ? 'TAP TO STOP' : 'TAP TO LOCATE',
              style: GoogleFonts.manrope(
                fontSize: 16.sp,
                fontWeight: FontWeight.w800,
                letterSpacing: 2.4,
                color: Colors.white,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
