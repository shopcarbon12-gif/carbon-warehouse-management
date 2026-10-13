// Add-On Catalog per-tag decision, made on the phone from the local catalog
// copy (services/live_catalog_cache.dart) instead of a server round trip.
//
// Faithful port of the server lookup (app/api/handheld/epc-lookup/route.ts:
// primary formula first, legacy int(epc[5:15],16) only when the primary
// can't place the tag) plus the decision table the screen used to apply to
// that lookup. One owner change (2026-10-13): tag_killed is now ignored like
// damaged / stolen — migration 0089 keeps killed tags dead, so they must not
// beep, show or upload. lib/server/scan-finalize.ts re-checks the same rule
// inside the upload transaction.

import 'package:carbon_wms/services/epc/epc_codec.dart';
import 'package:carbon_wms/services/live_catalog_models.dart';

final RegExp _legacySlice = RegExp(r'^[0-9A-F]{10}$');

/// Port of lib/server/legacy-epc-catalog.ts legacyEpcSystemId: int(epc[5:15],16).
/// Recognition only — never used to encode/print.
BigInt? legacyEpcSystemId(String epc) {
  final e = epc.trim().toUpperCase();
  if (e.length < 15) return null;
  final slice = e.substring(5, 15);
  if (!_legacySlice.hasMatch(slice)) return null;
  return BigInt.parse(slice, radix: 16);
}

/// Decide what Add-On Catalog does with one EPC.
///
/// | items row      | SKU resolved | verdict   |
/// |----------------|--------------|-----------|
/// | none           | yes          | qualify   |
/// | none           | no           | defective |
/// | `unknown`      | yes          | qualify   |
/// | `unknown`      | no           | ignore    |
/// | anything else  | any          | ignore    |
///
/// "Anything else" covers in-stock (already LIVE), tag_killed / damaged /
/// stolen (owner rule) and sold / return / in-transit / pending_* (always
/// ignored). [skuBySystemId] resolves `custom_skus.ls_system_id` (decimal
/// text) to the line's item info, or null when the catalog has no such SKU.
AddOnCatalogDecision classifyAddOnCatalog({
  required String epc,
  required String? status,
  required EpcConfig cfg,
  required LiveItemInfo? Function(String systemId) skuBySystemId,
}) {
  final e = epc.trim().toUpperCase();
  final p = decodeEpc(e, cfg);
  final primarySid = p.valid ? p.systemId?.toString() : null;
  final primaryInfo = primarySid != null ? skuBySystemId(primarySid) : null;

  // Legacy fallback only when the primary formula didn't resolve a SKU —
  // same order as epc-lookup, so a primary hit always wins.
  String? legacySid;
  LiveItemInfo? legacyInfo;
  if (primaryInfo == null) {
    legacySid = legacyEpcSystemId(e)?.toString();
    legacyInfo = legacySid != null ? skuBySystemId(legacySid) : null;
  }

  final info = primaryInfo ?? legacyInfo;
  final viaLegacy = primaryInfo == null && legacyInfo != null;
  final systemId = primaryInfo != null
      ? primarySid
      : viaLegacy
          ? legacySid
          : primarySid;
  final resolved = info != null && info.sku.trim().isNotEmpty;
  final resolvedInfo = resolved ? info : null;

  AddOnCatalogDecision decide(AddOnCatalogVerdict verdict, String reason) =>
      AddOnCatalogDecision(
        verdict: verdict,
        reason: reason,
        status: status,
        systemId: systemId,
        viaLegacy: viaLegacy,
        info: resolvedInfo,
      );

  if (status == null) {
    // Not in the catalog at all: resolved → LIVE on upload; unresolved
    // (formula-fail / catalog-miss) → Defective (tag_killed on upload).
    return resolved
        ? decide(AddOnCatalogVerdict.qualify, 'no_row_resolved')
        : decide(AddOnCatalogVerdict.defective, 'no_row_unresolved');
  }
  if (status == 'unknown') {
    return resolved
        ? decide(AddOnCatalogVerdict.qualify, 'unknown_resolved')
        : decide(AddOnCatalogVerdict.ignore, 'unknown_unresolved');
  }
  return decide(AddOnCatalogVerdict.ignore, 'status:$status');
}
