import 'dart:async';
import 'dart:collection';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/hardware/rfid_tag_read.dart';
import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// dBm → 0–100 normalized scale. Matches `CarbonChainwayRfidController.normalizeRssi`
/// so the audio (native) and the UI (Dart) agree on a single proximity number.
int normalizeRssi(int? dbm) {
  if (dbm == null || dbm == 0) return 0;
  final clamped = dbm.clamp(-90, -40);
  return ((clamped + 90) * 2).clamp(0, 100).toInt();
}

/// Rebuild of the Locate / Geiger screen. Visual spec from
/// `stitch gei/code.html` + DESIGN.md; behavior derived from the live
/// recon under `geiger_recon/`. Key invariants from the recon:
///
/// * Beep is per-tag-read (fired natively from the SDK callback), not
///   timer-driven. Volume scales with RSSI inside [ScanSoundPool.playTagBeep].
/// * Top RSSI = rolling 1-second average; bottom strip / proximity bar =
///   instantaneous. PING(S) = matching reads in the last second.
/// * "Searching..." → "FOUND" latches on the first matching read and stays
///   FOUND until the screen is reset (or the user hits Stop and re-enters).
/// * Filter slider Close ↔ Far is a UI-level RSSI threshold (visual filter).
///   Reads below threshold zero the proximity bar but are still counted in
///   PING(S) and the rolling average.
class LocateTagScreen extends StatefulWidget {
  const LocateTagScreen({super.key, this.targetEpc});

  /// 24-char hex EPC. When null/blank the screen shows an entry prompt and
  /// keeps scanning disabled until a target is supplied.
  final String? targetEpc;

  @override
  State<LocateTagScreen> createState() => _LocateTagScreenState();
}

class _LocateTagScreenState extends State<LocateTagScreen> {
  static final RegExp _epc24 = RegExp(r'^[0-9A-F]{24}$');

  RfidManager? _rfid;
  StreamSubscription<RfidTagRead>? _geoSub;
  StreamSubscription<String>? _triggerSub;
  Timer? _uiTicker;

  /// Sliding 1-second window of `(timestamp, normalized RSSI)` for matching
  /// reads. Used for the rolling average + per-second ping count.
  final Queue<_TagSample> _window = Queue<_TagSample>();

  bool _scanning = false;
  bool _foundLatched = false;
  int? _liveRssiNorm;       // last instantaneous normalized RSSI (0–100)
  int _avgRssiNorm = 0;     // rolling 1-second average, normalized
  int _pingsLastSecond = 0; // matching reads in last second

  /// Filter slider 0..100 — reads with normalized RSSI below this threshold
  /// don't drive the proximity bar (visual gate only).
  double _filterThreshold = 0;

  late final TextEditingController _epcEntry;
  String? _target; // 24-char hex EPC, validated

