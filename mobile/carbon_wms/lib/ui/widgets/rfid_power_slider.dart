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
/// Drag = immediate effect. The slider writes through
/// [MobileSettingsRepository.setGlobalAntennaPower] which (1) persists the
/// new dBm in handheld prefs and (2) live-pushes to the radio in the same
/// tick so the operator can dial power up/down mid-sweep without leaving
/// the screen. No commit / save button by design.
class RfidPowerSlider extends StatelessWidget {
  const RfidPowerSlider({super.key});

  /// Lower bound in the UI. We allow "off-ish" (1 dBm) on the bottom end
  /// so operators can intentionally cut range — sled minimums are typically
  /// ~5 dBm; the controllers clamp internally if 1 isn't supported.
  static const int _minDbm = 1;

  @override
  Widget build(BuildContext context) {
    return Consumer<MobileSettingsRepository>(
      builder: (context, repo, _) {
        // Both transferOut/In are kept in sync by setGlobalAntennaPower;
        // reading either is fine.
        final current = repo.config.transferOutAntennaPower
            .clamp(_minDbm, kAntennaPowerDbmMax);
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
                    value: current.toDouble(),
                    min: _minDbm.toDouble(),
                    max: kAntennaPowerDbmMax.toDouble(),
                    divisions: kAntennaPowerDbmMax - _minDbm,
                    onChanged: (v) {
                      // Fire on every tick of the drag — the underlying
                      // setter dedupes by writing the same prefs value
                      // and the live radio call coalesces nicely.
                      repo.setGlobalAntennaPower(v.round());
                    },
                  ),
                ),
              ),
              SizedBox(width: 8.w),
              SizedBox(
                width: 56.w,
                child: Text(
                  '$current dBm',
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
