import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/services/mobile_permissions.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/guards/permission_guard.dart';
import 'package:carbon_wms/ui/screens/add_on_count_source_picker_screen.dart';
import 'package:carbon_wms/ui/screens/count_inventory_screen.dart';
import 'package:carbon_wms/ui/screens/inventory_catalog_screen.dart';
import 'package:carbon_wms/ui/screens/reports_hub_screen.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

class InventoryHubScreen extends StatelessWidget {
  const InventoryHubScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final tileColor =
        isDark ? const Color(0xFF1C2828) : const Color(0xFFEEF4F3);
    final iconColor = isDark ? const Color(0xFF7A9090) : AppColors.slateAction;
    final textColor = isDark ? const Color(0xFF7A9090) : AppColors.textMuted;
    // Phase 2 — hide tiles for screen ids the operator's role can't see.
    // RECOUNT / ADJUST stay visible regardless because they have no
    // navigation today; they're placeholders the warehouse team uses.
    final perms = context.watch<MobilePermissions>();

    return CarbonScaffold(
      pageTitle: 'inventory',
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
              if (perms.canView(ScreenIds.countInventory))
                _InventoryTile(
                  label: 'COUNT',
                  icon: LucideIcons.layers,
                  tileColor: tileColor,
                  iconColor: iconColor,
                  textColor: textColor,
                  onTap: () => context.pushGuarded<void>(
                    ScreenIds.countInventory,
                    (_) => const CountInventoryScreen(),
                  ),
                ),
              if (perms.canView(ScreenIds.addOnCount) ||
                  perms.canView(ScreenIds.addOnCountSourcePicker))
                _InventoryTile(
                  label: 'ADD-ON',
                  icon: LucideIcons.plusCircle,
                  tileColor: tileColor,
                  iconColor: iconColor,
                  textColor: textColor,
                  onTap: () => context.pushGuarded<void>(
                    ScreenIds.addOnCountSourcePicker,
                    (_) => const AddOnCountSourcePickerScreen(),
                  ),
                ),
              _InventoryTile(
                label: 'RECOUNT',
                icon: LucideIcons.refreshCcw,
                tileColor: tileColor,
                iconColor: iconColor,
                textColor: textColor,
              ),
              _InventoryTile(
                label: 'ADJUST',
                icon: LucideIcons.slidersHorizontal,
                tileColor: tileColor,
                iconColor: iconColor,
                textColor: textColor,
              ),
              if (perms.canView(ScreenIds.inventoryCatalog))
                _InventoryTile(
                  label: 'CATALOG',
                  icon: LucideIcons.bookOpen,
                  tileColor: tileColor,
                  iconColor: iconColor,
                  textColor: textColor,
                  onTap: () => context.pushGuarded<void>(
                    ScreenIds.inventoryCatalog,
                    (_) => const InventoryCatalogScreen(),
                  ),
                ),
              if (perms.canView(ScreenIds.reportsHub))
                _InventoryTile(
                  label: 'REPORTS',
                  icon: LucideIcons.fileText,
                  tileColor: tileColor,
                  iconColor: iconColor,
                  textColor: textColor,
                  onTap: () => context.pushGuarded<void>(
                    ScreenIds.reportsHub,
                    (_) => const ReportsHubScreen(),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _InventoryTile extends StatelessWidget {
  const _InventoryTile({
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
