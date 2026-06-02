import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:carbon_wms/network/wms_api_client.dart';

/// Phase 2 — mobile-side enforcement of the WMS "Mobile Role" matrix that
/// admins configure at `wms.shopcarbon.com/settings/users → WMS Mobile`.
///
/// Source of truth lives server-side: `GET /api/mobile/permissions` returns
/// the operator's role, a `hiddenScreens` list (flat screen-id strings —
/// see `ScreenIds` below for the catalog), and a nested `permissions` map.
/// The mobile app honours `hiddenScreens`: any id in that set means the
/// screen entry is hidden from menus AND direct navigation is blocked.
///
/// Two escape hatches the server enforces and we mirror:
///   1. `isSuperAdmin == true`  → full access, never hide anything.
///   2. `hiddenScreens` is empty → full access (covers seeded "Super Admin"
///      and "Manager" roles, plus users with no Mobile Role assigned).
///
/// Fail-open by design: if the network fetch fails and we have no cached
/// value yet, we treat the user as having full access. That covers first-
/// launch-offline and brief network blips, and matches the spec ("don't
/// lock a user out of a working app"). A stale cache is preferred over a
/// fresh fetch when both exist on the same launch — we still re-fetch on
/// every login, so the cache can't drift more than one session.
class MobilePermissions extends ChangeNotifier {
  MobilePermissions();

  /// SharedPreferences key for the cached payload (single global slot —
  /// overwritten on every successful fetch, cleared on logout).
  static const String _prefsKey = 'wms_mobile_permissions_v1';

  String? _role;
  bool _isSuperAdmin = false;
  Set<String> _hiddenScreens = const <String>{};

  /// `true` once we've loaded *something* — either a cached value at boot,
  /// or a fresh fetch after login. Until then we're in the fail-open
  /// "everything visible" mode. Surfaced so UI can show a subtle
  /// "permissions not refreshed" indicator if it wants to.
  bool _loaded = false;

  /// Last network outcome — `null` on success or before the first attempt.
  /// Surfaced to settings drawer so the operator can tell why a tile is
  /// missing (or why it's still showing when they expected it to be gone).
  String? _lastError;

  String? get role => _role;
  bool get isSuperAdmin => _isSuperAdmin;
  Set<String> get hiddenScreens => _hiddenScreens;
  bool get loaded => _loaded;
  String? get lastError => _lastError;

  /// `true` when no remote restrictions apply — either the user is a
  /// Super Admin, or the server returned an empty `hiddenScreens` list,
  /// or we haven't loaded anything yet (fail-open).
  bool get hasFullAccess =>
      !_loaded || _isSuperAdmin || _hiddenScreens.isEmpty;

  /// Returns `true` when the given screen id is allowed for this user.
  /// Always returns `true` for `login` / `device_lock` (the auth gate
  /// needs them to be reachable regardless of role) and for any id not
  /// present in [_hiddenScreens].
  bool canView(String screenId) {
    if (screenId.isEmpty) return true;
    if (screenId == ScreenIds.login || screenId == ScreenIds.deviceLock) {
      return true;
    }
    if (hasFullAccess) return true;
    return !_hiddenScreens.contains(screenId);
  }

  /// Read the last cached payload from SharedPreferences. Safe to call at
  /// app boot before any network is available.
  Future<void> loadCached() async {
    try {
      final p = await SharedPreferences.getInstance();
      final raw = p.getString(_prefsKey);
      if (raw == null || raw.isEmpty) return;
      final decoded = jsonDecode(raw);
      if (decoded is Map<String, dynamic>) {
        _applyPayload(decoded);
      }
    } catch (e) {
      _lastError = 'cache parse failed: $e';
    }
  }

  /// Re-fetch from the server and persist. On network/server error we
  /// keep the previously loaded value (do NOT clear permissions on a
  /// transient failure — fail-open only applies when we have nothing).
  Future<void> refresh(WmsApiClient api) async {
    try {
      final payload = await api.fetchMobilePermissions();
      if (payload == null) {
        _lastError = 'empty response';
        if (!_loaded) {
          // First-ever fetch returned nothing — leave us in fail-open mode.
          notifyListeners();
        }
        return;
      }
      _applyPayload(payload);
      try {
        final p = await SharedPreferences.getInstance();
        await p.setString(_prefsKey, jsonEncode(payload));
      } catch (_) {
        /* cache write best-effort; in-memory state is authoritative */
      }
      _lastError = null;
    } on WmsApiException catch (e) {
      _lastError = 'HTTP ${e.statusCode}';
      // Don't clear existing state. If we had nothing, stay in fail-open.
      notifyListeners();
    } catch (e) {
      _lastError = e.toString();
      notifyListeners();
    }
  }

