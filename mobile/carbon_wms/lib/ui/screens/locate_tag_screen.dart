import 'dart:async';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/audio/geiger_beep_wav.dart';
import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/hardware/rfid_tag_read.dart';
import 'package:carbon_wms/services/mobile_settings_repository.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';
import 'package:carbon_wms/ui/widgets/tactical_bottom_bar.dart';
import 'package:carbon_wms/util/demo_epc.dart';

/// Maps RSSI (dBm) to 0–1; typical UHF UI scale (~-90 weak … -30 strong).
double rssiToProximity01(int? rssi) {
  if (rssi == null) return 0;
  const weak = -90.0;
  const strong = -30.0;
  return ((rssi - weak) / (strong - weak)).clamp(0.0, 1.0);
}

/// Locate one tag using live RSSI + Geiger-style beeps while scanning.
class LocateTagScreen extends StatefulWidget {
  const LocateTagScreen({super.key, this.targetEpc});

  /// Optional pre-filled 24-char hex EPC.
  final String? targetEpc;

  @override
  State<LocateTagScreen> createState() => _LocateTagScreenState();
}

class _LocateTagScreenState extends State<LocateTagScreen> {
  final _targetCtrl = TextEditingController();
  late final AudioPlayer _audio;
  Uint8List? _beepBytes;

  RfidManager? _rfid;
  StreamSubscription<RfidTagRead>? _geoSub;
  Timer? _beepTimer;

  bool _holding = false;
  bool _tapScanOn = false;
  int? _liveRssi;
  double _proximity01 = 0;

  static final RegExp _epc24 = RegExp(r'^[0-9A-F]{24}$');

  @override
  void initState() {
    super.initState();
    _audio = AudioPlayer()
      ..setReleaseMode(ReleaseMode.stop)
      ..setPlayerMode(PlayerMode.lowLatency);
    _beepBytes = buildGeigerBeepWav();
    if (widget.targetEpc != null) {
      _targetCtrl.text = widget.targetEpc!.trim().toUpperCase();
    } else {
      _targetCtrl.text = '104499100000000000000001';
    }
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
    unawaited(_geoSub?.cancel());
    unawaited(_rfid?.stopLocateScanning());
    _targetCtrl.dispose();
    unawaited(_audio.dispose());
    super.dispose();
  }

  String? get _normalizedTarget {
    final t = _targetCtrl.text.trim().toUpperCase();
    if (!_epc24.hasMatch(t)) return null;
    return t;
  }

  Future<void> _playBeep() async {
    final bytes = _beepBytes;
    if (bytes == null) return;
    try {
      await _audio.stop();
      await _audio.play(BytesSource(bytes));
    } catch (_) {
      /* audio may be unavailable on some devices / simulators */
    }
  }

  void _scheduleGeigerBeeps() {
    _beepTimer?.cancel();
    void tick() {
      if ((!_holding && !_tapScanOn) || !mounted) return;
      final target = _normalizedTarget;
      if (target == null || _liveRssi == null) {
        _beepTimer = Timer(const Duration(milliseconds: 520), tick);
        return;
      }
      unawaited(_playBeep());
      const minMs = 68;
      const maxMs = 820;
      final p = _proximity01;
      final delayMs = (maxMs - p * (maxMs - minMs)).round().clamp(minMs, maxMs);
      _beepTimer = Timer(Duration(milliseconds: delayMs), tick);
    }

    tick();
  }

  void _onGeigerRead(RfidTagRead read) {
    final want = _normalizedTarget;
    if (want == null || read.epcHex24 != want) return;
    if (!mounted) return;
    setState(() {
      _liveRssi = read.rssi ?? _liveRssi;
      _proximity01 = rssiToProximity01(_liveRssi);
    });
  }

  Future<void> _beginScanning() async {
    final m = _rfid;
    if (m == null) return;
    await m.startLocateScanning();
    await _geoSub?.cancel();
    _geoSub = m.geigerTagReads.listen(_onGeigerRead);
    _scheduleGeigerBeeps();
  }

  Future<void> _endScanning() async {
    _beepTimer?.cancel();
    _beepTimer = null;
    await _geoSub?.cancel();
    _geoSub = null;
    await _rfid?.stopLocateScanning();
  }

  Future<void> _setHold(bool v) async {
    if (v) {
      if (_holding) return;
      setState(() {
        _holding = true;
        _liveRssi = null;
        _proximity01 = 0;
      });
      await _beginScanning();
    } else {
      if (!_holding) return;
      await _endScanning();
      if (mounted) {
        setState(() {
          _holding = false;
          _liveRssi = null;
          _proximity01 = 0;
        });
      }
    }
  }

