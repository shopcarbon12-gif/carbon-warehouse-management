// STORE zone marker (owner, 2026-10-22): a teal store icon — no number, no
// text — on every size that has LIVE tags in the Zone Management zone named
// "Store", and on every single tag that is in it. Same rule as the desktop
// catalog's Channels icon (components/inventory/catalog/store-zone-icon.tsx).

import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:lucide_icons/lucide_icons.dart';

import 'package:carbon_wms/theme/app_theme.dart';

/// The Zone Management zone the app marks with the store icon (name, any case).
bool isStoreZone(String? zoneName) => (zoneName ?? '').trim().toLowerCase() == 'store';

/// `store_zone_count` / `storeZoneCount` from a WMS row, 0 when absent.
int storeZoneCountOf(Map<String, dynamic>? row) {
  if (row == null) return 0;
  final v = row['store_zone_count'] ?? row['storeZoneCount'];
  if (v is num) return v.toInt();
  return int.tryParse('${v ?? ''}') ?? 0;
}

class StoreZoneIcon extends StatelessWidget {
  const StoreZoneIcon({super.key, this.size, this.color});

  /// Logical size before ScreenUtil scaling; default 22.
  final double? size;

  /// Defaults to the app teal; white on a selected (teal) card.
  final Color? color;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: 'In the Store zone',
      child: Icon(LucideIcons.store, size: (size ?? 22).r, color: color ?? AppColors.primary),
    );
  }
}
