import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';

import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/tag_page_screen.dart';
import 'package:carbon_wms/ui/widgets/live_item_photo.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart' show CarbonScaffold;

/// Shows all EPCs for a given SKU inside a bin, under the product photo
/// (read live from the WMS). Tapping an EPC opens its tag page (details +
/// GEIGER).
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
              itemCount: epcs.length + 1,
              separatorBuilder: (_, __) =>
                  Divider(height: 1.h, color: AppColors.border),
              itemBuilder: (context, i) {
                if (i == 0) {
                  // Product photo, read live from the WMS on every open.
                  return Padding(
                    padding: EdgeInsets.only(bottom: 12.h),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        LiveItemPhoto(sku: sku, height: 170, title: description),
                        if (description.isNotEmpty) ...[
                          SizedBox(height: 8.h),
                          Text(description,
                              style: TextStyle(fontWeight: FontWeight.w700, fontSize: 14.sp)),
                        ],
                        Text('${epcs.length} tag${epcs.length == 1 ? '' : 's'} — tap one to open it',
                            style: TextStyle(color: AppColors.textMuted, fontSize: 12.sp)),
                      ],
                    ),
                  );
                }
                final epc = epcs[i - 1];
                return ListTile(
                  title: Text(
                    epc,
                    style: TextStyle(
                      fontWeight: FontWeight.w600,
                      letterSpacing: 0.8,
                      fontSize: 13.sp,
                    ),
                  ),
                  trailing: const Icon(
                    Icons.radar_outlined,
                    color: AppColors.primary,
                  ),
                  onTap: () => Navigator.push(
                    context,
                    MaterialPageRoute<void>(
                      builder: (_) => TagPageScreen(
                        epc: epc,
                        fallbackSku: sku.isEmpty ? null : sku,
                        fallbackName: description.isEmpty ? null : description,
                      ),
                    ),
                  ),
                );
              },
            ),
    );
  }
}
