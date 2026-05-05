import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/epc/epc_codec.dart';
import 'package:carbon_wms/services/epc_tenant_sync.dart';
import 'package:carbon_wms/services/handheld_runtime_config.dart';

/// Cached tenant handheld + EPC payload from `GET /api/settings/mobile-sync`.
class MobileSettingsRepository extends ChangeNotifier {
  MobileSettingsRepository();

  static const _prefsKeyConfig = 'wms_handheld_runtime_config_v1';
  static const _prefsKeySyncRaw = 'wms_mobile_sync_raw_v1';
  // One-shot 1.2.39 migration flag: bump any pre-existing < 30 dBm power once,
  // then never touch the user's slider value again. Without the flag the
  // migration would fight the operator every time they dialed power down.
  static const _prefsKeyDefault30Migration = 'wms_default_30_dbm_migration_v1';

  HandheldRuntimeConfig _config = HandheldRuntimeConfig.fallback;
  Map<String, dynamic>? _lastSyncRoot;
  TenantEpcSettings? _epcSettings;
  List<TenantEpcProfile> _epcProfiles = const [];
  EpcConfig _epcConfig = kFallbackEpcConfig;

  HandheldRuntimeConfig get config => _config;

  Map<String, dynamic>? get lastSyncRoot => _lastSyncRoot;

  TenantEpcSettings? get epcSettings => _epcSettings;

  List<TenantEpcProfile> get epcProfiles => List.unmodifiable(_epcProfiles);

  /// Tenant SGTIN-96 layout used to decode EPCs. Defaults to
  /// [kFallbackEpcConfig] until the first successful sync.
  EpcConfig get epcConfig => _epcConfig;

  void _applySyncRoot(Map<String, dynamic>? root) {
    _lastSyncRoot = root;
    _epcSettings = TenantEpcSettings.fromMobileSyncRoot(root);
    _epcProfiles = TenantEpcProfile.listFromMobileSyncRoot(root);
    _epcConfig = EpcConfig.fromMobileSyncRoot(root) ?? kFallbackEpcConfig;
  }

  /// Runtime-only global power (0–30 dBm) for both transfer directions until next server sync.
  /// Pushes the new value to the live RFID radio in the same tick — pre-1.2.39
  /// the slider only updated SharedPreferences, so the operator had to leave
  /// and re-enter Count / Search-and-Encode for the change to take effect.
  Future<void> setGlobalAntennaPower(int power) async {
    final p = normalizeAntennaPowerDbm(power);
    _config = _config.copyWith(transferOutAntennaPower: p, transferInAntennaPower: p);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_prefsKeyConfig, _config.toJsonString());
    notifyListeners();
    // Best-effort live push. Fails silently on devices without RFID hardware
    // or when the radio session isn't open — those screens will pick the new
    // value up via setAntennaPowerDbm on next entry, exactly as before.
    try {
      await RfidVendorChannel.setAntennaPowerDbm(p);
    } catch (_) {}
  }

  Future<void> loadFromPrefs() async {
    final p = await SharedPreferences.getInstance();
    final raw = p.getString(_prefsKeyConfig);
    final parsed = HandheldRuntimeConfig.fromJsonString(raw);
    if (parsed != null) {
      // 1.2.39 one-shot migration: existing devices have stored power stuck at
      // 27 dBm from a prior server sync. Operator wants 30 as the new default.
      // Bump exactly once (gated by `_prefsKeyDefault30Migration`) so the user
      // can still dial power down later without us fighting them.
      var current = parsed;
      final migrated = p.getBool(_prefsKeyDefault30Migration) ?? false;
      if (!migrated) {
        final out = current.transferOutAntennaPower < kAntennaPowerDbmMax
            ? kAntennaPowerDbmMax
            : current.transferOutAntennaPower;
        final inp = current.transferInAntennaPower < kAntennaPowerDbmMax
            ? kAntennaPowerDbmMax
            : current.transferInAntennaPower;
        current = current.copyWith(
          transferOutAntennaPower: out,
          transferInAntennaPower: inp,
        );
        if (out != parsed.transferOutAntennaPower ||
            inp != parsed.transferInAntennaPower) {
          await p.setString(_prefsKeyConfig, current.toJsonString());
        }
        await p.setBool(_prefsKeyDefault30Migration, true);
      }
      _config = current;
      notifyListeners();
    } else {
      // Fresh install: nothing in prefs yet. Mark the migration as already
      // applied so it doesn't run later (fallback is already 30 dBm).
      await p.setBool(_prefsKeyDefault30Migration, true);
    }
    final syncRaw = p.getString(_prefsKeySyncRaw);
    if (syncRaw != null && syncRaw.isNotEmpty) {
      try {
        _applySyncRoot(jsonDecode(syncRaw) as Map<String, dynamic>);
      } catch (_) {
        _applySyncRoot(null);
      }
    }
  }

  Future<void> syncFromServer(WmsApiClient api, {required String deviceId}) async {
    try {
      final root = await api.fetchMobileSync(deviceId: deviceId);
      if (root == null) return;

      _applySyncRoot(root);
      _config = HandheldRuntimeConfig.fromMobileSyncJson(root);

      final p = await SharedPreferences.getInstance();
      await p.setString(_prefsKeyConfig, _config.toJsonString());
      await p.setString(_prefsKeySyncRaw, jsonEncode(root));

      notifyListeners();
    } catch (e, st) {
      if (kDebugMode) {
        // ignore: avoid_print
        print('[MobileSettingsRepository] sync failed: $e\n$st');
      }
    }
  }
}
