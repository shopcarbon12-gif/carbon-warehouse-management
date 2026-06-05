import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/services/mobile_permissions.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/guards/permission_guard.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';
// Bin management
import 'package:carbon_wms/ui/screens/fast_putaway_screen.dart';
import 'package:carbon_wms/ui/screens/clean_bin_screen.dart';
// Encode & print
import 'package:carbon_wms/ui/screens/encode_screen.dart';
import 'package:carbon_wms/ui/screens/encode_and_print_screen.dart';
import 'package:carbon_wms/ui/screens/search_and_encode_screen.dart';
import 'package:carbon_wms/ui/screens/print_screen.dart';
import 'package:carbon_wms/ui/screens/status_change_screen.dart';
// Find & locate
import 'package:carbon_wms/ui/screens/geiger_search_screen.dart';
import 'package:carbon_wms/ui/screens/cloud_geiger_screen.dart';
// Transfers
import 'package:carbon_wms/ui/screens/transfer_out_screen.dart';
import 'package:carbon_wms/ui/screens/transfer_in_pending_screen.dart';
// Inventory
import 'package:carbon_wms/ui/screens/count_inventory_screen.dart';
import 'package:carbon_wms/ui/screens/add_on_count_source_picker_screen.dart';
import 'package:carbon_wms/ui/screens/inventory_catalog_screen.dart';
import 'package:carbon_wms/ui/screens/inventory_lookup_screen.dart';
// Reports
import 'package:carbon_wms/ui/screens/count_reports_screen.dart';
import 'package:carbon_wms/ui/screens/status_reports_screen.dart';
import 'package:carbon_wms/ui/screens/damages_reports_screen.dart';
import 'package:carbon_wms/ui/screens/re_encode_reports_screen.dart';
import 'package:carbon_wms/ui/screens/transfer_reports_hub_screen.dart';
import 'package:carbon_wms/ui/screens/bin_clearance_report_screen.dart';

/// One tool row inside a category hub.
class CategoryHubTile {
  const CategoryHubTile({
    required this.screenId,
    required this.label,
    required this.description,
    required this.icon,
    required this.builder,
    this.group,
  });
  final String screenId;
  final String label;
  final String description;
  final IconData icon;
  final WidgetBuilder builder;

  /// Optional section header this tile sits under. When set, the hub renders a
  /// small uppercase divider above the first tile of each group — used by the
  /// Reports hub to organise reports by their parent category.
  final String? group;
}

/// Second-level hub opened from a dashboard "big square". Renders its tools as
/// a vertical list of rows (icon chip + name + one-line description + chevron)
/// — scales cleanly whether a category has 2 tools or 6, and tells a new
/// operator what each does. Rows the role can't see drop out.
class CategoryHubScreen extends StatelessWidget {
  const CategoryHubScreen({super.key, required this.title, required this.tiles});

  final String title;
  final List<CategoryHubTile> tiles;

  // ── category configs ──────────────────────────────────────────────────────

  factory CategoryHubScreen.inventory() => CategoryHubScreen(
        title: 'inventory',
        tiles: [
          CategoryHubTile(
            screenId: ScreenIds.inventoryLookup,
            label: 'Item Lookup',
            description: 'Look up an EPC · SKU · UPC',
            icon: LucideIcons.search,
            builder: (_) => const InventoryLookupScreen(),
          ),
          CategoryHubTile(
            screenId: ScreenIds.inventoryCatalog,
            label: 'Catalog',
            description: 'Browse the product catalog',
            icon: LucideIcons.bookOpen,
            builder: (_) => const InventoryCatalogScreen(),
          ),
          CategoryHubTile(
            screenId: ScreenIds.addOnCatalog,
            label: 'Add-On Catalog',
            description: 'Count uncatalogued tags → add LIVE',
            icon: LucideIcons.bookPlus,
            builder: (_) =>
                const CountInventoryScreen(mode: CountMode.addOnCatalog),
          ),
          CategoryHubTile(
            screenId: ScreenIds.countInventory,
            label: 'Count Inventory',
            description: 'Full RFID cycle count',
            icon: LucideIcons.layers,
            builder: (_) => const CountInventoryScreen(),
          ),
          CategoryHubTile(
            screenId: ScreenIds.addOnCountSourcePicker,
            label: 'Add-On Count',
            description: 'Count tags not on a source list',
            icon: LucideIcons.plusCircle,
            builder: (_) => const AddOnCountSourcePickerScreen(),
          ),
        ],
      );