  Future<void> _toggleTapScan() async {
    if (_tapScanOn) {
      await _endScanning();
      setState(() {
        _tapScanOn = false;
        _liveRssi = null;
        _proximity01 = 0;
      });
    } else {
      setState(() {
        _tapScanOn = true;
        _liveRssi = null;
        _proximity01 = 0;
      });
      await _beginScanning();
    }
  }

  void _debugPulseCloser() {
    final t = _normalizedTarget;
    if (t == null) return;
    final m = _rfid;
    if (m == null) return;
    final rssi = -35 - (DateTime.now().millisecond % 12);
    m.debugPulseLocateRead(t, rssi: rssi);
  }

  @override
  Widget build(BuildContext context) {
    final holdRelease = context.watch<MobileSettingsRepository>().config.triggerModeHoldRelease;
    final target = _normalizedTarget;
    final pct = (_proximity01 * 100).round();
    final rssiLabel = _liveRssi != null ? 'RSSI: $_liveRssi' : 'RSSI: —';

    return CarbonScaffold(
      pageTitle: 'LOCATE TAG',
      bottomBar: TacticalBottomBar(
        children: [
          if (holdRelease)
            TacticalEmeraldButton(
              label: 'HOLD TO LOCATE',
              onLongPressStart: () => unawaited(_setHold(true)),
              onLongPressEnd: () => unawaited(_setHold(false)),
            )
          else
            TacticalEmeraldButton(
              label: _tapScanOn ? 'STOP LOCATE' : 'TAP TO LOCATE',
              onPressed: () => unawaited(_toggleTapScan()),
            ),
        ],
      ),
      body: Padding(
        padding: EdgeInsets.all(16.r),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('TARGET EPC', style: AppTheme.headline(context)),
            SizedBox(height: 8.h),
            TextField(
              controller: _targetCtrl,
              enabled: !_holding && !_tapScanOn,
              onChanged: (_) => setState(() {}),
              style: const TextStyle(
                color: AppColors.textMain,
                fontWeight: FontWeight.w600,
                letterSpacing: 1.2,
              ),
              decoration: const InputDecoration(
                hintText: '24-char hex EPC',
              ),
            ),
            if (kDebugMode) ...[
              SizedBox(height: 8.h),
              TextButton(
                onPressed: (_holding || _tapScanOn) ? null : _debugPulseCloser,
                child: const Text('DEBUG: pulse strong RSSI (stub)'),
              ),
            ],
            SizedBox(height: 12.h),
            Text('SIMULATE OTHER TAG', style: AppTheme.headline(context)),
            SizedBox(height: 6.h),
            TextButton(
              onPressed: (_holding || _tapScanOn)
                  ? null
                  : () {
                      setState(() => _targetCtrl.text = randomDemoEpc());
                    },
              child: const Text('Fill random demo EPC'),
            ),
            const Spacer(),
            Center(
              child: _RadarMeter(proximity01: _proximity01, percentLabel: pct),
            ),
            SizedBox(height: 20.h),
            SelectableText(
              target ?? 'Enter a valid 24-character hex EPC',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: AppColors.textMain,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 0.8,
                  ),
            ),
            SizedBox(height: 8.h),
            Text(
              rssiLabel,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    color: AppColors.primary,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 1.1,
                  ),
            ),
            const Spacer(),
          ],
        ),
      ),
    );
  }
}

class _RadarMeter extends StatelessWidget {
  const _RadarMeter({
    required this.proximity01,
    required this.percentLabel,
  });

  final double proximity01;
  final int percentLabel;

  @override
  Widget build(BuildContext context) {
    final t = proximity01.clamp(0.0, 1.0);
    final ring = Color.lerp(AppColors.surface, AppColors.success, t)!;

    return SizedBox(
      width: 240.w,
      height: 240.h,
      child: Stack(
        alignment: Alignment.center,
        children: [
          SizedBox(
            width: 240.w,
            height: 240.h,
            child: CircularProgressIndicator(
              value: t,
              strokeWidth: 18,
              backgroundColor: AppColors.surface,
              color: ring,
              strokeCap: StrokeCap.round,
            ),
          ),
          Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                '$percentLabel%',
                style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                      color: AppColors.textMain,
                      fontWeight: FontWeight.w900,
                      letterSpacing: 0.5,
                    ),
              ),
              SizedBox(height: 4.h),
              Text(
                'PROXIMITY',
                style: Theme.of(context).textTheme.labelSmall?.copyWith(
                      color: AppColors.textMuted,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 1.6,
                    ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
