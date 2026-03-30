import 'dart:convert';
import 'dart:io' show File;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:http/http.dart' as http;
import 'package:install_plugin/install_plugin.dart';
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Edge ingest payload to Carbon WMS (`POST /api/edge/ingest`).
class WmsApiClient {
  WmsApiClient({http.Client? httpClient}) : _http = httpClient ?? http.Client();

  static const String _prefsKeyBase = 'wms_server_base';
  static const String _prefsKeyEdge = 'wms_edge_api_key';
  static const String _prefsKeySession = 'wms_session_token';

  /// Default: Android emulator → host machine. Physical device: set to `http://<LAN-IP>:3040`.
  static const String kDefaultBase = 'http://10.0.2.2:3040';

  final http.Client _http;

  Future<String> resolveBaseUrl() async {
    final p = await SharedPreferences.getInstance();
    return p.getString(_prefsKeyBase)?.trim().isNotEmpty == true
        ? p.getString(_prefsKeyBase)!.trim()
        : kDefaultBase;
  }

  Future<void> setBaseUrl(String url) async {
    final p = await SharedPreferences.getInstance();
    await p.setString(_prefsKeyBase, url.trim());
  }

  /// Must match server `WMS_EDGE_INGEST_KEY` or `WMS_DEVICE_KEY`.
  Future<String?> getSessionToken() async {
    final p = await SharedPreferences.getInstance();
    return p.getString(_prefsKeySession)?.trim();
  }

  Future<void> setSessionToken(String? token) async {
    final p = await SharedPreferences.getInstance();
    final t = token?.trim();
    if (t == null || t.isEmpty) {
      await p.remove(_prefsKeySession);
    } else {
      await p.setString(_prefsKeySession, t);
    }
  }