  factory CategoryHubScreen.binManagement() => CategoryHubScreen(
        title: 'bin management',
        tiles: [
          CategoryHubTile(
            screenId: ScreenIds.fastPutaway,
            label: 'Bin Assign',
            description: 'Scan a bin, scan items, assign',
            icon: Icons.qr_code_scanner,
            builder: (_) => const FastPutawayScreen(),
          ),
          CategoryHubTile(
            screenId: ScreenIds.cleanBin,
            label: 'Clean Bin',
            description: "Empty a bin's assignments",
            icon: Icons.cleaning_services_outlined,
            builder: (_) => const CleanBinScreen(),
          ),
        ],
      );

  factory CategoryHubScreen.encodePrint() => CategoryHubScreen(
        title: 'tags & labels',
        tiles: [
          CategoryHubTile(
            screenId: ScreenIds.encode,
            label: 'Encode',
            description: 'Write a single RFID tag',
            icon: Icons.nfc,
            builder: (_) => const EncodeScreen(),
          ),
          CategoryHubTile(
            screenId: ScreenIds.encodeAndPrint,
            label: 'Encode & Print',
            description: 'Encode a chip + print its label',
            icon: LucideIcons.printer,
            builder: (_) => const EncodeAndPrintScreen(),
          ),
          CategoryHubTile(
            screenId: ScreenIds.searchAndEncode,
            label: 'Re-Encode',
            description: 'Batch re-encode many tags',
            icon: LucideIcons.refreshCw,
            builder: (_) => const SearchAndEncodeScreen(),
          ),
          CategoryHubTile(
            screenId: ScreenIds.print,
            label: 'Print RFID',
            description: 'Commission RFID hang-tags',
            icon: LucideIcons.printer,
            builder: (_) => const PrintScreen(mode: PrintMode.rfid),
          ),
          CategoryHubTile(
            screenId: ScreenIds.printNonRfid,
            label: 'Print Non-RFID',
            description: 'Price labels to the Zebra .220',
            icon: LucideIcons.tag,
            builder: (_) => const PrintScreen(mode: PrintMode.nonRfid),
          ),
          CategoryHubTile(
            screenId: ScreenIds.statusChange,
            label: 'Status Change',
            description: 'Bulk-change EPC statuses',
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
            description: 'Search a SKU, then locate a tag',
            icon: LucideIcons.radio,
            builder: (_) => const GeigerSearchScreen(),
          ),
          CategoryHubTile(
            screenId: ScreenIds.cloudGeiger,
            label: 'Cloud + Geiger',
            description: 'Locate tags sent from the web',
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
            description: 'Send items to another location',
            icon: Icons.outbound_outlined,
            builder: (_) => const TransferOutScreen(),
          ),
          CategoryHubTile(
            screenId: ScreenIds.transferInPending,
            label: 'Transfer In',
            description: 'Receive incoming transfer slips',
            icon: Icons.move_to_inbox_outlined,
            builder: (_) => const TransferInPendingScreen(),
          ),
        ],
      );

