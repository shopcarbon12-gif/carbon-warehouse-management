import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:lucide_icons/lucide_icons.dart';

import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Read-only mirror of outgoing transfer slips. Stubbed pending the
/// `/api/reports/transfers?direction=out` endpoint.
class TransferOutReportsScreen extends StatelessWidget {
  const TransferOutReportsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const CarbonScaffold(
      pageTitle: 'TRANSFER OUT',
      body: _ComingSoon(
        icon: LucideIcons.arrowUpFromLine,
        accent: AppColors.primary,
        title: 'OUTGOING SHIPMENTS',
        body:
            'Outbound transfer reports will land here once the dispatch feed is\nwired to the handheld. Destination, slip ID, and items-shipped totals\nwill mirror the web /reports/transfers view.',
      ),
    );
  }
}

class _ComingSoon extends StatelessWidget {
  const _ComingSoon({
    required this.icon,
    required this.accent,
    required this.title,
    required this.body,
  });

  final IconData icon;
  final Color accent;
  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    return Center(
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
                child: Icon(icon, size: 40.sp, color: accent),
              ),
            ),
            SizedBox(height: 20.h),
            Text(
              title,
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
              body,
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
    );
  }
}
