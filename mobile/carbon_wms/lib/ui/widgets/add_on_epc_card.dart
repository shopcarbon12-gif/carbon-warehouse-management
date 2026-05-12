import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:carbon_wms/services/add_on_session_state.dart';
import 'package:carbon_wms/theme/app_theme.dart';

/// One-row container that renders ONE EPC's full identity card. Used by
/// both the Add-On scan screen (live new-EPC list) and the review screen.
/// Each EPC stays separate — no grouping, no per-SKU quantity counter.
///
/// Layout mirrors `_CountItemContainer` in count_inventory_screen.dart so
/// the two screens read consistently:
///   Row 1: SKU (mono)               · price (right, optional)
///   Row 2: name · color · size      (catalog-resolved; falls back to "—")
///   Row 3: EPC (mono small)         · bin (right, optional)
class AddOnEpcCard extends StatelessWidget {
  const AddOnEpcCard({super.key, required this.entry});

  final NewEpcEntry entry;

  @override
  Widget build(BuildContext context) {
    final sku = (entry.customSku ?? '').trim();
    final name = (entry.itemName ?? '').trim();
    final color = (entry.color ?? '').trim();
    final size = (entry.size ?? '').trim();
    final bin = (entry.bin ?? '').trim();
    final priceText = entry.retailPrice == null ? '' : '\$${entry.retailPrice}';

    final descLine = [
      if (name.isNotEmpty) name,
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
                    // Live scan no longer enriches per-EPC (1.2.66 — operator
                    // wanted a quiet scan loop), so SKU is empty during the
                    // session and only filled in server-side on UPLOAD. Use
                    // the EPC itself as the primary identifier here; the
                    // smaller EPC line below is now redundant when sku is
                    // empty but keeps the card layout consistent on rows
                    // that DO have a sku (older sessions, post-upload, etc.).
                    sku.isEmpty ? entry.epc : sku,
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
                if (bin.isNotEmpty)
                  Text(
                    'bin $bin',
                    style: GoogleFonts.manrope(
                      fontSize: 11.sp,
                      fontWeight: FontWeight.w700,
                      color: const Color(0xFF3F4A4A),
                    ),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