  factory CategoryHubScreen.reports() => CategoryHubScreen(
        title: 'reports',
        tiles: [
          // ── Inventory ──────────────────────────────────────────────────────
          CategoryHubTile(
            group: 'Inventory',
            screenId: ScreenIds.countReports,
            label: 'Counts',
            description: 'Count session reports',
            icon: LucideIcons.fileText,
            builder: (_) => const CountReportsScreen(),
          ),
          // ── Bin Management ─────────────────────────────────────────────────
          CategoryHubTile(
            group: 'Bin Management',
            screenId: ScreenIds.cleanBin,
            label: 'Bin Clearance',
            description: 'Cleared-bin log',
            icon: LucideIcons.eraser,
            builder: (_) => const BinClearanceReportScreen(),
          ),
          // ── Tags & Labels ──────────────────────────────────────────────────
          CategoryHubTile(
            group: 'Tags & Labels',
            screenId: ScreenIds.reEncodeReports,
            label: 'Re-Encode',
            description: 'Re-encode reports',
            icon: LucideIcons.refreshCw,
            builder: (_) => const ReEncodeReportsScreen(),
          ),
          CategoryHubTile(
            group: 'Tags & Labels',
            screenId: ScreenIds.statusReports,
            label: 'Status Change',
            description: 'Status-change reports',
            icon: LucideIcons.clipboardList,
            builder: (_) => const StatusReportsScreen(),
          ),
          CategoryHubTile(
            group: 'Tags & Labels',
            screenId: ScreenIds.damagesReports,
            label: 'Damages',
            description: 'Damaged-item reports',
            icon: LucideIcons.alertTriangle,
            builder: (_) => const DamagesReportsScreen(),
          ),
          // ── Transfers ──────────────────────────────────────────────────────
          CategoryHubTile(
            group: 'Transfers',
            screenId: ScreenIds.transferReportsHub,
            label: 'Transfers',
            description: 'Transfer slip reports',
            icon: Icons.swap_horiz,
            builder: (_) => const TransferReportsHubScreen(),
          ),
        ],
      );

  @override
  Widget build(BuildContext context) {
    final perms = context.watch<MobilePermissions>();
    final visible = tiles.where((t) => perms.canView(t.screenId)).toList();

    // Build a flat child list, inserting a section header above the first
    // visible tile of each group (tiles with no group render header-less).
    final children = <Widget>[];
    String? lastGroup;
    for (var i = 0; i < visible.length; i++) {
      final t = visible[i];
      if (t.group != null && t.group != lastGroup) {
        children.add(_GroupHeader(label: t.group!, first: lastGroup == null));
        lastGroup = t.group;
      }
      if (i > 0) children.add(SizedBox(height: 16.h));
      children.add(
        _HubRow(
          tile: t,
          onTap: () => context.pushGuarded<void>(t.screenId, t.builder),
        ),
      );
    }

    return CarbonScaffold(
      pageTitle: title,
      body: ColoredBox(
        color: const Color(0xFFF5F5F5),
        child: ListView(
          padding: EdgeInsets.fromLTRB(16.w, 18.h, 16.w, 28.h),
          children: children,
        ),
      ),
    );
  }
}

/// Uppercase section divider used to group reports by their parent category.
class _GroupHeader extends StatelessWidget {
  const _GroupHeader({required this.label, required this.first});
  final String label;
  final bool first;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(top: first ? 0 : 26.h, bottom: 12.h),
      child: Text(
        label.toUpperCase(),
        style: GoogleFonts.spaceGrotesk(
          fontSize: 12.sp,
          fontWeight: FontWeight.w800,
          letterSpacing: 1.8,
          color: const Color(0xFF8A9090),
        ),
      ),
    );
  }
}

class _HubRow extends StatelessWidget {
  const _HubRow({required this.tile, required this.onTap});
  final CategoryHubTile tile;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.white,
      borderRadius: BorderRadius.circular(8.r),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(8.r),
        child: Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(8.r),
            border: Border.all(color: const Color(0xFFD7DEDE)),
          ),
          padding: EdgeInsets.fromLTRB(16.w, 20.h, 14.w, 20.h),
          child: Row(
            children: [
              Container(
                width: 56.w,
                height: 56.w,
                decoration: BoxDecoration(
                  color: const Color(0xFFEEF4F3),
                  borderRadius: BorderRadius.circular(11.r),
                ),
                alignment: Alignment.center,
                child: Icon(tile.icon, size: 29.sp, color: AppColors.primary),
              ),
              SizedBox(width: 15.w),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      tile.label,
                      style: GoogleFonts.spaceGrotesk(
                        fontSize: 20.sp,
                        fontWeight: FontWeight.w800,
                        color: AppColors.textMain,
                      ),
                    ),
                    SizedBox(height: 4.h),
                    Text(
                      tile.description,
                      style: GoogleFonts.manrope(
                        fontSize: 15.sp,
                        fontWeight: FontWeight.w600,
                        // Darker slate (was light grey) for readability.
                        color: const Color(0xFF3F4A4A),
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ),
              ),
              Icon(LucideIcons.chevronRight,
                  size: 24.sp, color: const Color(0xFF3F4A4A)),
            ],
          ),
        ),
      ),
    );
  }
}
