import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:device_info_plus/device_info_plus.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/hardware/rfid_tag_read.dart';
import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/scan_sounds.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';
import 'package:carbon_wms/hardware/hardware_trigger.dart';

/// Tag Test — measures how this gun hears this tag, at known distances.
///
/// ## What it's for
///
/// Every judgement the Locate/Geiger meter makes rests on one unknown: for
/// THESE labels, on THESE garments, read by THIS gun — how does signal
/// strength actually change with distance, and how far does each power level
/// reach? Nobody can answer that from a datasheet. It depends on the inlay,
/// what the tag is stuck to (denim absorbs, a metal rail reflects), how the
/// tag is folded, and the gun's own antenna.
///
/// So this module measures it directly, and the CSV it produces is the
/// calibration input for the meter.
///
/// ## How a run goes
///
///   1. Capture the target EPC at 5 dBm, with the tag ON the gun. Low power
///      is what makes this unambiguous — at 30 dBm you would capture half the
///      rack. Nothing more than a foot or so away can even answer.
///   2. Step 1: hold the tag physically touching the gun. Pull the trigger
///      once. Release it — no need to hold. Keep the tag still for the ~30 s
///      the sweep takes; the screen counts each level down.
///   3. Step 2: one foot away. Trigger again. Step 3: two feet. And so on.
///   4. Keep going until a step detects nothing at any power. That silence is
///      the measurement — it's the gun's real maximum range for this tag.
///   5. Upload. The CSV lands in Reports and can be downloaded from the web.
///
/// ## Why each trigger pull sweeps the power levels
///
/// The operator asked for one pull per step, and that is what this does — but
/// each pull measures at every power level in [kTagTestPowerLadderDbm] before
/// it stops — five seconds of listening per level, so roughly half a minute
/// per step.
///
/// That is deliberate, and it is the whole reason the run is worth doing.
/// Signal strength at 30 dBm alone cannot tell us whether a proximity design
/// should work by filtering on signal strength or by stepping the transmit
/// power down. Those two answers need different data:
///
///   * "how loud is it at this distance"  -> one power level is enough
///   * "does it still ANSWER at 10 dBm from here" -> needs every level
///
/// The second question is the one a power ladder lives or dies on, and it can
/// only be answered by asking the radio at each level. Measuring all of them
/// per step costs a few seconds now and saves a second trip round the
/// warehouse later.
class TagTestScreen extends StatefulWidget {
  const TagTestScreen({super.key});

  @override
  State<TagTestScreen> createState() => _TagTestScreenState();
}

/// Power levels measured at every step, strongest first. The top of this
/// ladder is the power the Locate screen runs at, so it is the reference
/// column; the rest answer "does it still respond quieter than that".
const List<int> kTagTestPowerLadderDbm = <int>[30, 25, 20, 15, 10, 5];

/// One (step, power level) measurement.
class _PowerSample {
  const _PowerSample({
    required this.powerDbm,
    required this.reads,
    required this.windowMs,
    this.peakRssi,
    this.meanRssi,
    this.minRssi,
  });

  final int powerDbm;
  final int reads;
  final int windowMs;
  final int? peakRssi;
  final double? meanRssi;
  final int? minRssi;

  bool get detected => reads > 0;
  double get readsPerSec => windowMs <= 0 ? 0 : reads * 1000 / windowMs;
}

/// One step of the run: the tag held at a known distance.
class _StepResult {
  _StepResult({
    required this.step,
    required this.distanceFt,
    required this.measuredAt,
    required this.samples,
  });

  final int step;
  final int distanceFt;
  final DateTime measuredAt;
  final List<_PowerSample> samples;

  bool get anyDetected => samples.any((s) => s.detected);

  /// Strongest reading at full power — the headline number for the row.
  _PowerSample? get atFullPower {
    for (final s in samples) {
      if (s.powerDbm == kTagTestPowerLadderDbm.first) return s;
    }
    return samples.isEmpty ? null : samples.first;
  }

