import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/services/mobile_permissions.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/guards/permission_guard.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';
import 'package:carbon_wms/ui/screens/fast_putaway_screen.dart';
import 'package:carbon_wms/ui/screens/clean_bin_screen.dart';
import 'package:carbon_wms/ui/screens/encode_screen.dart';
import 'package:carbon_wms/ui/screens/encode_and_print_screen.dart';
import 'package:carbon_wms/ui/screens/search_and_encode_screen.dart';
import 'package:carbon_wms/ui/screens/print_screen.dart';
import 'package:carbon_wms/ui/screens/status_change_screen.dart';
import 'package:carbon_wms/ui/screens/geiger_search_screen.dart';
import 'package:carbon_wms/ui/screens/cloud_geiger_screen.dart';
import 'package:carbon_wms/ui/screens/transfer_out_screen.dart';
import 'package:carbon_wms/ui/screens/transfer_in_pending_screen.dart';

/// One sub-tile inside a category hub.
class CategoryHubTile {
  const CategoryHubTile({
    required this.screenId,
    required this.label,
    required this.icon,
    required this.builder,
  });
  final String screenId;
  final String label;
  final IconData icon;
  final WidgetBuilder builder;
}

/// Generic second-level hub. The dashboard's 6 "big squares" push one of these,
/// each showing the small tiles that belong to that parent category. Visual
/// twin of [InventoryHubScreen]; tiles the operator's role can't see drop out.
class CategoryHubScreen extends StatelessWidget {
  const CategoryHubScreen({super.key, required this.title, required this.tiles});

  final String title;
  final List<CategoryHubTile> tiles;

  // ── category configs ──────────────────────────────────────────────────────

  factory CategoryHubScreen.binManagement() => CategoryHubScreen(
        title: 'bin management',
        tiles: [
          CategoryHubTile(
            screenId: ScreenIds.fastPutaway,
            label: 'Bin Assign',
            icon: Icons.qr_code_scanner,
            builder: (_) => const FastPutawayScreen(),
          ),
          CategoryHubTile(
            screenId: ScreenIds.cleanBin,
            label: 'Clean Bin',
            icon: Icons.cleaning_services_outlined,
            builder: (_) => const CleanBinScreen(),
          ),
        ],
      );

  factory CategoryHubScreen.encodePrint() => CategoryHubScreen(
        title: 'encode & print',
        tiles: [
          CategoryHubTile(
            screenId: ScreenIds.encode,
            label: 'Encode',
            icon: Icons.nfc,
            builder: (_) => const EncodeScreen(),
          ),
          CategoryHubTile(
            screenId: ScreenIds.encodeAndPrint,
            label: 'Encode & Print',
            icon: LucideIcons.printer,
            builder: (_) => const EncodeAndPrintScreen(),
          ),
          CategoryHubTile(
            screenId: ScreenIds.searchAndEncode,
            label: 'Re-Encode',
            icon: LucideIcons.refreshCw,
            builder: (_) => const SearchAndEncodeScreen(),
          ),
          CategoryHubTile(
            screenId: ScreenIds.print,
            label: 'Print RFID',
            icon: LucideIcons.printer,
            builder: (_) => const PrintScreen(mode: PrintMode.rfid),
          ),
          CategoryHubTile(
            screenId: ScreenIds.printNonRfid,
            label: 'Print Non-RFID',
            icon: LucideIcons.tag,
            builder: (_) => const PrintScreen(mode: PrintMode.nonRfid),
          ),
          CategoryHubTile(
            screenId: ScreenIds.statusChange,
            label: 'Status',
            icon: LucideIcons.clipboardList,
            builder: (_) => const StatusChangeScreen(),
          ),
        ],
      );

  factory CategoryHubScreen.findLocate() => CategoryHubScreen(
        title: 'find & locate',
        tiles: [
          CategoryHubTile(
            screenId: ScreenIds.geigerSearch,
            label: 'Geiger',
            icon: LucideIcons.radio,
            builder: (_) => const GeigerSearchScreen(),
          ),
          CategoryHubTile(
            screenId: ScreenIds.cloudGeiger,
            label: 'Cloud + Geiger',
            icon: LucideIcons.cloud,
            builder: (_) => const CloudGeigerScreen(),
          ),
        ],
      );

  factory CategoryHubScreen.transfers() => CategoryHubScreen(
        title: 'transfers',
        tiles: [
          CategoryHubTile(
            screenId: ScreenIds.transferSlips,
            label: 'Transfer Out',
            icon: Icons.outbound_outlined,
            builder: (_) => const TransferOutScreen(),
          ),
          CategoryHubTile(
            screenId: ScreenIds.transferInPending,
            label: 'Transfer In',
            icon: Icons.move_to_inbox_outlined,
            builder: (_) => const TransferInPendingScreen(),
          ),
        ],
      );

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final tileColor =
        isDark ? const Color(0xFF1C2828) : const Color(0xFFEEF4F3);
    final iconColor = isDark ? const Color(0xFF7A9090) : AppColors.slateAction;
    final textColor = isDark ? const Color(0xFF7A9090) : AppColors.textMuted;
    final perms = context.watch<MobilePermissions>();
    final visible = tiles.where((t) => perms.canView(t.screenId)).toList();

    return CarbonScaffold(
      pageTitle: title,
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
              for (final t in visible)
                _CatTile(
                  label: t.label,
                  icon: t.icon,
                  tileColor: tileColor,
                  iconColor: iconColor,
                  textColor: textColor,
                  onTap: () => context.pushGuarded<void>(t.screenId, t.builder),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _CatTile extends StatelessWidget {
  const _CatTile({
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
