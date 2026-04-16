import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/locate_tag_screen.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart' show CarbonScaffold;

/// Shows all EPCs for a given SKU inside a bin.
/// Tapping an EPC navigates to LocateTagScreen (Geiger).
class EpcDetailScreen extends StatelessWidget {
  const EpcDetailScreen({
    super.key,
    required this.sku,
    required this.description,
    required this.epcs,
  });

  final String       sku;
  final String       description;
  final List<String> epcs;

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      pageTitle: sku,
      body: epcs.isEmpty
          ? const Center(
              child: Text(
                'No EPCs found for this SKU.',
                style: TextStyle(color: AppColors.textMuted),
              ),
            )
          : ListView.separated(
              padding: EdgeInsets.all(16.r),
              itemCount: epcs.length,
              separatorBuilder: (_, __) =>
                  Divider(height: 1.h, color: AppColors.border),
              itemBuilder: (context, i) {
                final epc = epcs[i];
                return ListTile(
                  title: Text(
                    epc,
                    style: TextStyle(
                      fontWeight: FontWeight.w600,
                      letterSpacing: 0.8,
                      fontSize: 13.sp,
                    ),
                  ),
                  trailing: Icon(
                    Icons.radar_outlined,
                    color: AppColors.primary,
                  ),
                  onTap: () => Navigator.push(
                    context,
                    MaterialPageRoute<void>(
                      builder: (_) => LocateTagScreen(targetEpc: epc),
                    ),
                  ),
                );
              },
            ),
    );
  }
}
