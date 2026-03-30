import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/handheld_runtime_config.dart';

/// Cached tenant handheld + EPC payload from `GET /api/settings/mobile-sync`.
class MobileSettingsRepository extends ChangeNotifier {
  MobileSettingsRepository();

  static const _prefsKeyConfig = 'wms_handheld_runtime_config_v1';
  static const _prefsKeySyncRaw = 'wms_mobile_sync_raw_v1';

  HandheldRuntimeConfig _config = HandheldRuntimeConfig.fallback;
  Map<String, dynamic>? _lastSyncRoot;

  HandheldRuntimeConfig get config => _config;

  Map<String, dynamic>? get lastSyncRoot => _lastSyncRoot;

  Future<void> loadFromPrefs() async {
    final p = await SharedPreferences.getInstance();
    final raw = p.getString(_prefsKeyConfig);
    final parsed = HandheldRuntimeConfig.fromJsonString(raw);
    if (parsed != null) {
      _config = parsed;
      notifyListeners();
    }
    final syncRaw = p.getString(_prefsKeySyncRaw);
    if (syncRaw != null && syncRaw.isNotEmpty) {
      try {
        _lastSyncRoot = jsonDecode(syncRaw) as Map<String, dynamic>;
      } catch (_) {
        _lastSyncRoot = null;
      }
    }
  }

  Future<void> syncFromServer(WmsApiClient api, {required String deviceId}) async {
    try {
      final root = await api.fetchMobileSync(deviceId: deviceId);
      if (root == null) return;

      _lastSyncRoot = root;
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