  Future<({bool ok, bool bypass, String? error})> login({
    required String email,
    required String password,
  }) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/auth/login');
    final res = await _http.post(
      uri,
      headers: const {
        'Content-Type': 'application/json',
        'X-Carbon-Mobile': '1',
      },
      body: jsonEncode({'email': email, 'password': password}),
    });
    final decoded = jsonDecode(res.body);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      final err = decoded is Map ? decoded['error']?.toString() : null;
      return (ok: false, bypass: false, error: err ?? 'Login failed');
    }
    if (decoded is! Map<String, dynamic>) {
      return (ok: false, bypass: false, error: 'Bad response');
    }
    final token = decoded['token'] as String?;
    if (token != null && token.isNotEmpty) {
      await setSessionToken(token);
    }
    return (
      ok: true,
      bypass: decoded['bypassDeviceLock'] == true,
      error: null,
    );
  }

  /// Device gate + OTA hints. Sends Bearer when a mobile session token exists.
  Future<Map<String, dynamic>> fetchMobileStatus({
    required String version,
    String? androidId,
  }) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final q = <String, String>{'version': version};
    if (androidId != null && androidId.isNotEmpty) {
      q['androidId'] = androidId;
    }
    final uri = Uri.parse('$base/api/mobile/status').replace(queryParameters: q);
    final headers = <String, String>{};
    final t = await getSessionToken();
    if (t != null && t.isNotEmpty) {
      headers['Authorization'] = 'Bearer $t';
    }
    final res = await _http.get(uri, headers: headers);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final out = jsonDecode(res.body);
    if (out is Map<String, dynamic>) return out;
    return <String, dynamic>{};
  }

  Future<void> postDevicePing({required String androidId, String? label}) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/mobile/device-ping');
    final t = await getSessionToken();
    if (t == null || t.isEmpty) {
      throw WmsApiException(401, 'No session');
    }
    final res = await _http.post(
      uri,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $t',
      },
      body: jsonEncode({
        'androidId': androidId,
        if (label != null && label.isNotEmpty) 'label': label,
      }),
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
  }

  /// Status-label ghost filter (`hide_in_search_filters` / `hide_in_item_details` / `!auto_display`).
  Future<List<EpcVisibilityResult>> postEpcVisibility({
    required String deviceId,
    required List<String> epcs,
  }) async {
    if (epcs.isEmpty) return [];
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/mobile/epc-visibility');
    final p = await SharedPreferences.getInstance();
    final edgeKey = p.getString(_prefsKeyEdge)?.trim();
    final headers = <String, String>{
      'Content-Type': 'application/json',
      if (edgeKey != null && edgeKey.isNotEmpty) ...{
        'x-edge-api-key': edgeKey,
        'X-WMS-Edge-Key': edgeKey,
      },
    };
    final res = await _http.post(
      uri,
      headers: headers,
      body: jsonEncode({'deviceId': deviceId, 'epcs': epcs}),
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is! Map<String, dynamic>) return [];
    final raw = decoded['results'];
    if (raw is! List) return [];
    final out = <EpcVisibilityResult>[];
    for (final item in raw) {
      if (item is Map<String, dynamic>) {
        final epc = (item['epc'] as String? ?? '').trim().toUpperCase();
        final visible = item['visible'] == true;
        if (epc.isNotEmpty) {
          out.add(EpcVisibilityResult(epc: epc, visible: visible));
        }
      }
    }
    return out;
  }

  Future<void> downloadAndInstallApk(String relativeOrAbsoluteUrl) async {
    if (kIsWeb) return;
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final url = relativeOrAbsoluteUrl.startsWith('http')
        ? relativeOrAbsoluteUrl
        : '$base${relativeOrAbsoluteUrl.startsWith('/') ? '' : '/'}$relativeOrAbsoluteUrl';
    final uri = Uri.parse(url);
    final res = await _http.get(uri);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final dir = await getTemporaryDirectory();
    final file = File('${dir.path}/carbon-wms-update.apk');
    await file.writeAsBytes(res.bodyBytes);
    await InstallPlugin.installApk(file.path, appId: 'com.shopcarbon.wms');
  }

  Future<void> setEdgeApiKey(String? key) async {
    final p = await SharedPreferences.getInstance();
    final t = key?.trim();
    if (t == null || t.isEmpty) {
      await p.remove(_prefsKeyEdge);
    } else {
      await p.setString(_prefsKeyEdge, t);
    }
  }

  /// `POST /api/edge/ingest` — batches from handheld edge.
  Future<void> postEdgeIngest({
    required String deviceId,
    required String scanContext,
    required List<String> epcs,
    Map<String, dynamic> metadata = const {},
  }) async {
    if (epcs.isEmpty) return;

    final base = await resolveBaseUrl();
    final uri = Uri.parse('$base/api/edge/ingest');
    final p = await SharedPreferences.getInstance();
    final edgeKey = p.getString(_prefsKeyEdge)?.trim();
    final body = jsonEncode({
      'deviceId': deviceId,
      'scanContext': scanContext,
      'timestamp': DateTime.now().toUtc().toIso8601String(),
      'epcs': epcs,
      'metadata': metadata,
    });

    final headers = <String, String>{
      'Content-Type': 'application/json',
      if (edgeKey != null && edgeKey.isNotEmpty) ...{
        'x-edge-api-key': edgeKey,
        'X-WMS-Edge-Key': edgeKey,
      },
    };

    final res = await _http.post(
      uri,
      headers: headers,
      body: body,
    );

    // 202 Accepted: fire-and-forget queue (hardened edge gateway).
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
  }

  /// `GET /api/settings/mobile-sync?deviceId=` — same key headers as edge ingest.
  Future<Map<String, dynamic>?> fetchMobileSync({required String deviceId}) async {
    final base = await resolveBaseUrl();
    final uri = Uri.parse('$base/api/settings/mobile-sync').replace(
      queryParameters: {'deviceId': deviceId},
    );
    final p = await SharedPreferences.getInstance();
    final edgeKey = p.getString(_prefsKeyEdge)?.trim();
    final headers = <String, String>{
      if (edgeKey != null && edgeKey.isNotEmpty) ...{
        'x-edge-api-key': edgeKey,
        'X-WMS-Edge-Key': edgeKey,
      },
    };

    final res = await _http.get(uri, headers: headers);
    if (res.statusCode == 401 || res.statusCode == 403) {
      return null;
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is Map<String, dynamic>) return decoded;
    return null;
  }

  Future<Map<String, dynamic>> postInventoryUpload({
    required String deviceId,
    required String mode,
    required String csvData,
  }) async {
    final base = await resolveBaseUrl();
    final uri = Uri.parse('$base/api/inventory/upload');
    final p = await SharedPreferences.getInstance();
    final edgeKey = p.getString(_prefsKeyEdge)?.trim();
    final body = jsonEncode({
      'deviceId': deviceId,
      'mode': mode,
      'csvData': csvData,
    });
    final headers = <String, String>{
      'Content-Type': 'application/json',
      if (edgeKey != null && edgeKey.isNotEmpty) ...{
        'x-edge-api-key': edgeKey,
        'X-WMS-Edge-Key': edgeKey,
      },
    };
    final res = await _http.post(uri, headers: headers, body: body);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is Map<String, dynamic>) return decoded;
    return <String, dynamic>{};
  }

  Future<Map<String, dynamic>> postPutawayAssign({
    required String deviceId,
    required String binCode,
    required String skuScanned,
    required String scope,
  }) async {
    final base = await resolveBaseUrl();
    final uri = Uri.parse('$base/api/inventory/putaway-assign');
    final p = await SharedPreferences.getInstance();
    final edgeKey = p.getString(_prefsKeyEdge)?.trim();
    final body = jsonEncode({
      'deviceId': deviceId,
      'binCode': binCode,
      'skuScanned': skuScanned,
      'scope': scope,
    });
    final headers = <String, String>{
      'Content-Type': 'application/json',
      if (edgeKey != null && edgeKey.isNotEmpty) ...{
        'x-edge-api-key': edgeKey,
        'X-WMS-Edge-Key': edgeKey,
      },
    };
    final res = await _http.post(uri, headers: headers, body: body);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is Map<String, dynamic>) return decoded;
    return <String, dynamic>{};
  }

  void close() => _http.close();
}

class EpcVisibilityResult {
  EpcVisibilityResult({required this.epc, required this.visible});
  final String epc;
  final bool visible;
}

class WmsApiException implements Exception {
  WmsApiException(this.statusCode, this.body);
  final int statusCode;
  final String body;

  @override
  String toString() => 'WmsApiException($statusCode): $body';
}
