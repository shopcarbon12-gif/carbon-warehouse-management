import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/services/handheld_runtime_config.dart';
import 'package:carbon_wms/services/mobile_settings_repository.dart';
import 'package:carbon_wms/theme/app_theme.dart';

/// Always-visible RFID-power slider, designed to live at the bottom of any
/// scan-using screen (Status Change, Locate Tag, Re-Encode).
///
/// UX contract:
///   - **Visual** updates immediately on every drag tick so the dBm label
///     tracks the finger.
///   - **Radio config** push is debounced (~250 ms) and latest-wins-coalesced
///     so a single finger drag results in ONE stop→setAntennaRfConfig→
///     restart cycle on the sled instead of one per drag pixel.
///
/// Why the debounce: RFD8500 (and analogously the Chainway MTK chip)
/// rejects `setAntennaRfConfig` while inventory is streaming, so the
/// native controller does stop→apply→start around every push. Without
/// debouncing, dragging across the bar 5→30 dBm queues 30+ stop/restart
/// cycles on the controller executor; the radio bounces, RSSI updates
/// freeze, and the Locate-Tag % bar looks broken even though the slider
/// label is moving. Same pattern the POS antenna slider needed
/// (rate-limit + coalesce, project_pos_power_rate_limit_2026_05_26).
class RfidPowerSlider extends StatefulWidget {
  const RfidPowerSlider({super.key, this.defaultDbm, this.onCommit});

  /// Fired with the committed dBm whenever the slider actually pushes a new
  /// value to the radio (LOCAL mode only). Screens that also register a
  /// session-level power override with [RfidManager] use this to keep the
  /// override in step — otherwise the next
  /// `reapplyHandheldHardwareSettings()` (settings sync, scan-context change)
  /// would silently stomp the operator's slider back to the global config
  /// power mid-scan.
  final ValueChanged<int>? onCommit;

  /// When non-null the slider runs in **LOCAL mode**: it seeds to this value on
  /// first mount and pushes changes straight to the radio via
  /// [RfidVendorChannel.setAntennaPowerDbm], WITHOUT reading or writing the
  /// shared global power setting. This lets a screen carry its own default
  /// power (e.g. Encode 20 dBm, Locate 30 dBm) without changing the power other
  /// screens inherit. When null the slider stays bound to the global power.
  final int? defaultDbm;

  /// Lower bound in the UI. We allow "off-ish" (1 dBm) on the bottom end
  /// so operators can intentionally cut range — sled minimums are typically
  /// ~5 dBm; the controllers clamp internally if 1 isn't supported.
  static const int _minDbm = 1;

  /// Quiet window after the last drag tick before we push to the radio.
  /// 250 ms is well below human "I let go" perception (~400 ms) so the
  /// new power feels instant, while still collapsing all the in-drag
  /// onChanged events into a single native config write.
  static const Duration _coalesceWindow = Duration(milliseconds: 250);

  @override
  State<RfidPowerSlider> createState() => _RfidPowerSliderState();
}

class _RfidPowerSliderState extends State<RfidPowerSlider> {
  /// While the operator is actively dragging, the live drag value lives
  /// here. We don't write it to the repo every tick because the repo's
  /// setter triggers the native radio push — that's what the debounce
  /// is for. Visual label still uses this so it tracks the finger.
  int? _dragOverride;

  /// Fires `_coalesceWindow` after the most recent onChanged. Carries
  /// the latest dBm. Re-arming the timer cancels the prior one — pure
  /// latest-wins coalesce.
  Timer? _coalesceTimer;

  /// Authoritative value while in LOCAL mode ([RfidPowerSlider.defaultDbm]
  /// non-null). Seeded on mount, never touches the shared global setting.
  int? _localDbm;

  /// The radio's real achievable range, once its capabilities answer. Until
  /// then we show the historical 1..30 span. Narrowing to what the hardware
  /// can actually accept stops the operator dragging into dead travel — the
  /// C72E is hard-capped at 23 dBm and the RFD8500 floors around 5, and the
  /// native controllers silently clamp, so those regions of the bar moved the
  /// label without moving the radio.
  int? _hwMinDbm;
  int? _hwMaxDbm;

  int get _minBound =>
      math.max(RfidPowerSlider._minDbm, _hwMinDbm ?? RfidPowerSlider._minDbm);
  int get _maxBound => _hwMaxDbm ?? kAntennaPowerDbmMax;

  bool get _isLocal => widget.defaultDbm != null;