  @override
  void initState() {
    super.initState();
    final initial = widget.targetEpc?.trim().toUpperCase() ?? '';
    _epcEntry = TextEditingController(text: initial);
    if (_epc24.hasMatch(initial)) _target = initial;

    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      context.read<RfidManager>().scanContext = 'GEIGER_FIND';
      await _pushTargetToNative();
      await RfidVendorChannel.setGeigerEnabled(true);
    });

    _uiTicker = Timer.periodic(const Duration(milliseconds: 200), (_) {
      _recomputeWindow();
      if (mounted) setState(() {});
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _rfid ??= context.read<RfidManager>();
    _bindTriggerStream();
  }

  Future<void> _pushTargetToNative() async {
    await RfidVendorChannel.setGeigerTarget(_target);
  }

  void _bindTriggerStream() {
    _triggerSub ??= RfidVendorChannel.hardwareTriggerStream().listen(
      (event) {
        if (event == 'down') {
          unawaited(_setHold(true));
        } else if (event == 'up') {
          unawaited(_setHold(false));
        }
      },
      onError: (_) {/* ignore — trigger is best-effort */},
    );
  }

  @override
  void dispose() {
    _uiTicker?.cancel();
    unawaited(_triggerSub?.cancel());
    unawaited(_geoSub?.cancel());
    unawaited(_rfid?.stopLocateScanning());
    unawaited(RfidVendorChannel.setGeigerEnabled(false));
    unawaited(RfidVendorChannel.setGeigerTarget(null));
    // Restore default scan context so the next screen runs ghost-filtered ingest.
    _rfid?.scanContext = 'TRANSFER';
    _epcEntry.dispose();
    super.dispose();
  }

  // --- read pipeline ------------------------------------------------------

  void _onGeigerRead(RfidTagRead read) {
    final t = _target;
    if (t == null) return;
    if (read.epcHex24 != t) return;
    if (!_foundLatched) _foundLatched = true;
    final norm = normalizeRssi(read.rssi);
    final now = DateTime.now();
    _window.addLast(_TagSample(now, norm));
    _liveRssiNorm = norm;
    _recomputeWindow();
  }

  void _recomputeWindow() {
    final cutoff = DateTime.now().subtract(const Duration(seconds: 1));
    while (_window.isNotEmpty && _window.first.t.isBefore(cutoff)) {
      _window.removeFirst();
    }
    if (_window.isEmpty) {
      _avgRssiNorm = 0;
      _pingsLastSecond = 0;
      // Instantaneous fades to 0 once reads stop arriving. Native side
      // is silent when no tag is in range, so the UI follows suit.
      _liveRssiNorm = 0;
      return;
    }
    var sum = 0;
    for (final s in _window) {
      sum += s.norm;
    }
    _avgRssiNorm = (sum / _window.length).round().clamp(0, 100);
    _pingsLastSecond = _window.length;
  }

  // --- scanning -----------------------------------------------------------

  Future<void> _setHold(bool on) async {
    if (on) {
      if (_scanning) return;
      if (_target == null) return;
      setState(() {
        _scanning = true;
      });
      final m = _rfid;
      if (m == null) return;
      await m.startLocateScanning();
      await _geoSub?.cancel();
      _geoSub = m.geigerTagReads.listen(_onGeigerRead);
    } else {
      if (!_scanning) return;
      await _geoSub?.cancel();
      _geoSub = null;
      await _rfid?.stopLocateScanning();
      // Drain the per-second window so RSSI/PING fade to zero immediately
      // on release — matches the recon (release → silence, no decay tail).
      _window.clear();
      if (mounted) {
        setState(() {
          _scanning = false;
          _liveRssiNorm = 0;
          _avgRssiNorm = 0;
          _pingsLastSecond = 0;
        });
      }
    }
  }

  Future<void> _resetLatch() async {
    setState(() {
      _foundLatched = false;
      _window.clear();
      _liveRssiNorm = 0;
      _avgRssiNorm = 0;
      _pingsLastSecond = 0;
    });
  }

  void _onEpcSubmitted(String raw) {
    final v = raw.trim().toUpperCase();
    if (!_epc24.hasMatch(v)) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Need a 24-character hex EPC')),
      );
      return;
    }
    setState(() {
      _target = v;
      _foundLatched = false;
      _window.clear();
      _liveRssiNorm = 0;
      _avgRssiNorm = 0;
      _pingsLastSecond = 0;
    });
    unawaited(_pushTargetToNative());
  }

  // --- view ---------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      pageTitle: 'GEIGER ASSET',
      body: SafeArea(
        child: Padding(
          padding: EdgeInsets.fromLTRB(16.r, 12.r, 16.r, 12.r),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _GeigerHeader(target: _target),
              SizedBox(height: 12.h),
              _GeigerStateBand(found: _foundLatched, scanning: _scanning),
              SizedBox(height: 16.h),
              _GeigerMetrics(
                pings: _pingsLastSecond,
                rssiAvgNorm: _avgRssiNorm,
              ),
              Expanded(
                child: _ProximityBar(
                  // Above the threshold the bar shows the live (instantaneous)
                  // value; below threshold the bar is zeroed but the data still
                  // flows into PING(S) / avg RSSI.
                  fill01: _proximityFor(_liveRssiNorm),
                  scanning: _scanning,
                ),
              ),
              SizedBox(height: 12.h),
              _FilterSlider(
                value: _filterThreshold,
                onChanged: (v) => setState(() => _filterThreshold = v),
                liveInstantaneous: _liveRssiNorm ?? 0,
              ),
              SizedBox(height: 14.h),
              if (_target == null) _EpcEntryField(
                controller: _epcEntry,
                onSubmitted: _onEpcSubmitted,
              ),
              if (_target != null) _GeigerActions(
                scanning: _scanning,
                onHoldStart: () => unawaited(_setHold(true)),
                onHoldEnd: () => unawaited(_setHold(false)),
                onReset: _foundLatched ? _resetLatch : null,
              ),
            ],
          ),
        ),
      ),
    );
  }

  double _proximityFor(int? norm) {
    if (norm == null || norm <= 0) return 0;
    if (norm < _filterThreshold) return 0;
    return (norm / 100.0).clamp(0.0, 1.0);
  }
}

class _TagSample {
  const _TagSample(this.t, this.norm);
  final DateTime t;
  final int norm;
}

