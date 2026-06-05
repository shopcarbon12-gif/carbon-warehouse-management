import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/services/mobile_permissions.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/guards/permission_guard.dart';
import 'package:carbon_wms/ui/screens/count_reports_screen.dart';
import 'package:carbon_wms/ui/screens/damages_reports_screen.dart';
import 'package:carbon_wms/ui/screens/re_encode_reports_screen.dart';
import 'package:carbon_wms/ui/screens/status_reports_screen.dart';
import 'package:carbon_wms/ui/screens/transfer_out_reports_screen.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Inventory → Reports hub. Three families today (Counts / Transfers /
/// Status) with room for more later (audits, recounts, adjustments).
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
    final perms = context.watch<MobilePermissions>();

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
            children: <Widget>[
              if (perms.canView(ScreenIds.countReports))
                _ReportTile(
                  label: 'COUNTS',
                  icon: LucideIcons.layers,
                  tileColor: tileColor,
                  iconColor: iconColor,
                  textColor: textColor,
                  onTap: () => context.pushGuarded<void>(
                    ScreenIds.countReports,
                    (_) => const CountReportsScreen(),
                  ),
                ),
              if (perms.canView(ScreenIds.transferOutReports))
                _ReportTile(
                  label: 'TRANSFER OUT',
                  icon: LucideIcons.arrowUpFromLine,
                  tileColor: tileColor,
                  iconColor: iconColor,
                  textColor: textColor,
                  onTap: () => context.pushGuarded<void>(
                    ScreenIds.transferOutReports,
                    (_) => const TransferOutReportsScreen(),
                  ),
                ),
              if (perms.canView(ScreenIds.transferInPending))
                _ReportTile(
                  label: 'TRANSFER IN',
                  icon: LucideIcons.arrowDownToLine,
                  tileColor: tileColor,
                  iconColor: iconColor,
                  textColor: textColor,
                  onTap: () => context.pushGuarded<void>(
                    ScreenIds.transferInPending,
                    (_) => const TransferReportListScreen(
                      direction: 'in',
                      title: 'TRANSFER IN · RECEIVED',
                    ),
                  ),
                ),
              if (perms.canView(ScreenIds.statusReports))
                _ReportTile(
                  label: 'STATUS',
                  icon: LucideIcons.activity,
                  tileColor: tileColor,
                  iconColor: iconColor,
                  textColor: textColor,
                  onTap: () => context.pushGuarded<void>(
                    ScreenIds.statusReports,
                    (_) => const StatusReportsScreen(),
                  ),
                ),
              if (perms.canView(ScreenIds.damagesReports))
                _ReportTile(
                  label: 'DAMAGES',
                  icon: LucideIcons.alertTriangle,
                  tileColor: tileColor,
                  iconColor: iconColor,
                  textColor: textColor,
                  onTap: () => context.pushGuarded<void>(
                    ScreenIds.damagesReports,
                    (_) => const DamagesReportsScreen(),
                  ),
                ),
              if (perms.canView(ScreenIds.reEncodeReports))
                _ReportTile(
                  label: 'RE-ENCODE',
                  icon: LucideIcons.refreshCw,
                  tileColor: tileColor,
                  iconColor: iconColor,
                  textColor: textColor,
                  onTap: () => context.pushGuarded<void>(
                    ScreenIds.reEncodeReports,
                    (_) => const ReEncodeReportsScreen(),
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
