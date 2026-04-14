import 'dart:convert';
import 'dart:io' show File, HttpClient, Platform, exit;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';
import 'package:install_plugin/install_plugin.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:path_provider/path_provider.dart';
import 'package:restart_app/restart_app.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Edge ingest payload to Carbon WMS (`POST /api/edge/ingest`).
class WmsApiClient {
  WmsApiClient({http.Client? httpClient}) : _http = httpClient ?? _createDefaultHttpClient();

  static const String _prefsKeyBase = 'wms_server_base';
  static const String _prefsKeyEdge = 'wms_edge_api_key';
  static const String _prefsKeySession = 'wms_session_token';
  static const String _prefsRecentServers = 'wms_recent_servers_v1';
  static const String _prefsSavedLoginEmail = 'wms_saved_login_email';
  static const String _prefsRememberLoginEmail = 'wms_remember_login_email_v1';

  /// Optional: `flutter run --dart-define=CARBON_WMS_DEV_HOST=http://10.0.2.2:3040` for emulator.
  /// Otherwise empty — user enters production URL on login (e.g. https://wms.shopcarbon.com).
  static String get kDefaultBase {
    const fromDefine = String.fromEnvironment('CARBON_WMS_DEV_HOST', defaultValue: '');
    if (fromDefine.isNotEmpty) return fromDefine;
    return '';
  }

  /// Fixed server URL for the handheld app login screen (production). Uses [kDefaultBase] when set via dart-define.
  static String get lockedServerUrl {
    if (kDefaultBase.isNotEmpty) return normalizeBaseUrl(kDefaultBase);
    return normalizeBaseUrl('https://wms.shopcarbon.com');
  }

  final http.Client _http;

  static http.Client _createDefaultHttpClient() {
    if (kIsWeb) return http.Client();
    final hc = HttpClient()
      ..connectionTimeout = const Duration(seconds: 20)
      ..idleTimeout = const Duration(seconds: 60);
    return IOClient(hc);
  }

  /// Trim, add https if no scheme, strip trailing slashes.
  static String normalizeBaseUrl(String raw) {
    var s = raw.trim();
    if (s.isEmpty) return '';
    if (!s.contains('://')) {
      s = 'https://$s';
    }
    return s.replaceAll(RegExp(r'/+$'), '');
  }

  Future<String> resolveBaseUrl() async {
    final p = await SharedPreferences.getInstance();
    final saved = p.getString(_prefsKeyBase)?.trim();
    if (saved != null && saved.isNotEmpty) return saved;
    return kDefaultBase;
  }

  Future<void> setBaseUrl(String url) async {
    final p = await SharedPreferences.getInstance();
    final n = normalizeBaseUrl(url);
    if (n.isEmpty) {
      await p.remove(_prefsKeyBase);
      return;
    }
    await p.setString(_prefsKeyBase, n);
    await rememberServerUrl(n);
  }

  Future<List<String>> listRecentServerUrls() async {
    final p = await SharedPreferences.getInstance();
    final raw = p.getString(_prefsRecentServers);
    if (raw == null || raw.isEmpty) return [];
    try {
      final j = jsonDecode(raw);
      if (j is List) {
        return j.map((e) => e.toString().trim()).where((s) => s.isNotEmpty).cast<String>().toList();
      }
    } catch (_) {
      /* ignore */
    }
    return [];
  }

  Future<void> rememberServerUrl(String url) async {
    final n = normalizeBaseUrl(url);
    if (n.isEmpty) return;
    final prev = await listRecentServerUrls();
    final next = <String>[n, ...prev.where((s) => s != n)].take(5).toList();
    final p = await SharedPreferences.getInstance();
    await p.setString(_prefsRecentServers, jsonEncode(next));
  }

  Future<String?> getSavedLoginEmail() async {
    final p = await SharedPreferences.getInstance();
    return p.getString(_prefsSavedLoginEmail)?.trim();
  }

  Future<void> setSavedLoginEmail(String? email) async {
    final p = await SharedPreferences.getInstance();
    final t = email?.trim();
    if (t == null || t.isEmpty) {
      await p.remove(_prefsSavedLoginEmail);
    } else {
      await p.setString(_prefsSavedLoginEmail, t);
    }
  }

  /// When true (default), last successful email is restored on the login screen.
  Future<bool> getRememberLoginEmail() async {
    final p = await SharedPreferences.getInstance();
    return p.getBool(_prefsRememberLoginEmail) ?? true;
  }