// ===========================================================================
// Visual building blocks. Layout follows stitch gei/code.html: tactical
// header strip, status band, paired metric tiles, central proximity bar,
// filter slider, hold-to-locate.
// ===========================================================================

class _GeigerHeader extends StatelessWidget {
  const _GeigerHeader({required this.target});
  final String? target;

  @override
  Widget build(BuildContext context) {
    final epcText = target ?? '— — —';
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
                  letterSpacing: 1.6,
                  color: AppColors.textMuted,
                ),
              ),
              SizedBox(height: 2.h),
              Text(
                epcText,
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 15.sp,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 0.4,
                  color: AppColors.textMain,
                ),
                overflow: TextOverflow.ellipsis,
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _GeigerStateBand extends StatelessWidget {
  const _GeigerStateBand({required this.found, required this.scanning});
  final bool found;
  final bool scanning;

  @override
  Widget build(BuildContext context) {
    final label = found ? 'FOUND' : (scanning ? 'Searching…' : 'IDLE');
    final color = found
        ? const Color(0xFF2E7D32)
        : (scanning ? AppColors.textMain : AppColors.textMuted);
    return Container(
      height: 56.h,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        // Cream band as in the reference UI screenshots — distinct from the
        // page background but no border (DESIGN.md "no-line" rule).
        color: const Color(0xFFFFFBE6),
        borderRadius: BorderRadius.circular(2),
      ),
      child: Text(
        label,
        style: GoogleFonts.manrope(
          fontSize: 28.sp,
          fontWeight: FontWeight.w800,
          letterSpacing: 1.2,
          color: color,
        ),
      ),
    );
  }
}

class _GeigerMetrics extends StatelessWidget {
  const _GeigerMetrics({required this.pings, required this.rssiAvgNorm});
  final int pings;
  final int rssiAvgNorm;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(child: _MetricTile(label: 'PING(S)', value: pings.toString())),
        SizedBox(width: 12.w),
        Expanded(child: _MetricTile(label: 'RSSI', value: rssiAvgNorm.toString())),
      ],
    );
  }
}

class _MetricTile extends StatelessWidget {
  const _MetricTile({required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: GoogleFonts.manrope(
            fontSize: 16.sp,
            fontWeight: FontWeight.w700,
            letterSpacing: 0.6,
            color: AppColors.textMain,
          ),
        ),
        SizedBox(height: 2.h),
        Text(
          value,
          style: GoogleFonts.manrope(
            fontSize: 40.sp,
            fontWeight: FontWeight.w800,
            color: AppColors.textMain,
            height: 1.0,
          ),
        ),
        SizedBox(height: 2.h),
        Text(
          'In Last Second',
          style: GoogleFonts.inter(
            fontSize: 12.sp,
            fontWeight: FontWeight.w400,
            color: AppColors.textMuted,
          ),
        ),
      ],
    );
  }
}

