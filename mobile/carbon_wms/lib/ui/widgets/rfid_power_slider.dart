import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';

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
  const RfidPowerSlider({super.key});

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

  @override
  void dispose() {
    _coalesceTimer?.cancel();
    super.dispose();
  }

  void _scheduleCoalescedPush(MobileSettingsRepository repo, int dbm) {
    _coalesceTimer?.cancel();
    _coalesceTimer = Timer(RfidPowerSlider._coalesceWindow, () {
      if (!mounted) return;
      // Hand off to the repo's existing global-power setter — it persists
      // prefs AND calls RfidVendorChannel.setAntennaPowerDbm in the same
      // tick. The native controller then does its stop→apply→start dance
      // exactly once for this drag.
      unawaited(repo.setGlobalAntennaPower(dbm));
      // Drop the local override so the UI re-syncs to the canonical repo
      // value (in case the native side clamped to a different supported
      // power level than what we requested).
      if (mounted) setState(() => _dragOverride = null);
    });
  }

  @override
  Widget build(BuildContext context) {
    return Consumer<MobileSettingsRepository>(
      builder: (context, repo, _) {
        // Both transferOut/In are kept in sync by setGlobalAntennaPower;
        // reading either is fine.
        final repoValue = repo.config.transferOutAntennaPower
            .clamp(RfidPowerSlider._minDbm, kAntennaPowerDbmMax);
        final displayed = _dragOverride ?? repoValue;
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
                    min: RfidPowerSlider._minDbm.toDouble(),
                    max: kAntennaPowerDbmMax.toDouble(),
                    divisions:
                        kAntennaPowerDbmMax - RfidPowerSlider._minDbm,
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
                      final next = v.round();
                      unawaited(repo.setGlobalAntennaPower(next));
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
