// Value types shared by the local live catalog (services/live_catalog_cache.dart),
// the Add-On Catalog classifier and the add-on screens. Pure data — no I/O.

import 'package:flutter/foundation.dart';

/// Item identity the phone shows on a line. Built from the local catalog copy.
@immutable
class LiveItemInfo {
  const LiveItemInfo({
    required this.skuId,
    this.systemId,
    required this.sku,
    required this.name,
    required this.color,
    required this.size,
    this.retailPrice,
    this.binDisplay,
    this.archived = false,
  });

  final String skuId; // custom_skus.id
  final String? systemId; // custom_skus.ls_system_id (decimal string)
  final String sku; // custom_skus.sku
  final String name; // matrices.description, '' when unknown
  final String color; // '' when null
  final String size; // '' when null
  final String? retailPrice; // raw numeric text, e.g. "52.00"
  /// Comma-joined bin codes, same shape as the catalog `bin_location`
  /// (render with `formatBinDisplay`).
  final String? binDisplay;
  final bool archived;
}

enum AddOnCatalogVerdict { ignore, qualify, defective }

@immutable
class AddOnCatalogDecision {
  const AddOnCatalogDecision({
    required this.verdict,
    required this.reason,
    this.status,
    this.systemId,
    this.viaLegacy = false,
    this.info,
  });

  final AddOnCatalogVerdict verdict;

  /// `no_row_resolved` | `no_row_unresolved` | `unknown_resolved` |
  /// `unknown_unresolved` | `status:<status>`
  final String reason;

  /// items.status, null = no row.
  final String? status;

  /// Resolved system id (the legacy one when [viaLegacy]), else the primary
  /// decode, else null.
  final String? systemId;
  final bool viaLegacy;

  /// Non-null exactly when the SKU resolved.
  final LiveItemInfo? info;
}

enum LiveCatalogPhase { empty, loading, ready, error }

@immutable
class LiveCatalogSyncState {
  const LiveCatalogSyncState({
    required this.phase,
    this.lastSyncedAt,
    this.error,
    this.itemCount = 0,
    this.refreshing = false,
  });

  /// ready = data in memory (may be stale; see [lastSyncedAt] / [error]).
  final LiveCatalogPhase phase;

  /// Phone clock of the last successful snapshot/delta (for a copy loaded
  /// from disk and not yet synced: when that copy was saved).
  final DateTime? lastSyncedAt;

  /// Last refresh error, null after a success.
  final String? error;
  final int itemCount;
  final bool refreshing;

  // Value equality so the ValueNotifier only fires on a real change.
  @override
  bool operator ==(Object other) =>
      other is LiveCatalogSyncState &&
      other.phase == phase &&
      other.lastSyncedAt == lastSyncedAt &&
      other.error == error &&
      other.itemCount == itemCount &&
      other.refreshing == refreshing;

  @override
  int get hashCode => Object.hash(phase, lastSyncedAt, error, itemCount, refreshing);
}
