import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:lucide_icons/lucide_icons.dart';

import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Read-only mirror of status-change activity (sold / pending / killed /
/// retagged). Stubbed pending the `/api/reports/status-changes` endpoint
/// — paired with the existing on-handheld Status Change flow.
class StatusReportsScreen extends StatelessWidget {
  const StatusReportsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    const accent = AppColors.slateAction;
    return CarbonScaffold(
      pageTitle: 'STATUS REPORTS',
      body: Center(
        child: Padding(
          padding: EdgeInsets.symmetric(horizontal: 32.w),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Container(
                width: 88.w,
                height: 88.w,
                color: accent.withValues(alpha: 0.10),
                child: Center(
                  child:
                      Icon(LucideIcons.activity, size: 40.sp, color: accent),
                ),
              ),
              SizedBox(height: 20.h),
              Text(
                'STATUS CHANGES',
                textAlign: TextAlign.center,
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 16.sp,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 1.8,
                  color: AppColors.textMain,
                ),
              ),
              SizedBox(height: 8.h),
              Text(
                'COMING SOON',
                textAlign: TextAlign.center,
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 10.sp,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 2.4,
                  color: accent,
                ),
              ),
              SizedBox(height: 12.h),
              Text(
                'Sold / pending / killed / retagged transitions will land here\nonce the status-change report feed is wired to the handheld.',
                textAlign: TextAlign.center,
                style: GoogleFonts.manrope(
                  fontSize: 13.sp,
                  fontWeight: FontWeight.w600,
                  color: const Color(0xFF5A6464),
                  height: 1.5,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
