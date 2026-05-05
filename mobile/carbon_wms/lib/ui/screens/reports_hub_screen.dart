import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:lucide_icons/lucide_icons.dart';

import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/count_reports_screen.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Inventory → Reports hub. Single tile for now ("Count Reports") with room
/// for additional report families later (audits, recounts, adjustments).
/// Mirrors the visual rhythm of [InventoryHubScreen] so the operator's eye
/// tracks consistently between hubs.
class ReportsHubScreen extends StatelessWidget {
  const ReportsHubScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final tileColor =
        isDark ? const Color(0xFF1C2828) : const Color(0xFFEEF4F3);
    final iconColor = isDark ? const Color(0xFF7A9090) : AppColors.slateAction;
    final textColor = isDark ? const Color(0xFF7A9090) : AppColors.textMuted;

    return CarbonScaffold(
      pageTitle: 'reports',
      body: ColoredBox(
        color: Colors.white,
        child: Padding(
          padding: EdgeInsets.fromLTRB(20.w, 10.h, 20.w, 20.h),
          child: GridView.count(
            crossAxisCount: 3,
            mainAxisSpacing: 8,
            crossAxisSpacing: 8,
            childAspectRatio: 1.1,
            children: [
              _ReportTile(
                label: 'COUNT REPORTS',
                icon: LucideIcons.layers,
                tileColor: tileColor,
                iconColor: iconColor,
                textColor: textColor,
                onTap: () => Navigator.of(context).push<void>(
                  MaterialPageRoute<void>(
                      builder: (_) => const CountReportsScreen()),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ReportTile extends StatelessWidget {
  const _ReportTile({
    required this.label,
    required this.icon,
    required this.tileColor,
    required this.iconColor,
    required this.textColor,
    this.onTap,
  });

  final String label;
  final IconData icon;
  final Color tileColor;
  final Color iconColor;
  final Color textColor;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: tileColor,
      borderRadius: BorderRadius.circular(2.r),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(2.r),
        child: Padding(
          padding: EdgeInsets.all(10.r),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(icon, color: iconColor, size: 20.sp),
              const Spacer(),
              Text(
                label.toUpperCase(),
                style: GoogleFonts.manrope(
                  fontSize: 11.sp,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 0.6,
                  color: textColor,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
