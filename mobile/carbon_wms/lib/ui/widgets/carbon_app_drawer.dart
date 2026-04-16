import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/services/theme_notifier.dart';
import 'package:carbon_wms/theme/app_theme.dart';

class CarbonAppDrawer extends StatelessWidget {
  const CarbonAppDrawer({
    super.key,
    this.userEmail,
    required this.onSettings,
    required this.onRefresh,
    this.onLogout,
  });

  final String? userEmail;
  final VoidCallback onSettings;
  final VoidCallback onRefresh;
  final VoidCallback? onLogout;

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final rawName = (userEmail?.split('@').first ?? '').replaceAll('.', ' ');
    final displayName = rawName.isEmpty
        ? 'Operator'
        : rawName
            .split(' ')
            .map((w) => w.isEmpty ? w : '${w[0].toUpperCase()}${w.substring(1)}')
            .join(' ');
    final email = userEmail ?? '—';

    return Drawer(
      backgroundColor: isDark ? const Color(0xFF1C2828) : Colors.white,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            width: double.infinity,
            color: AppColors.primary,
            padding: EdgeInsets.fromLTRB(
              24.w,
              MediaQuery.of(context).padding.top + 32.h,
              24.w,
              32.h,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                CircleAvatar(
                  radius: 52.r,
                  backgroundColor: Colors.white.withValues(alpha: 0.2),
                  child: Icon(Icons.person, size: 58.sp, color: Colors.white),
                ),
                SizedBox(height: 20.h),
                Text(
                  displayName,
                  style: GoogleFonts.manrope(
                    fontSize: 22.sp,
                    fontWeight: FontWeight.w700,
                    color: Colors.white,
                  ),
                  textAlign: TextAlign.center,
                  overflow: TextOverflow.ellipsis,
                ),
                SizedBox(height: 6.h),
                Text(
                  email,
                  style: GoogleFonts.manrope(
                    fontSize: 14.sp,
                    fontWeight: FontWeight.w500,
                    color: Colors.white.withValues(alpha: 0.8),
                  ),
                  textAlign: TextAlign.center,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
          SizedBox(height: 20.h),
          _DrawerItem(
            icon: Icons.settings_outlined,
            label: 'Settings',
            onTap: onSettings,
          ),
          SizedBox(height: 4.h),
          _DrawerItem(
            icon: Icons.sync,
            label: 'Refresh Settings / Permissions',
            onTap: onRefresh,
          ),
          SizedBox(height: 4.h),
          Consumer<ThemeNotifier>(
            builder: (_, notifier, __) => _DrawerItem(
              icon: Icons.palette_outlined,
              label: 'Switch Theme',
              onTap: () => notifier.toggle(),
            ),
          ),
          const Spacer(),
          if (onLogout != null)
            _DrawerItem(
              icon: Icons.power_settings_new,
              label: 'Sign Out',
              color: const Color(0xFFEF4444),
              large: true,
              onTap: onLogout!,
            ),
          SizedBox(height: 80.h),
        ],
      ),
    );
  }
}

class _DrawerItem extends StatelessWidget {
  const _DrawerItem({
    required this.icon,
    required this.label,
    required this.onTap,
    this.color,
    this.large = false,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final bool large;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final fg = color ?? (isDark ? const Color(0xFFE0ECEC) : AppColors.textMain);
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: EdgeInsets.symmetric(horizontal: 20.w, vertical: 12.h),
        child: Row(
          children: [
            SizedBox(
              width: 26.w,
              child: Icon(icon, size: large ? 26.sp : 24.sp, color: fg),
            ),
            SizedBox(width: 12.w),
            Expanded(
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: GoogleFonts.manrope(
                  fontSize: large ? 17.sp : 14.sp,
                  fontWeight: large ? FontWeight.w800 : FontWeight.w700,
                  letterSpacing: -0.1,
                  color: fg,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