  /// Lowest power that still heard the tag. This is the number a power-ladder
  /// design is built on: it converts "how loud" into "how close" without
  /// depending on an absolute signal reading at all.
  int? get lowestDetectingPower {
    int? lowest;
    for (final s in samples) {
      if (s.detected && (lowest == null || s.powerDbm < lowest)) {
        lowest = s.powerDbm;
      }
    }
    return lowest;
  }
}

class _TagTestScreenState extends State<TagTestScreen> {
  static final RegExp _epc24 = RegExp(r'^[0-9A-F]{24}$');

  /// Power used to capture the target EPC. Low enough that only a tag on (or
  /// within about a foot of) the gun can answer, so the capture is
  /// unambiguous in a rack full of other tags.
  static const int _captureDbm = 5;

  /// How long to listen at each power level once it has settled.
  ///
  /// Five seconds per level, so a full step is about half a minute. That is
  /// deliberate: the reading that matters most is at the FAR end of the run,
  /// where the tag answers only occasionally, and a short window there cannot
  /// tell "out of range" apart from "did not happen to answer in the last
  /// half second". A long window makes a recorded zero genuinely mean zero.
  static const int _sampleWindowMs = 5000;

  /// How often the on-screen counter refreshes during a sample window. A
  /// 30-second step with no visible progress reads as a hang.
  static const int _progressTickMs = 250;

  /// Settling time after a power change. The sled has to stop inventory,
  /// write the antenna config and restart, so reads in this window belong to
  /// the previous level and must not be counted.
  static const int _powerSettleMs = 350;

  final TextEditingController _epcCtrl = TextEditingController();
  final ScrollController _scroll = ScrollController();

  RfidManager? _rfid;
  StreamSubscription<RfidTagRead>? _readSub;
  StreamSubscription<String>? _triggerSub;

  String _epc = '';
  bool _busy = false;
  String _status = 'Enter or scan the tag EPC to begin.';
  bool _uploading = false;
  String? _uploadResult;

  final List<_StepResult> _steps = <_StepResult>[];

  /// Live collection buffer, filled by the read stream while a window is open.
  final List<int> _windowRssi = <int>[];
  int _windowReads = 0;
  String? _collectEpc;
  bool _collecting = false;

  /// EPC -> best RSSI, used only during the low-power capture pass.
  final Map<String, int> _captureHits = <String, int>{};
  bool _capturing = false;

  String _deviceModel = '';
  String _appVersion = '';

  @override
  void initState() {
    super.initState();
    unawaited(ScanSounds.instance.init());
    unawaited(RfidVendorChannel.setZebraTriggerModeRfid());
    unawaited(RfidVendorChannel.enableRfidFunctionMode());
    unawaited(RfidVendorChannel.close2dBarcode());
    unawaited(_loadDeviceInfo());
    _readSub = RfidVendorChannel.tagReadStream().listen(_onRead, onError: (_) {});
    _triggerSub = hardwareTriggerFor(this).listen((e) {
      if (!mounted || e != 'down') return;
      unawaited(_onTrigger());
    }, onError: (_) {});
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _rfid ??= context.read<RfidManager>();
  }