class _ProximityBar extends StatelessWidget {
  const _ProximityBar({required this.fill01, required this.scanning});
  final double fill01;
  final bool scanning;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: AspectRatio(
        // Tall vertical bar centered on the screen, matches the reference UI.
        aspectRatio: 0.18,
        child: LayoutBuilder(
          builder: (ctx, c) {
            final h = c.maxHeight;
            final fillH = (h * fill01.clamp(0.0, 1.0));
            return Stack(
              alignment: Alignment.bottomCenter,
              children: [
                // Track — light gray, no border.
                Container(
                  width: c.maxWidth,
                  height: h,
                  decoration: BoxDecoration(
                    color: const Color(0xFFEFEFEF),
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
                // Fill — green, anchored bottom.
                AnimatedContainer(
                  duration: const Duration(milliseconds: 90),
                  curve: Curves.easeOut,
                  width: c.maxWidth,
                  height: fillH,
                  decoration: BoxDecoration(
                    color: scanning ? const Color(0xFF3FA34D) : const Color(0xFFB7B7B7),
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _FilterSlider extends StatelessWidget {
  const _FilterSlider({
    required this.value,
    required this.onChanged,
    required this.liveInstantaneous,
  });

  final double value;
  final ValueChanged<double> onChanged;
  final int liveInstantaneous;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Text(
              'FILTER',
              style: GoogleFonts.manrope(
                fontSize: 11.sp,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.4,
                color: AppColors.primary,
              ),
            ),
            SizedBox(width: 12.w),
            Text(
              'Close',
              style: GoogleFonts.inter(
                fontSize: 12.sp,
                color: AppColors.textMuted,
              ),
            ),
            Expanded(
              child: SliderTheme(
                data: SliderTheme.of(context).copyWith(
                  trackHeight: 4,
                  thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 10),
                  activeTrackColor: AppColors.primary,
                  inactiveTrackColor: const Color(0xFFD7D7D7),
                  thumbColor: AppColors.primary,
                  overlayColor: AppColors.primary.withValues(alpha: 0.15),
                ),
                child: Slider(
                  min: 0,
                  max: 100,
                  value: value,
                  onChanged: onChanged,
                ),
              ),
            ),
            Text(
              'Far',
              style: GoogleFonts.inter(
                fontSize: 12.sp,
                color: AppColors.textMuted,
              ),
            ),
          ],
        ),
        SizedBox(height: 4.h),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(
              'Threshold ${value.round()}',
              style: GoogleFonts.spaceGrotesk(
                fontSize: 11.sp,
                fontWeight: FontWeight.w500,
                color: AppColors.textMuted,
              ),
            ),
            Text(
              'RSSI $liveInstantaneous',
              style: GoogleFonts.spaceGrotesk(
                fontSize: 11.sp,
                fontWeight: FontWeight.w500,
                color: AppColors.textMuted,
              ),
            ),
          ],
        ),
      ],
    );
  }
}

class _GeigerActions extends StatelessWidget {
  const _GeigerActions({
    required this.scanning,
    required this.onHoldStart,
    required this.onHoldEnd,
    required this.onReset,
  });

  final bool scanning;
  final VoidCallback onHoldStart;
  final VoidCallback onHoldEnd;
  final VoidCallback? onReset;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        SizedBox(
          width: double.infinity,
          height: 64.h,
          child: GestureDetector(
            // Press-and-hold semantics: pointer down = start, pointer up
            // (or cancel / leave) = stop. Long-press detector swallows the
            // initial down event so we use raw pointer listeners instead.
            behavior: HitTestBehavior.opaque,
            onTapDown: (_) => onHoldStart(),
            onTapUp: (_) => onHoldEnd(),
            onTapCancel: onHoldEnd,
            onLongPressStart: (_) => onHoldStart(),
            onLongPressEnd: (_) => onHoldEnd(),
            onLongPressCancel: onHoldEnd,
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 80),
              decoration: BoxDecoration(
                color: scanning
                    ? const Color(0xFF005C5E) // pressed teal
                    : AppColors.primary,
                borderRadius: BorderRadius.circular(2),
              ),
              alignment: Alignment.center,
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(
                    scanning ? Icons.sensors : Icons.sensors_outlined,
                    color: Colors.white,
                    size: 22.r,
                  ),
                  SizedBox(width: 10.w),
                  Text(
                    scanning ? 'LOCATING…' : 'HOLD TO LOCATE',
                    style: GoogleFonts.manrope(
                      fontSize: 15.sp,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 2.4,
                      color: Colors.white,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
        if (onReset != null) ...[
          SizedBox(height: 8.h),
          TextButton(
            onPressed: onReset,
            child: Text(
              'RESET FOUND STATE',
              style: GoogleFonts.inter(
                fontWeight: FontWeight.w600,
                color: AppColors.textMuted,
                letterSpacing: 1.2,
              ),
            ),
          ),
        ],
      ],
    );
  }
}

class _EpcEntryField extends StatelessWidget {
  const _EpcEntryField({required this.controller, required this.onSubmitted});
  final TextEditingController controller;
  final ValueChanged<String> onSubmitted;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'TARGET EPC',
          style: GoogleFonts.manrope(
            fontSize: 12.sp,
            fontWeight: FontWeight.w700,
            letterSpacing: 1.4,
            color: AppColors.textMuted,
          ),
        ),
        SizedBox(height: 6.h),
        TextField(
          controller: controller,
          textCapitalization: TextCapitalization.characters,
          inputFormatters: [
            FilteringTextInputFormatter.allow(RegExp(r'[0-9A-Fa-f]')),
            LengthLimitingTextInputFormatter(24),
          ],
          style: GoogleFonts.spaceGrotesk(
            fontSize: 14.sp,
            fontWeight: FontWeight.w600,
            letterSpacing: 1.0,
            color: AppColors.textMain,
          ),
          decoration: const InputDecoration(
            hintText: '24-char hex EPC',
          ),
          onSubmitted: onSubmitted,
        ),
        SizedBox(height: 6.h),
        Align(
          alignment: Alignment.centerRight,
          child: TextButton(
            onPressed: () => onSubmitted(controller.text),
            child: Text(
              'CONFIRM',
              style: GoogleFonts.manrope(
                fontWeight: FontWeight.w800,
                letterSpacing: 1.6,
                color: AppColors.primary,
              ),
            ),
          ),
        ),
      ],
    );
  }
}

