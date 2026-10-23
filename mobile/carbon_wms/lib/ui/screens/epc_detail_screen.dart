import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/tag_page_screen.dart';
import 'package:carbon_wms/ui/widgets/live_item_photo.dart';
import 'package:carbon_wms/ui/widgets/store_zone_icon.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart' show CarbonScaffold;

/// Shows all EPCs for a given SKU inside a bin, under the product photo
/// (read live from the WMS). Tapping an EPC opens its tag page (details +
/// GEIGER). A tag in the STORE zone shows the store icon (owner, 2026-10-23).
class EpcDetailScreen extends StatefulWidget {
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
  State<EpcDetailScreen> createState() => _EpcDetailScreenState();
}

class _EpcDetailScreenState extends State<EpcDetailScreen> {
  /// Upper-case EPCs that are LIVE in the STORE zone.
  Set<String> _inStore = const {};

  String get sku => widget.sku;
  String get description => widget.description;
  List<String> get epcs => widget.epcs;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadZones());
  }

  /// Zone of every tag, in chunks of 500 (the lookup's per-call cap). Best
  /// effort: no network → no icons, the list itself is unchanged.
  Future<void> _loadZones() async {
    if (epcs.isEmpty) return;
    final api = context.read<WmsApiClient>();
    final found = <String>{};
    for (var start = 0; start < epcs.length; start += 500) {
      final end = start + 500 > epcs.length ? epcs.length : start + 500;
      try {
        final rows = await api.lookupEpcs(epcs.sublist(start, end));
        for (final r in rows) {
          final e = ((r['epcHex'] as String?) ?? (r['epc'] as String?))?.trim().toUpperCase();
          final status = (r['status']?.toString() ?? '').toLowerCase();
          if (e != null && e.isNotEmpty && status == 'in-stock' && isStoreZone(r['zone']?.toString())) {
            found.add(e);
          }
        }
      } catch (_) {/* optional */}
    }
    if (mounted && found.isNotEmpty) setState(() => _inStore = found);
  }

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
                  trailing: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (_inStore.contains(epc.trim().toUpperCase())) ...[
                        const StoreZoneIcon(),
                        SizedBox(width: 14.w),
                      ],
                      // Same locate icon as Cloud + Geiger (owner, 2026-10-23).
                      const Icon(
                        LucideIcons.radio,
                        color: AppColors.primary,
                      ),
                    ],
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