  @override
  void dispose() {
    unawaited(_readSub?.cancel());
    unawaited(_triggerSub?.cancel());
    unawaited(RfidVendorChannel.stopZebraInventory());
    unawaited(RfidVendorChannel.stopChainwayInventory());
    unawaited(RfidVendorChannel.setEpcInventoryFilter(null));
    unawaited(RfidVendorChannel.setSingulationSession(useSessionZero: false));
    unawaited(_rfid?.setSessionPowerOverrideDbm(null));
    unawaited(RfidVendorChannel.open2dBarcode());
    _epcCtrl.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _loadDeviceInfo() async {
    try {
      final info = await PackageInfo.fromPlatform();
      final android = await DeviceInfoPlugin().androidInfo;
      if (!mounted) return;
      setState(() {
        _appVersion = info.version;
        _deviceModel = '${android.manufacturer} ${android.model}'.trim();
      });
    } catch (_) {
      /* diagnostics only — a missing model never blocks a run */
    }
  }

  // ── Read plumbing ────────────────────────────────────────────────────────

  void _onRead(RfidTagRead read) {
    final epc = read.epcHex24;
    var rssi = read.rssi;
    // Same guard the Locate screen uses: only a plausible negative dBm counts
    // as a real reading. 0 or positive means "not reported", not "very loud".
    if (rssi != null && (rssi >= 0 || rssi <= -110)) rssi = null;

    if (_capturing) {
      if (rssi == null) return;
      final best = _captureHits[epc];
      if (best == null || rssi > best) _captureHits[epc] = rssi;
      return;
    }

    if (!_collecting) return;
    if (epc != _collectEpc) return;
    _windowReads++;
    if (rssi != null) _windowRssi.add(rssi);
  }

  Future<void> _onTrigger() async {
    if (_busy) return;
    if (!_epc24.hasMatch(_epc)) {
      await _captureEpc();
    } else {
      await _measureStep();
    }
  }

  // ── EPC capture at low power ─────────────────────────────────────────────

  Future<void> _captureEpc() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _status = 'Hold the tag ON the gun… capturing at $_captureDbm dBm';
    });
    ScanSounds.instance.play(ScanCue.start);
    _captureHits.clear();
    _capturing = true;
    try {
      await RfidVendorChannel.setEpcInventoryFilter(null);
      await _rfid?.setSessionPowerOverrideDbm(_captureDbm);
      await Future<void>.delayed(const Duration(milliseconds: 400));
      try {
        await RfidVendorChannel.startZebraInventory();
      } catch (_) {}
      try {
        await RfidVendorChannel.startChainwayInventory();
      } catch (_) {}
      await Future<void>.delayed(const Duration(milliseconds: 2500));
    } finally {
      _capturing = false;
      try {
        await RfidVendorChannel.stopZebraInventory();
      } catch (_) {}
      try {
        await RfidVendorChannel.stopChainwayInventory();
      } catch (_) {}
    }

    if (!mounted) return;
    if (_captureHits.isEmpty) {
      ScanSounds.instance.play(ScanCue.error);
      setState(() {
        _busy = false;
        _status =
            'No tag heard at $_captureDbm dBm. Put the tag against the gun and pull again.';
      });
      return;
    }
    // Strongest wins — at 5 dBm that is unambiguously the tag on the antenna.
    var bestEpc = '';
    var bestRssi = -999;
    _captureHits.forEach((epc, rssi) {
      if (rssi > bestRssi) {
        bestRssi = rssi;
        bestEpc = epc;
      }
    });
    ScanSounds.instance.play(ScanCue.success);
    setState(() {
      _epc = bestEpc;
      _epcCtrl.text = bestEpc;
      _busy = false;
      _status = _captureHits.length > 1
          ? 'Captured $bestEpc at $bestRssi dBm (${_captureHits.length} tags heard — strongest kept). '
              'Now hold the tag TOUCHING the gun and pull the trigger for step 1.'
          : 'Captured $bestEpc at $bestRssi dBm. '
              'Now hold the tag TOUCHING the gun and pull the trigger for step 1.';
    });
  }

  // ── One step: sweep every power level ────────────────────────────────────

  Future<void> _measureStep() async {
    if (_busy) return;
    final epc = _epc;
    if (!_epc24.hasMatch(epc)) return;

    final step = _steps.length + 1;
    final distanceFt = step - 1;
    setState(() {
      _busy = true;
      _uploadResult = null;
      _status = 'Step $step — measuring at $distanceFt ft '
          '(${kTagTestPowerLadderDbm.length} levels, ~'
          '${(kTagTestPowerLadderDbm.length * (_sampleWindowMs + _powerSettleMs) / 1000).round()}s)…';
    });
    ScanSounds.instance.play(ScanCue.start);

    final samples = <_PowerSample>[];
    try {
      // Gate the radio to this one tag so nothing else can pollute a reading,
      // and keep the tag answering every round rather than going quiet after
      // its first reply.
      await RfidVendorChannel.setEpcInventoryFilter(epc);
      await RfidVendorChannel.setSingulationSession(useSessionZero: true);

      for (final power in kTagTestPowerLadderDbm) {
        if (!mounted) break;
        setState(() => _status =
            'Step $step ($distanceFt ft) — $power dBm settling…');
        await _rfid?.setSessionPowerOverrideDbm(power);
        try {
          await RfidVendorChannel.startZebraInventory();
        } catch (_) {}
        try {
          await RfidVendorChannel.startChainwayInventory();
        } catch (_) {}
        // Let the power change land before anything is counted.
        await Future<void>.delayed(
          const Duration(milliseconds: _powerSettleMs),
        );

        _windowRssi.clear();
        _windowReads = 0;
        _collectEpc = epc;
        _collecting = true;
        // Sliced rather than one long await, purely so the operator can watch
        // the read count climb and the countdown run down.
        final levelIndex = kTagTestPowerLadderDbm.indexOf(power) + 1;
        var elapsed = 0;
        while (elapsed < _sampleWindowMs) {
          await Future<void>.delayed(
            const Duration(milliseconds: _progressTickMs),
          );
          elapsed += _progressTickMs;
          if (!mounted) break;
          final left = ((_sampleWindowMs - elapsed) / 1000).ceil();
          setState(() {
            _status = 'Step $step ($distanceFt ft) · $power dBm '
                '[$levelIndex/${kTagTestPowerLadderDbm.length}] · '
                '${left}s left · $_windowReads reads';
          });
        }
        _collecting = false;

        final rssi = List<int>.from(_windowRssi);
        samples.add(
          _PowerSample(
            powerDbm: power,
            reads: _windowReads,
            windowMs: _sampleWindowMs,
            peakRssi: rssi.isEmpty ? null : rssi.reduce(math.max),
            minRssi: rssi.isEmpty ? null : rssi.reduce(math.min),
            meanRssi: rssi.isEmpty
                ? null
                : rssi.reduce((a, b) => a + b) / rssi.length,
          ),
        );
      }
    } finally {
      _collecting = false;
      try {
        await RfidVendorChannel.stopZebraInventory();
      } catch (_) {}
      try {
        await RfidVendorChannel.stopChainwayInventory();
      } catch (_) {}
    }

    if (!mounted) return;
    final result = _StepResult(
      step: step,
      distanceFt: distanceFt,
      measuredAt: DateTime.now(),
      samples: samples,
    );
    ScanSounds.instance.play(
      result.anyDetected ? ScanCue.success : ScanCue.error,
    );
    setState(() {
      _steps.add(result);
      _busy = false;
      _status = result.anyDetected
          ? 'Step $step done at $distanceFt ft. Move the tag to ${distanceFt + 1} ft and pull again.'
          : 'Step $step at $distanceFt ft — NOTHING HEARD at any power. '
              'That is the range limit. Upload when ready.';
    });
    // Newest row is what the operator wants to see.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(
          _scroll.position.maxScrollExtent,
          duration: const Duration(milliseconds: 250),
          curve: Curves.easeOut,
        );
      }
    });
  }

  // ── CSV + upload ─────────────────────────────────────────────────────────

  static String _csvCell(Object? v) {
    if (v == null) return '';
    final s = v.toString();
    return RegExp(r'[",\n\r]').hasMatch(s) ? '"${s.replaceAll('"', '""')}"' : s;
  }

  /// Long format — one row per (step, power level). Deliberately not a wide
  /// table: long format is what any analysis tool wants, and it keeps the
  /// "heard nothing at this power" rows as explicit data instead of blanks.
  String _buildCsv() {
    final lines = <String>[
      'step,distance_ft,epc,power_dbm,detected,reads,reads_per_sec,'
          'peak_rssi_dbm,mean_rssi_dbm,min_rssi_dbm,window_ms,'
          'measured_at_iso,device_model,app_version',
    ];
    for (final s in _steps) {
      for (final m in s.samples) {
        lines.add(
          [
            _csvCell(s.step),
            _csvCell(s.distanceFt),
            _csvCell(_epc),
            _csvCell(m.powerDbm),
            _csvCell(m.detected ? 1 : 0),
            _csvCell(m.reads),
            _csvCell(m.readsPerSec.toStringAsFixed(1)),
            _csvCell(m.peakRssi),
            _csvCell(m.meanRssi?.toStringAsFixed(1)),
            _csvCell(m.minRssi),
            _csvCell(m.windowMs),
            _csvCell(s.measuredAt.toUtc().toIso8601String()),
            _csvCell(_deviceModel),
            _csvCell(_appVersion),
          ].join(','),
        );
      }
    }
    return lines.join('\n');
  }

  Future<void> _upload() async {
    if (_uploading || _steps.isEmpty) return;
    setState(() {
      _uploading = true;
      _uploadResult = null;
    });
    try {
      final api = context.read<WmsApiClient>();
      final csv = _buildCsv();
      final rows = _steps.fold<int>(0, (a, s) => a + s.samples.length);
      final res = await api.uploadTagTestReport(
        csv: csv,
        rowCount: rows,
        epc: _epc,
      );
      if (!mounted) return;
      ScanSounds.instance.play(ScanCue.success);
      setState(() {
        _uploading = false;
        _uploadResult =
            'Uploaded ${_steps.length} steps / $rows rows as ${res['filename'] ?? 'CSV'}. '
            'Download it from Reports → Count Sessions (activity TAG TEST).';
      });
    } catch (e) {
      if (!mounted) return;
      ScanSounds.instance.play(ScanCue.error);
      setState(() {
        _uploading = false;
        _uploadResult = 'Upload failed: $e';
      });
    }
  }

  void _undoLast() {
    if (_steps.isEmpty || _busy) return;
    setState(() {
      _steps.removeLast();
      _status = 'Removed the last step. Next pull records step ${_steps.length + 1}.';
    });
  }

  void _resetRun() {
    if (_busy) return;
    setState(() {
      _steps.clear();
      _uploadResult = null;
      _status = 'Run cleared. Pull the trigger for step 1 (tag touching).';
    });
  }

  // ── UI ───────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final epcValid = _epc24.hasMatch(_epc);
    final nextStep = _steps.length + 1;
    final nextFt = nextStep - 1;
    return CarbonScaffold(
      pageTitle: 'TAG TEST',
      body: SafeArea(
        top: false,
        child: Padding(
          padding: EdgeInsets.fromLTRB(16.w, 8.h, 16.w, 8.h),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const _SectionLabel('1 · TARGET TAG'),
              SizedBox(height: 6.h),
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _epcCtrl,
                      enabled: !_busy,
                      textCapitalization: TextCapitalization.characters,
                      inputFormatters: [
                        FilteringTextInputFormatter.allow(RegExp('[0-9a-fA-F]')),
                        LengthLimitingTextInputFormatter(24),
                      ],
                      onChanged: (v) =>
                          setState(() => _epc = v.trim().toUpperCase()),
                      style: GoogleFonts.firaCode(fontSize: 13.sp),
                      decoration: InputDecoration(
                        isDense: true,
                        border: const OutlineInputBorder(),
                        labelText: 'EPC (24 hex)',
                        errorText: _epc.isEmpty || epcValid
                            ? null
                            : 'Needs 24 hex characters',
                      ),
                    ),
                  ),
                  SizedBox(width: 8.w),
                  ElevatedButton(
                    onPressed: _busy ? null : () => unawaited(_captureEpc()),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AppColors.primary,
                      foregroundColor: Colors.white,
                      padding: EdgeInsets.symmetric(horizontal: 12.w),
                    ),
                    child: Text(
                      'SCAN\n$_captureDbm dBm',
                      textAlign: TextAlign.center,
                      style: GoogleFonts.spaceGrotesk(
                        fontSize: 10.sp,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ),
                ],
              ),
              SizedBox(height: 12.h),
              _SectionLabel('2 · MEASURE — ${_steps.length} STEPS RECORDED'),
              SizedBox(height: 6.h),
              _StatusCard(
                text: _status,
                busy: _busy,
                nextHint: epcValid && !_busy
                    ? 'NEXT: STEP $nextStep  ·  ${nextFt == 0 ? "TAG TOUCHING THE GUN" : "$nextFt FT AWAY"}'
                    : null,
              ),
              SizedBox(height: 8.h),
              Expanded(
                child: _steps.isEmpty
                    ? const _EmptyHint()
                    : ListView.separated(
                        controller: _scroll,
                        itemCount: _steps.length,
                        separatorBuilder: (_, __) => SizedBox(height: 6.h),
                        itemBuilder: (_, i) => _StepRow(result: _steps[i]),
                      ),
              ),
              if (_uploadResult != null) ...[
                SizedBox(height: 6.h),
                Text(
                  _uploadResult!,
                  style: GoogleFonts.manrope(
                    fontSize: 11.sp,
                    fontWeight: FontWeight.w700,
                    color: _uploadResult!.startsWith('Upload failed')
                        ? const Color(0xFFBF2E2E)
                        : const Color(0xFF1B7F4F),
                  ),
                ),
              ],
              SizedBox(height: 8.h),
              // Primary action. Routed through the SAME _onTrigger the gun
              // trigger uses, so tapping and pulling are literally the same
              // code path and the _busy guard covers both — they can never
              // interleave into a half-started measurement.
              _StepTriggerButton(
                enabled: !_busy && !_uploading,
                busy: _busy,
                epcValid: epcValid,
                nextStep: nextStep,
                nextFt: nextFt,
                onPressed: () => unawaited(_onTrigger()),
              ),
              SizedBox(height: 8.h),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: _busy || _steps.isEmpty ? null : _undoLast,
                      child: const Text('UNDO LAST'),
                    ),
                  ),
                  SizedBox(width: 8.w),
                  Expanded(
                    child: OutlinedButton(
                      onPressed: _busy || _steps.isEmpty ? null : _resetRun,
                      child: const Text('RESET'),
                    ),
                  ),
                ],
              ),
              SizedBox(height: 8.h),
              SizedBox(
                height: 54.h,
                child: ElevatedButton.icon(
                  onPressed:
                      _busy || _uploading || _steps.isEmpty ? null : () => unawaited(_upload()),
                  icon: _uploading
                      ? SizedBox(
                          width: 18.w,
                          height: 18.w,
                          child: const CircularProgressIndicator(
                            strokeWidth: 2,
                            color: Colors.white,
                          ),
                        )
                      : const Icon(Icons.cloud_upload_outlined),
                  label: Text(
                    _uploading ? 'UPLOADING…' : 'UPLOAD CSV TO REPORTS',
                    style: GoogleFonts.manrope(
                      fontSize: 14.sp,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 1.2,
                    ),
                  ),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.primary,
                    foregroundColor: Colors.white,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Big primary control for starting a step — the on-screen twin of the gun
/// trigger. Before an EPC is captured it runs the capture instead, so a single
/// control carries the operator through the whole run without them having to
/// decide which button applies right now.
class _StepTriggerButton extends StatelessWidget {
  const _StepTriggerButton({
    required this.enabled,
    required this.busy,
    required this.epcValid,
    required this.nextStep,
    required this.nextFt,
    required this.onPressed,
  });

  final bool enabled;
  final bool busy;
  final bool epcValid;
  final int nextStep;
  final int nextFt;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final String headline;
    if (busy) {
      headline = 'MEASURING…';
    } else if (!epcValid) {
      headline = 'SCAN TAG ON THE GUN';
    } else if (nextFt == 0) {
      headline = 'START STEP 1 · TOUCHING';
    } else {
      headline = 'START STEP $nextStep · $nextFt FT';
    }
    final bg = !enabled
        ? const Color(0xFFBCC9C9)
        : (busy ? const Color(0xFFB87A00) : AppColors.primary);
    return SizedBox(
      height: 64.h,
      child: Material(
        color: bg,
        child: InkWell(
          onTap: enabled ? onPressed : null,
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              if (busy)
                SizedBox(
                  width: 20.w,
                  height: 20.w,
                  child: const CircularProgressIndicator(
                    strokeWidth: 2.5,
                    color: Colors.white,
                  ),
                )
              else
                Icon(
                  epcValid ? Icons.play_arrow : Icons.nfc,
                  color: Colors.white,
                  size: 24.sp,
                ),
              SizedBox(width: 12.w),
              Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(
                    headline,
                    style: GoogleFonts.manrope(
                      fontSize: 15.sp,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 1.4,
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

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      style: GoogleFonts.spaceGrotesk(
        fontSize: 11.sp,
        fontWeight: FontWeight.w800,
        letterSpacing: 1.6,
        color: const Color(0xFF6D7979),
      ),
    );
  }
}

class _StatusCard extends StatelessWidget {
  const _StatusCard({required this.text, required this.busy, this.nextHint});

  final String text;
  final bool busy;
  final String? nextHint;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: EdgeInsets.fromLTRB(12.w, 10.h, 12.w, 10.h),
      decoration: BoxDecoration(
        color: AppColors.primary.withValues(alpha: 0.07),
        border: Border.all(color: AppColors.primary.withValues(alpha: 0.4)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              if (busy)
                Padding(
                  padding: EdgeInsets.only(right: 8.w),
                  child: SizedBox(
                    width: 14.w,
                    height: 14.w,
                    child: const CircularProgressIndicator(strokeWidth: 2),
                  ),
                ),
              Expanded(
                child: Text(
                  text,
                  style: GoogleFonts.manrope(
                    fontSize: 12.sp,
                    fontWeight: FontWeight.w700,
                    color: AppColors.textMain,
                  ),
                ),
              ),
            ],
          ),
          if (nextHint != null) ...[
            SizedBox(height: 6.h),
            Text(
              nextHint!,
              style: GoogleFonts.spaceGrotesk(
                fontSize: 12.sp,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.2,
                color: AppColors.primary,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _EmptyHint extends StatelessWidget {
  const _EmptyHint();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: EdgeInsets.all(20.r),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.straighten,
                size: 40.sp, color: const Color(0xFFBCC9C9)),
            SizedBox(height: 10.h),
            Text(
              'Step 1 is the tag TOUCHING the gun.\n'
              'Each step after that is one foot further.\n'
              'Pull the trigger once per step — it stops on its own.',
              textAlign: TextAlign.center,
              style: GoogleFonts.manrope(
                fontSize: 12.sp,
                fontWeight: FontWeight.w600,
                color: const Color(0xFF5A6464),
                height: 1.5,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _StepRow extends StatelessWidget {
  const _StepRow({required this.result});
  final _StepResult result;

  @override
  Widget build(BuildContext context) {
    final tone = result.anyDetected
        ? const Color(0xFF1B7F4F)
        : const Color(0xFFB23A3A);
    final full = result.atFullPower;
    final lowest = result.lowestDetectingPower;
    return Container(
      padding: EdgeInsets.fromLTRB(10.w, 8.h, 10.w, 8.h),
      decoration: BoxDecoration(
        color: tone.withValues(alpha: 0.05),
        border: Border.all(color: tone.withValues(alpha: 0.35)),
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
                  result.distanceFt == 0 ? 'TOUCH' : '${result.distanceFt} FT',
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 10.sp,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 1.2,
                    color: Colors.white,
                  ),
                ),
              ),
              SizedBox(width: 8.w),
              Expanded(
                child: Text(
                  result.anyDetected
                      ? '30 dBm: ${full?.peakRssi ?? "—"} dBm peak · '
                          '${full?.reads ?? 0} reads · lowest power heard: ${lowest ?? "—"} dBm'
                      : 'NOT HEARD AT ANY POWER — range limit',
                  maxLines: 2,
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 11.sp,
                    fontWeight: FontWeight.w700,
                    color: const Color(0xFF333333),
                  ),
                ),
              ),
            ],
          ),
          SizedBox(height: 4.h),
          Text(
            result.samples
                .map((s) => s.detected
                    ? '${s.powerDbm}:${s.peakRssi}'
                    : '${s.powerDbm}:—')
                .join('   '),
            style: GoogleFonts.firaCode(
              fontSize: 9.sp,
              color: const Color(0xFF555555),
            ),
          ),
        ],
      ),
    );
  }
}