  Future<void> setRememberLoginEmail(bool value) async {
    final p = await SharedPreferences.getInstance();
    await p.setBool(_prefsRememberLoginEmail, value);
    if (!value) await setSavedLoginEmail(null);
  }

  Future<Map<String, String>> handheldAuthHeaders() async {
    final h = <String, String>{};
    final p = await SharedPreferences.getInstance();
    final edgeKey = p.getString(_prefsKeyEdge)?.trim();
    if (edgeKey != null && edgeKey.isNotEmpty) {
      h['x-edge-api-key'] = edgeKey;
      h['X-WMS-Edge-Key'] = edgeKey;
    }
    final t = await getSessionToken();
    if (t != null && t.isNotEmpty) {
      h['Authorization'] = 'Bearer $t';
    }
    return h;
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
    );
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

  Future<void> postDevicePing({
    required String androidId,
    String? label,
    Map<String, dynamic>? clientInfo,
  }) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/mobile/device-ping');
    final t = await getSessionToken();
    if (t == null || t.isEmpty) {
      throw WmsApiException(401, 'No session');
    }
    final body = <String, dynamic>{
      'androidId': androidId,
      if (label != null && label.isNotEmpty) 'label': label,
      if (clientInfo != null && clientInfo.isNotEmpty) 'clientInfo': clientInfo,
    };
    final res = await _http.post(
      uri,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $t',
      },
      body: jsonEncode(body),
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
  }

  /// Status-label ghost filter (server uses `is_visible_to_scanner` / Clean 10 rules).
  Future<List<EpcVisibilityResult>> postEpcVisibility({
    required String deviceId,
    required List<String> epcs,
  }) async {
    if (epcs.isEmpty) return [];
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/mobile/epc-visibility');
    final headers = <String, String>{
      'Content-Type': 'application/json',
      ...await handheldAuthHeaders(),
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

  /// APK files are ZIP archives and must start with local file header `PK\x03\x04`.
  static bool _looksLikeApkBytes(List<int> bytes) {
    if (bytes.length < 4) return false;
    return bytes[0] == 0x50 && bytes[1] == 0x4b && bytes[2] == 0x03 && bytes[3] == 0x04;
  }

  /// Rejects folder URLs and non-.apk paths (e.g. nginx directory index under `/storage/apk/`).
  static void assertOtaUrlIsApkFile(String resolvedUrl) {
    final uri = Uri.parse(resolvedUrl.trim());
    final path = uri.path;
    final lower = path.toLowerCase();
    if (path.isEmpty || path.endsWith('/')) {
      throw StateError(
        'OTA URL must point to one .apk file, not a folder. In WMS → Settings → Mobile OTA, upload the APK again so the active release stores the full file URL.',
      );
    }
    if (!lower.endsWith('.apk')) {
      throw StateError(
        'OTA URL must end with .apk. Fix the active release in WMS → Settings → Mobile OTA.',
      );
    }
  }

  Future<void> downloadAndInstallApk(String relativeOrAbsoluteUrl) async {
    if (kIsWeb) return;
    if (!Platform.isAndroid) {
      throw UnsupportedError('In-app APK install is supported on Android only.');
    }
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final url = relativeOrAbsoluteUrl.startsWith('http')
        ? relativeOrAbsoluteUrl
        : '$base${relativeOrAbsoluteUrl.startsWith('/') ? '' : '/'}$relativeOrAbsoluteUrl';
    assertOtaUrlIsApkFile(url);
    final uri = Uri.parse(url);
    final res = await _http.get(uri);
    if (res.statusCode == 404) {
      throw StateError(
        'APK not found (HTTP 404). Re-upload the same build in WMS → Settings → Mobile OTA (Linux paths are case-sensitive; '
        'URL vs filename mismatch causes this even with a volume). Without /app/public/uploads mounted, redeploys also remove APKs.',
      );
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final body = res.bodyBytes;
    if (!_looksLikeApkBytes(body)) {
      final head = String.fromCharCodes(body.take(200).where((b) => b >= 32 && b < 127));
      final isHtml = head.startsWith('<!') || head.startsWith('<h');
      final isIndex = head.toLowerCase().contains('index of');
      final hint = isHtml
          ? (isIndex
              ? ' (server returned a directory listing — the OTA URL must be the full .apk path, not a folder.)'
              : ' (server returned HTML — often a login page; ensure GET /uploads/mobile-apk/… is public in the proxy.)')
          : '';
      throw StateError('Download is not a valid APK (wrong file signature).$hint');
    }
    final dir = await getTemporaryDirectory();
    final file = File('${dir.path}/carbon-wms-update.apk');
    await file.writeAsBytes(body);

    final before = await PackageInfo.fromPlatform();
    final baselineBuild = before.buildNumber;
    final baselineVersion = before.version;

    final raw = await InstallPlugin.installApk(file.path, appId: 'com.shopcarbon.wms');
    final ok = raw is Map && (raw['isSuccess'] == true);

    void shutdownWithoutReopen() {
      exit(0);
    }

    if (!ok) {
      shutdownWithoutReopen();
      return;
    }

    PackageInfo after = before;
    for (var i = 0; i < 12; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 350));
      after = await PackageInfo.fromPlatform();
      if (after.buildNumber != baselineBuild || after.version != baselineVersion) {
        await Restart.restartApp(
          notificationTitle: 'CarbonWMS',
          notificationBody: 'Update installed — restarting…',
        );
        return;
      }
    }
    shutdownWithoutReopen();
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
    final body = jsonEncode({
      'deviceId': deviceId,
      'scanContext': scanContext,
      'timestamp': DateTime.now().toUtc().toIso8601String(),
      'epcs': epcs,
      'metadata': metadata,
    });

    final headers = <String, String>{
      'Content-Type': 'application/json',
      ...await handheldAuthHeaders(),
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
    final headers = await handheldAuthHeaders();

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
    final body = jsonEncode({
      'deviceId': deviceId,
      'mode': mode,
      'csvData': csvData,
    });
    final headers = <String, String>{
      'Content-Type': 'application/json',
      ...await handheldAuthHeaders(),
    };
    final res = await _http.post(uri, headers: headers, body: body);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is Map<String, dynamic>) return decoded;
    return <String, dynamic>{};
  }

  Future<Map<String, String>> sessionAuthHeaders() async {
    final t = await getSessionToken();
    final h = <String, String>{};
    if (t != null && t.isNotEmpty) {
      h['Authorization'] = 'Bearer $t';
    }
    return h;
  }

  /// Active locations for the signed-in user (`GET /api/locations`) — returns [{code, name}].
  Future<List<Map<String, String>>> fetchSessionLocations() async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/locations');
    final res = await _http.get(uri, headers: await sessionAuthHeaders());
    if (res.statusCode == 401 || res.statusCode == 403) return [];
    if (res.statusCode < 200 || res.statusCode >= 300) return [];
    final decoded = jsonDecode(res.body);
    if (decoded is! List) return [];
    final out = <Map<String, String>>[];
    for (final item in decoded) {
      if (item is Map) {
        final code = item['code']?.toString() ?? '';
        final name = item['name']?.toString() ?? code;
        if (code.isNotEmpty) out.add({'code': code, 'name': name});
      }
    }
    return out;
  }

  /// Active location codes for the signed-in user (`GET /api/locations`).
  Future<List<String>> fetchSessionLocationCodes() async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/locations');
    final res = await _http.get(uri, headers: await sessionAuthHeaders());
    if (res.statusCode == 401 || res.statusCode == 403) {
      return [];
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is! List) return [];
    final out = <String>[];
    for (final item in decoded) {
      if (item is Map && item['code'] != null) {
        out.add(item['code'].toString());
      }
    }
    return out;
  }

  /// First page of catalog grid rows for search (session Bearer).
  Future<Map<String, dynamic>?> catalogGridSearchFirstRow(String q) async {
    final qt = q.trim();
    if (qt.isEmpty) return null;
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/inventory/catalog').replace(
      queryParameters: {
        'view': 'grid',
        'page': '1',
        'limit': '8',
        'q': qt,
      },
    );
    final res = await _http.get(uri, headers: await sessionAuthHeaders());
    if (res.statusCode < 200 || res.statusCode >= 300) {
      return null;
    }
    final decoded = jsonDecode(res.body);
    if (decoded is! Map<String, dynamic>) return null;
    final rows = decoded['rows'];
    if (rows is! List || rows.isEmpty) return null;
    final first = rows.first;
    if (first is Map<String, dynamic>) return first;
    return null;
  }

  /// Bumps WMS on-hand for the resolved custom SKU (`ls_on_hand_total`) and writes `inventory_audit_logs`.
  Future<void> postBarcodeIntakeLog({
    required String barcode,
    String? sku,
    String? customSkuId,
    required int qty,
    String? title,
  }) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/mobile/barcode-intake');
    final body = <String, dynamic>{
      'barcode': barcode,
      'qty': qty,
      if (sku != null && sku.isNotEmpty) 'sku': sku,
      if (customSkuId != null && customSkuId.isNotEmpty) 'customSkuId': customSkuId,
      if (title != null && title.isNotEmpty) 'title': title,
    };
    final res = await _http.post(
      uri,
      headers: {
        ...await sessionAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: jsonEncode(body),
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
  }

  Future<Map<String, dynamic>> postPutawayAssign({
    required String deviceId,
    required String binCode,
    required String skuScanned,
    required String scope,
  }) async {
    final base = await resolveBaseUrl();
    final uri = Uri.parse('$base/api/inventory/putaway-assign');
    final body = jsonEncode({
      'deviceId': deviceId,
      'binCode': binCode,
      'skuScanned': skuScanned,
      'scope': scope,
    });
    final headers = <String, String>{
      'Content-Type': 'application/json',
      ...await handheldAuthHeaders(),
    };
    final res = await _http.post(uri, headers: headers, body: body);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is Map<String, dynamic>) return decoded;
    return <String, dynamic>{};
  }

  // --- Transfer slips (session Bearer; requires manager+ on server) ---

  Future<List<dynamic>> fetchTransferSlips() async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/inventory/transfer-slips');
    final res = await _http.get(uri, headers: await sessionAuthHeaders());
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is List) return decoded;
    return [];
  }

  Future<Map<String, dynamic>> createTransferSlip({
    required String sourceLoc,
    required String destLoc,
    List<String>? epcs,
  }) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/inventory/transfer-slips');
    final body = <String, dynamic>{
      'sourceLoc': sourceLoc,
      'destLoc': destLoc,
      if (epcs != null && epcs.isNotEmpty) 'epcs': epcs,
    };
    final res = await _http.post(
      uri,
      headers: {
        ...await sessionAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: jsonEncode(body),
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is Map<String, dynamic>) return decoded;
    return <String, dynamic>{};
  }

  Future<Map<String, dynamic>> getTransferSlip(int slipNumber) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/inventory/transfer-slips/$slipNumber');
    final res = await _http.get(uri, headers: await sessionAuthHeaders());
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is Map<String, dynamic>) return decoded;
    return <String, dynamic>{};
  }

  Future<Map<String, dynamic>> postTransferSlipAction(
    int slipNumber,
    Map<String, dynamic> body,
  ) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/inventory/transfer-slips/$slipNumber');
    final res = await _http.post(
      uri,
      headers: {
        ...await sessionAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: jsonEncode(body),
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is Map<String, dynamic>) return decoded;
    return <String, dynamic>{};
  }

  Future<Map<String, dynamic>> postCleanBinByCode(String binCode) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/mobile/clean-bin');
    final res = await _http.post(
      uri,
      headers: {
        ...await sessionAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: jsonEncode({'binCode': binCode.trim()}),
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is Map<String, dynamic>) return decoded;
    return <String, dynamic>{};
  }

  /// `DELETE /api/locations/bins/:binCode/sku/:sku` — removes a SKU assignment from a bin.
  Future<void> removeSkuFromBin(String binCode, String sku) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final encodedBin = Uri.encodeComponent(binCode.trim());
    final encodedSku = Uri.encodeComponent(sku.trim());
    final uri = Uri.parse('$base/api/locations/bins/$encodedBin/sku/$encodedSku');
    final res = await _http.delete(uri, headers: await sessionAuthHeaders());
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
  }

  Future<Map<String, dynamic>?> fetchItemDetailByEpc(String epc) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/mobile/item-detail').replace(
      queryParameters: {'epc': epc.trim()},
    );
    final res = await _http.get(uri, headers: await sessionAuthHeaders());
    if (res.statusCode == 404) return null;
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is! Map<String, dynamic>) return null;
    return decoded;
  }

  Future<Map<String, dynamic>> postBulkStatus({
    required List<String> epcs,
    required String targetStatus,
    bool override = false,
  }) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/inventory/bulk-status');
    final res = await _http.post(
      uri,
      headers: {
        ...await sessionAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: jsonEncode({
        'epcs': epcs,
        'targetStatus': targetStatus,
        if (override) 'override': true,
      }),
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is Map<String, dynamic>) return decoded;
    return <String, dynamic>{};
  }

  Future<List<dynamic>> fetchRfidCatalogSearch(String q) async {
    final qt = q.trim();
    if (qt.length < 2) return [];
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/rfid/catalog-search').replace(
      queryParameters: {'q': qt},
    );
    final res = await _http.get(uri, headers: await sessionAuthHeaders());
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    final m = decoded is Map<String, dynamic> ? decoded['matches'] : null;
    if (m is List) return m;
    return [];
  }

  Future<Map<String, dynamic>> postRfidCommission({
    required String customSkuId,
    required int qty,
    bool addToInventory = false,
    String? binId,
  }) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/rfid/commission');
    final body = <String, dynamic>{
      'customSkuId': customSkuId,
      'qty': qty,
      'addToInventory': addToInventory,
      if (binId != null && binId.isNotEmpty) 'binId': binId,
    };
    final res = await _http.post(
      uri,
      headers: {
        ...await sessionAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: jsonEncode(body),
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is Map<String, dynamic>) return decoded;
    return <String, dynamic>{};
  }

  /// `GET /api/dashboard/summary` — inventory units, open orders, exceptions (Bearer auth).
  Future<Map<String, dynamic>> fetchDashboardStats() async {
    try {
      final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
      final uri = Uri.parse('$base/api/dashboard/summary');
      final res = await _http.get(uri, headers: await sessionAuthHeaders());
      if (res.statusCode < 200 || res.statusCode >= 300) return {};
      final decoded = jsonDecode(res.body);
      if (decoded is Map<String, dynamic>) return decoded;
    } catch (_) {}
    return {};
  }

  /// `GET /api/inventory/catalog?view=grid&matrixId=:id` — all color rows for a product matrix.
  Future<List<dynamic>> fetchCatalogMatrixRows(String matrixId) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/inventory/catalog').replace(
      queryParameters: {'view': 'grid', 'page': '1', 'limit': '100', 'matrixId': matrixId},
    );
    final res = await _http.get(uri, headers: await sessionAuthHeaders());
    if (res.statusCode < 200 || res.statusCode >= 300) return [];
    final decoded = jsonDecode(res.body);
    if (decoded is Map<String, dynamic>) {
      final rows = decoded['rows'];
      return rows is List ? rows : [];
    }
    return [];
  }

  /// `GET /api/locations/bins` — returns list of all bins.
  Future<List<dynamic>> fetchBins() async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/locations/bins');
    final res = await _http.get(uri, headers: await sessionAuthHeaders());
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    return decoded is List ? decoded : [];
  }

  /// `GET /api/locations/bins/contents?binId=:id` — returns grouped contents for a bin.
  Future<List<dynamic>> fetchBinContents(String binId) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/locations/bins/contents').replace(
      queryParameters: {'binId': binId},
    );
    final res = await _http.get(uri, headers: await sessionAuthHeaders());
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    return decoded is List ? decoded : [];
  }

  /// `POST /api/locations/bins` — creates a new bin with the given code.
  Future<Map<String, dynamic>> createBin(String code) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    // Fetch the session's location ID first
    final locUri = Uri.parse('$base/api/locations');
    final locRes = await _http.get(locUri, headers: await sessionAuthHeaders());
    String? locationId;
    if (locRes.statusCode >= 200 && locRes.statusCode < 300) {
      final locDecoded = jsonDecode(locRes.body);
      if (locDecoded is List && locDecoded.isNotEmpty) {
        locationId = locDecoded[0]['id']?.toString();
      }
    }
    if (locationId == null || locationId.isEmpty) {
      throw WmsApiException(400, 'Could not resolve location ID');
    }
    final uri = Uri.parse('$base/api/locations/bins');
    final res = await _http.post(
      uri,
      headers: {
        ...await sessionAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: jsonEncode({'code': code, 'locationId': locationId}),
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    return decoded is Map<String, dynamic> ? decoded : {};
  }

  /// `DELETE /api/locations/bins/:id` — archives/deletes a bin completely.
  Future<void> deleteBin(String binId) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/locations/bins/$binId');
    final res = await _http.delete(uri, headers: await sessionAuthHeaders());
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
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

  String get _bodySummary {
    final t = body.trim();
    if (t.startsWith('<!DOCTYPE') || t.startsWith('<!doctype') || t.startsWith('<html')) {
      return 'server returned HTML (often a missing API route or deploy in progress), not JSON';
    }
    if (t.length > 200) return '${t.substring(0, 200)}…';
    return t;
  }

  @override
  String toString() => 'WmsApiException($statusCode): $_bodySummary';
}