  @override
  void initState() {
    super.initState();
    unawaited(_loadRange());
    if (_isLocal) {
      final seed = widget.defaultDbm!
          .clamp(RfidPowerSlider._minDbm, kAntennaPowerDbmMax);
      _localDbm = seed;
      // Push the per-screen default to the radio once mounted (the native
      // controller clamps to the nearest supported level for the sled).
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        final commit = widget.onCommit;
        if (commit != null) {
          commit(seed);
        } else {
          unawaited(RfidVendorChannel.setAntennaPowerDbm(seed));
        }
      });
    }
  }

  @override
  void dispose() {
    _coalesceTimer?.cancel();
    super.dispose();
  }

  /// Read the connected radio's transmit-power capabilities. Retried a few
  /// times because the query returns null until the reader link is up, which
  /// on a Bluetooth sled can be a moment after the screen mounts. Purely
  /// cosmetic — a null answer just leaves the historical 1..30 span in place.
  Future<void> _loadRange() async {
    for (var attempt = 0; attempt < 3; attempt++) {
      if (!mounted) return;
      final r = await RfidVendorChannel.getPowerRangeDbm();
      if (r != null && r.maxDbm >= r.minDbm) {
        if (!mounted) return;
        setState(() {
          _hwMinDbm = r.minDbm.clamp(1, kAntennaPowerDbmMax);
          _hwMaxDbm = r.maxDbm.clamp(1, kAntennaPowerDbmMax);
        });
        return;
      }
      await Future<void>.delayed(const Duration(milliseconds: 400));
    }
  }

  /// Apply a committed power value: straight to the radio in local mode, or via
  /// the shared global setter in global mode (which also pushes to the radio).
  void _apply(MobileSettingsRepository repo, int dbm) {
    if (_isLocal) {
      _localDbm = dbm;
      final commit = widget.onCommit;
      if (commit != null) {
        // The owner drives the radio (via a session power override); don't
        // double-push or the radio takes two stop→apply→resume cycles per drag.
        commit(dbm);
      } else {
        unawaited(RfidVendorChannel.setAntennaPowerDbm(dbm));
      }
    } else {
      unawaited(repo.setGlobalAntennaPower(dbm));
    }
  }

  void _scheduleCoalescedPush(MobileSettingsRepository repo, int dbm) {
    _coalesceTimer?.cancel();
    _coalesceTimer = Timer(RfidPowerSlider._coalesceWindow, () {
      if (!mounted) return;
      // The native controller does its stop→apply→start dance exactly once for
      // this drag (global setter persists prefs too).
      _apply(repo, dbm);
      // Drop the local override so the UI re-syncs to the canonical value
      // (in case the native side clamped to a different supported level).
      if (mounted) setState(() => _dragOverride = null);
    });
  }

  @override
  Widget build(BuildContext context) {
    return Consumer<MobileSettingsRepository>(
      builder: (context, repo, _) {
        // Both transferOut/In are kept in sync by setGlobalAntennaPower;
        // reading either is fine.
        final lo = _minBound;
        final hi = math.max(_maxBound, lo + 1);
        final repoValue =
            repo.config.transferOutAntennaPower.clamp(lo, hi);
        // Local mode shows its own value; global mode tracks the shared power.
        final base = _isLocal ? (_localDbm ?? repoValue) : repoValue;
        // Clamp into the hardware range so a value carried over from a screen
        // with a higher default can't sit outside the Slider's own min/max
        // (which asserts) once the capabilities answer.
        final displayed = (_dragOverride ?? base).clamp(lo, hi);
        return Container(
          color: const Color(0xFFF0F5F4),
          padding: EdgeInsets.fromLTRB(14.w, 4.h, 14.w, 4.h),
          child: Row(
            children: [
              Text(
                'PWR',
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 10.sp,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 1.4,
                  color: const Color(0xFF6D7979),
                ),
              ),
              SizedBox(width: 8.w),
              Expanded(
                child: SliderTheme(
                  data: SliderTheme.of(context).copyWith(
                    trackHeight: 3,
                    activeTrackColor: AppColors.primary,
                    inactiveTrackColor: const Color(0xFFCDD7D7),
                    thumbColor: AppColors.primary,
                    overlayColor: AppColors.primary.withValues(alpha: 0.10),
                    thumbShape:
                        const RoundSliderThumbShape(enabledThumbRadius: 8),
                    overlayShape:
                        const RoundSliderOverlayShape(overlayRadius: 16),
                  ),
                  child: Slider(
                    value: displayed.toDouble(),
                    min: lo.toDouble(),
                    max: hi.toDouble(),
                    divisions: hi - lo,
                    onChanged: (v) {
                      final next = v.round();
                      // Update the visual label immediately so it tracks
                      // the finger, but DON'T call into the repo here —
                      // that would push to the radio on every pixel.
                      setState(() => _dragOverride = next);
                      _scheduleCoalescedPush(repo, next);
                    },
                    onChangeEnd: (v) {
                      // Belt-and-suspenders: if the operator let go before
                      // the debounce timer fires, push immediately so the
                      // radio matches the released position with no extra
                      // wait. Cancel the pending timer first so we don't
                      // double-push.
                      _coalesceTimer?.cancel();
                      _apply(repo, v.round());
                      if (mounted) setState(() => _dragOverride = null);
                    },
                  ),
                ),
              ),
              SizedBox(width: 8.w),
              SizedBox(
                width: 56.w,
                child: Text(
                  '$displayed dBm',
                  textAlign: TextAlign.right,
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 12.sp,
                    fontWeight: FontWeight.w800,
                    color: AppColors.textMain,
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}
