import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/services/add_on_session_state.dart';
import 'package:carbon_wms/services/mobile_permissions.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/item_line_format.dart';

/// One-row container that renders ONE EPC's full identity card. Used by
/// both the Add-On scan screen (live new-EPC list) and the review screen.
/// Each EPC stays separate — no grouping, no per-SKU quantity counter.
///
/// Layout mirrors `_CountItemContainer` in count_inventory_screen.dart (and
/// uses the same item_line_format.dart helpers) so the two screens read
/// consistently:
///   Row 1: SKU (mono)               · price (right; role-gated)
///   Row 2: name · color · size      (from the phone's live catalog copy)
///   Row 3: EPC (mono small)         · BIN (right, optional)
class AddOnEpcCard extends StatelessWidget {
  const AddOnEpcCard({super.key, required this.entry});

  final NewEpcEntry entry;

  @override
  Widget build(BuildContext context) {
    final sku = (entry.customSku ?? '').trim();
    final name = (entry.itemName ?? '').trim();
    final color = (entry.color ?? '').trim();
    final size = (entry.size ?? '').trim();
    final bin = formatBinDisplay(entry.bin);
    final systemId = (entry.systemId ?? '').trim();
    // RBAC: hide retail price for roles with the show_retail_price flag off.
    final priceText =
        context.read<MobilePermissions>().showField(FieldFlags.showRetailPrice)
            ? formatRetailPrice(entry.retailPrice)
            : '';

    // Primary row identifier — what the operator reads at a glance.
    // Order of preference: SKU (from the local catalog copy, filled in at
    // read time or as soon as the copy is ready) > System ID (client-side
    // decode, always available) > raw EPC.
    final primaryLabel = sku.isNotEmpty
        ? sku
        : (systemId.isNotEmpty ? 'System ID $systemId' : entry.epc);

    // The matrix description can bake in a variant's colour + size; strip
    // that tail so it isn't shown twice (same rule as Count).
    final cleanName = stripNameSizeSuffix(name, size: size, color: color);
    final descLine = [
      if (cleanName.isNotEmpty) cleanName,
      if (color.isNotEmpty) color,
      if (size.isNotEmpty) size,
    ].join(' · ');

    return Material(
      color: const Color(0xFFECECEC),
      borderRadius: BorderRadius.zero,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.baseline,
              textBaseline: TextBaseline.alphabetic,
              children: [
                Expanded(
                  child: Text(
                    primaryLabel,
                    style: GoogleFonts.robotoMono(
                      fontSize: 16.sp,
                      fontWeight: FontWeight.w700,
                      color: AppColors.textMain,
                      height: 1.2,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                if (priceText.isNotEmpty) ...[
                  SizedBox(width: 8.w),
                  Text(
                    priceText,
                    style: GoogleFonts.manrope(
                      fontSize: 13.sp,
                      fontWeight: FontWeight.w800,
                      color: AppColors.textMain,
                    ),
                  ),
                ],
              ],
            ),
            if (descLine.isNotEmpty) ...[
              SizedBox(height: 3.h),
              Text(
                descLine,
                style: GoogleFonts.manrope(
                  fontSize: 13.sp,
                  fontWeight: FontWeight.w700,
                  color: AppColors.textMain,
                  height: 1.2,
                ),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
            ],
            SizedBox(height: 4.h),
            Row(
              children: [
                Expanded(
                  child: Text(
                    'EPC ${entry.epc}',
                    style: GoogleFonts.spaceMono(
                      fontSize: 11.sp,
                      color: const Color(0xFF5A6464),
                      height: 1.2,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                if (bin.isNotEmpty) ...[
                  SizedBox(width: 8.w),
                  Text(
                    'BIN $bin',
                    style: GoogleFonts.manrope(
                      fontSize: 11.sp,
                      fontWeight: FontWeight.w700,
                      color: const Color(0xFF3F4A4A),
                    ),
                  ),
                ],
              ],
            ),
          ],
        ),
      ),
    );
  }
}
