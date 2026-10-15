// Status + bin line shared by the Find & Locate lists — Geiger (Catalog EPC
// list), Bulk Geiger and Cloud + Geiger — so a tag's WMS status and its
// assigned bin read the same everywhere (owner, 2026-10-15).

import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/item_line_format.dart';

/// Operator name for a WMS item status: "LIVE" in the UI, `in-stock` in the
/// DB. null / empty = the tag has no WMS record.
String itemStatusLabel(String? status) {
  final v = (status ?? '').trim().toLowerCase();
  return switch (v) {
    '' => 'NOT IN WMS',
    'in-stock' => 'LIVE',
    'tag_killed' => 'TAG KILLED',
    'in-transit' => 'IN TRANSIT',
    'pending_visibility' => 'PENDING',
    'pending_transaction' => 'PENDING TX',
    _ => v.replaceAll('_', ' ').toUpperCase(),
  };
}

/// Chip colour per status — same palette as the Status Change badge.
Color itemStatusColor(String? status) {
  final v = (status ?? '').trim().toLowerCase();
  return switch (v) {
    'in-stock' => const Color(0xFF1B7D7D),
    'return' => const Color(0xFF4C4FA1),
    'damaged' => const Color(0xFFBF2E2E),
    'sold' => const Color(0xFF3F4A4A),
    'stolen' => const Color(0xFF2A2A2A),
    'tag_killed' => const Color(0xFF3F4A4A),
    'in-transit' => const Color(0xFF4A6478),
    'unknown' => const Color(0xFFB45309),
    _ => const Color(0xFF6A7A7A),
  };
}

/// Status chip, then "BIN 6-B-02-C" when the tag has an assigned bin.
/// [showStatus] false hides the chip (e.g. while the lookup is still out).
class ItemStatusBinLine extends StatelessWidget {
  const ItemStatusBinLine({
    super.key,
    required this.status,
    required this.bin,
    this.showStatus = true,
  });

  final String? status;
  final String? bin;
  final bool showStatus;

  @override
  Widget build(BuildContext context) {
    final binCode = (bin ?? '').trim();
    final hasBin = binCode.isNotEmpty && binCode != '—';
    if (!showStatus && !hasBin) return const SizedBox.shrink();
    return Wrap(
      spacing: 8.w,
      runSpacing: 4.h,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        if (showStatus)
          Container(
            padding: EdgeInsets.symmetric(horizontal: 7.w, vertical: 2.h),
            color: itemStatusColor(status),
            child: Text(
              itemStatusLabel(status),
              style: GoogleFonts.spaceGrotesk(
                fontSize: 11.sp,
                fontWeight: FontWeight.w900,
                letterSpacing: 0.8,
                color: Colors.white,
                height: 1.2,
              ),
            ),
          ),
        if (hasBin)
          Text(
            'BIN ${formatBinCode(binCode)}',
            style: GoogleFonts.robotoMono(
              fontSize: 13.sp,
              fontWeight: FontWeight.w800,
              color: AppColors.primary,
              height: 1.2,
            ),
          ),
      ],
    );
  }
}
