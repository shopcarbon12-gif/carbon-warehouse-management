import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:lucide_icons/lucide_icons.dart';

import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/count_inventory_screen.dart';
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

    return CarbonScaffold(
      pageTitle: 'inventory',
      body: ColoredBox(
        color: Colors.white,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 10, 20, 20),
          child: GridView.count(
            crossAxisCount: 3,
            mainAxisSpacing: 8,
            crossAxisSpacing: 8,
            childAspectRatio: 1.1,
            children: [
              _InventoryTile(
                label: 'COUNT',
                icon: LucideIcons.layers,
                tileColor: tileColor,
                iconColor: iconColor,
                textColor: textColor,
                onTap: () => Navigator.of(context).push<void>(
                  MaterialPageRoute<void>(
                      builder: (_) => const CountInventoryScreen()),
                ),
              ),
              _InventoryTile(
                label: 'AUDIT',
                icon: LucideIcons.clipboardList,
                tileColor: tileColor,
                iconColor: iconColor,
                textColor: textColor,
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
              _InventoryTile(
                label: 'LOOKUP',
                icon: LucideIcons.search,
                tileColor: tileColor,
                iconColor: iconColor,
                textColor: textColor,
              ),
              _InventoryTile(
                label: 'REPORTS',
                icon: LucideIcons.fileText,
                tileColor: tileColor,
                iconColor: iconColor,
                textColor: textColor,
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
      borderRadius: BorderRadius.circular(2),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(2),
        child: Padding(
          padding: const EdgeInsets.all(10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(icon, color: iconColor, size: 20),
              const Spacer(),
              Text(
                label.toUpperCase(),
                style: GoogleFonts.manrope(
                  fontSize: 11,
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