  /// Wipe in-memory + cache. Call from the logout path so the next operator
  /// can't briefly see this operator's permissions while their own fetch
  /// is in flight.
  Future<void> clear() async {
    _role = null;
    _isSuperAdmin = false;
    _hiddenScreens = const <String>{};
    _loaded = false;
    _lastError = null;
    try {
      final p = await SharedPreferences.getInstance();
      await p.remove(_prefsKey);
    } catch (_) {
      /* best-effort */
    }
    notifyListeners();
  }

  void _applyPayload(Map<String, dynamic> json) {
    _role = json['role'] is String ? json['role'] as String : null;
    _isSuperAdmin = json['isSuperAdmin'] == true;
    final hidden = json['hiddenScreens'];
    if (hidden is List) {
      _hiddenScreens = hidden
          .whereType<String>()
          .map((s) => s.trim())
          .where((s) => s.isNotEmpty)
          .toSet();
    } else {
      _hiddenScreens = const <String>{};
    }
    _loaded = true;
    notifyListeners();
  }
}

/// Canonical screen-id catalog. These strings are the contract with
/// `/api/mobile/permissions` — they MUST match the ids the server sends.
/// Mirrors the table in the WMS task brief and the file names under
/// `lib/ui/screens/` (minus the `_screen.dart` suffix).
abstract final class ScreenIds {
  // Auth — never gated, listed here for type-safety in canView calls.
  static const String login = 'login';
  static const String deviceLock = 'device_lock';

  // Home
  static const String dashboard = 'dashboard';

  // Inventory
  static const String inventoryHub = 'inventory_hub';
  static const String inventoryCatalog = 'inventory_catalog';
  static const String inventoryLookup = 'inventory_lookup';
  static const String countInventory = 'count_inventory';
  static const String fastPutaway = 'fast_putaway';
  static const String cleanBin = 'clean_bin';
  static const String binAssignSettings = 'bin_assign_settings';
  static const String inventoryCsvSession = 'inventory_csv_session';

  // Add-On Count
  static const String addOnCount = 'add_on_count';
  static const String addOnCountSourcePicker = 'add_on_count_source_picker';
  static const String addOnCountReview = 'add_on_count_review';
  static const String addOnCountSettings = 'add_on_count_settings';

  // Transfers
  static const String transferSlips = 'transfer_slips';
  static const String transferInPending = 'transfer_in_pending';
  static const String transferInReceive = 'transfer_in_receive';
  static const String transferOutReports = 'transfer_out_reports';
  static const String transferReportsHub = 'transfer_reports_hub';

  // Encode & Print
  static const String encode = 'encode';
  static const String encodeSuite = 'encode_suite';
  static const String encodeTestTag = 'encode_test_tag';
  static const String searchAndEncode = 'search_and_encode';
  static const String encodeAndPrint = 'encode_and_print';
  static const String print = 'print';
  static const String barcodeIntake = 'barcode_intake';
  static const String statusChange = 'status_change';

  // Find Tags
  static const String geigerSearch = 'geiger_search';
  static const String cloudGeiger = 'cloud_geiger';
  static const String locateTag = 'locate_tag';
  static const String epcDetail = 'epc_detail';

  // Reports
  static const String reportsHub = 'reports_hub';
  static const String countReports = 'count_reports';
  static const String statusReports = 'status_reports';
  static const String damagesReports = 'damages_reports';
  /// Mobile-only id (not yet in the server-side hidden-screens catalog —
  /// flag for the WMS agent so they can wire it up when the role matrix
  /// expands). Until the server returns it, this tile is visible to
  /// everyone with `reports_hub` access (fail-open).
  static const String reEncodeReports = 're_encode_reports';

  // Settings
  static const String handheldSettings = 'handheld_settings';
}
