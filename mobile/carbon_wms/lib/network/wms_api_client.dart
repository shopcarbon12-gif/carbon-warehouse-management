import 'dart:convert';
import 'dart:io' show File, HttpClient, Platform, exit;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:carbon_wms/services/handheld_device_identity.dart';
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
    final cached = p.getString(_prefsSavedLoginEmail)?.trim();
    if (cached != null && cached.isNotEmpty) return cached;
    // Fallback: pull email out of the active session JWT. Covers handhelds
    // that signed in before the saved-login-email prefs path existed (the
    // Samsung drawer kept rendering "—" / "—" because the cache was never
    // written on the older login). Once we read it here, we backfill the
    // cache so the next launch is a single prefs read again.
    final fromJwt = _emailFromJwt(p.getString(_prefsKeySession));
    if (fromJwt != null && fromJwt.isNotEmpty) {
      await p.setString(_prefsSavedLoginEmail, fromJwt);
      return fromJwt;
    }
    return null;
  }

  /// Decode the email claim from a HS256-signed session JWT without
  /// verifying the signature (signature verification is the server's job;
  /// the mobile only displays the claim). Returns null if the token is
  /// malformed or has no `email` claim.
  String? _emailFromJwt(String? token) {
    if (token == null || token.isEmpty) return null;
    final parts = token.split('.');
    if (parts.length != 3) return null;
    try {
      var payload = parts[1].replaceAll('-', '+').replaceAll('_', '/');
      while (payload.length % 4 != 0) {
        payload = '$payload=';
      }
      final decoded = utf8.decode(base64.decode(payload));
      final json = jsonDecode(decoded);
      if (json is Map<String, dynamic>) {
        final e = json['email'];
        if (e is String && e.trim().isNotEmpty) return e.trim();
      }
    } catch (_) {/* malformed — fall through to null */}
    return null;
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
  /// Returns the stored session JWT, or null if absent/empty/expired.
  ///
  /// Critical: also returns null (and wipes the prefs entry) when the JWT's
  /// `exp` claim is in the past. Without this, a stale token from a prior
  /// install survives the package upgrade (Android keeps SharedPreferences
  /// across reinstalls of the same package name) and the auth gate routes
  /// the operator to the Dashboard because `/api/mobile/status` is a
  /// public endpoint that authorizes by `androidId` — it doesn't actually
  /// verify the Bearer. Every session-gated call on the Dashboard then
  /// rejects 401, surfacing as the "Dashboard: http 401" snackbar cascade
  /// reported on Samsung S938U / Motorola Edge after the 1.2.7x reinstalls.
  Future<String?> getSessionToken() async {
    final p = await SharedPreferences.getInstance();
    final raw = p.getString(_prefsKeySession)?.trim();
    if (raw == null || raw.isEmpty) return null;
    if (_jwtIsExpired(raw)) {
      await p.remove(_prefsKeySession);
      return null;
    }
    return raw;
  }

  /// True when the JWT's `exp` claim is at or before the current wall time.
  /// Malformed/un-parseable tokens are treated as expired so the caller falls
  /// back to a fresh login rather than sending a known-bad Bearer forever.
  /// Signature is the server's responsibility; this is a pure local guard.
  ///
  /// Exposed publicly so the biometric login flow can drop expired vaulted
  /// tokens with the same predicate the boot-time guard uses.
  static bool jwtIsExpired(String token) => _jwtIsExpired(token);

  static bool _jwtIsExpired(String token) {
    final parts = token.split('.');
    if (parts.length != 3) return true;
    try {
      var payload = parts[1].replaceAll('-', '+').replaceAll('_', '/');
      while (payload.length % 4 != 0) {
        payload = '$payload=';
      }
      final json = jsonDecode(utf8.decode(base64.decode(payload)));
      if (json is! Map<String, dynamic>) return true;
      final exp = json['exp'];
      if (exp is! num) return false; // No exp claim — treat as non-expiring.
      final nowS = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      return exp.toInt() <= nowS;
    } catch (_) {
      return true;
    }
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
    final primary = normalizeBaseUrl(await resolveBaseUrl());
    final fallback = lockedServerUrl;
    final tried = <String>{};
    final bases = <String>[
      if (primary.isNotEmpty) primary,
      if (!tried.contains(fallback)) fallback,
    ];
    Object? lastError;
    String? lastFailureMessage;

    for (final rawBase in bases) {
      final base = normalizeBaseUrl(rawBase).replaceAll(RegExp(r'/+$'), '');
      if (base.isEmpty || tried.contains(base)) continue;
      tried.add(base);
      try {
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
          lastFailureMessage = err ?? 'Login failed';
          continue;
        }
        if (decoded is! Map<String, dynamic>) {
          lastFailureMessage = 'Bad response';
          continue;
        }
        final token = decoded['token'] as String?;
        if (token != null && token.isNotEmpty) {
          await setSessionToken(token);
        }
        if (base != primary) {
          await setBaseUrl(base);
        }
        return (
          ok: true,
          bypass: decoded['bypassDeviceLock'] == true,
          error: null,
        );
      } catch (e) {
        lastError = e;
      }
    }

    if (lastFailureMessage != null) {
      return (ok: false, bypass: false, error: lastFailureMessage);
    }
    if (lastError != null) {
      throw lastError;
    }
    return (ok: false, bypass: false, error: 'Login failed');
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

  /// Upload a Count-session report row list to the reports archive (1y
  /// retention). Used as:
  ///   - step 1 of the UPLOAD button pipeline (then [postInventoryUpload]).
  ///   - the best-effort backend leg of SAVE TO FILE after the local CSV
  ///     write succeeds.
  ///
  /// Payload: JSON envelope carrying the session's activity (e.g. `COUNT`,
  /// `TRANSFER`), the session timestamp for filename derivation, the
  /// override-catalog-quantities flag (UPLOAD only — SAVE TO FILE always
  /// passes false), and the row list (epc, system_id, custom_sku, item_name,
  /// color, size, retail_price, bin, seen_count, first_seen_iso,
  /// last_seen_iso).
  ///
  /// Target: `POST /api/reports/count-sessions`. Server stores the CSV and
  /// returns the inserted row metadata (id, filename, uploaded_at, etc.).
  /// 1.2.40 fix: previously this hit `/api/reports/uploads` which doesn't
  /// exist and silently 404'd — every Save/Upload from Count was failing
  /// to archive on the server while still claiming success locally.
  Future<Map<String, dynamic>> uploadCycleCountReport({
    required String activity,
    required DateTime when,
    required List<Map<String, dynamic>> rows,
    required bool overrideCatalog,
  }) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/reports/count-sessions');
    final deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
    final body = jsonEncode({
      'activity': activity,
      'when': when.toUtc().toIso8601String(),
      'overrideCatalog': overrideCatalog,
      'rows': rows,
      'deviceId': deviceId,
    });
    final headers = <String, String>{
      'Content-Type': 'application/json',
      ...await sessionAuthHeaders(),
    };
    final res = await _http.post(uri, headers: headers, body: body);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is Map<String, dynamic>) return decoded;
    return <String, dynamic>{};
  }

  /// Paginated list of count-session reports for the active tenant.
  /// Powers the in-app Reports → Count Reports list. Server returns
  /// `{rows: [{id, activity, uploaded_at, uploaded_by_email, device_id,
  /// override_catalog, row_count, filename, expires_at}], total, page, limit}`.
  Future<Map<String, dynamic>> fetchCountSessionReports({
    int page = 1,
    int limit = 25,
    String? activity,
  }) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
    final uri = Uri.parse('$base/api/reports/count-sessions').replace(
      queryParameters: {
        'page': '$page',
        'limit': '$limit',
        'deviceId': deviceId,
        if (activity != null && activity.isNotEmpty) 'activity': activity,
      },
    );
    final res = await _http.get(uri, headers: await sessionAuthHeaders());
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is Map<String, dynamic>) return decoded;
    return <String, dynamic>{
      'rows': const <Map<String, dynamic>>[],
      'total': 0,
      'page': page,
      'limit': limit,
    };
  }

  Future<Map<String, String>> sessionAuthHeaders() async {
    final t = await getSessionToken();
    final h = <String, String>{};
    if (t != null && t.isNotEmpty) {
      h['Authorization'] = 'Bearer $t';
    }
    return h;
  }

  /// Active locations for the signed-in user (`GET /api/locations`) — returns
  /// [{id, code, name}]. Server response already carries `id`; older
  /// revisions of this method stripped it, which silently broke the
  /// Dashboard location switcher (the bottom-sheet picker only fires
  /// `_applyLocationSwitch` when `id.isNotEmpty`, so taps on a different
  /// location did nothing).
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
        final id = item['id']?.toString() ?? '';
        final code = item['code']?.toString() ?? '';
        final name = item['name']?.toString() ?? code;
        if (code.isNotEmpty) {
          out.add({
            if (id.isNotEmpty) 'id': id,
            'code': code,
            'name': name,
          });
        }
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

  /// Exact variant-level System ID lookup — primary method for EPC resolution.
  /// Hits `GET /api/inventory/catalog?view=grid&systemId=<id>` which does an exact
  /// match on `custom_skus.ls_system_id`. Returns the first matching row or null.
  Future<Map<String, dynamic>?> catalogLookupBySystemId(String systemId) async {
    final sid = systemId.trim();
    if (sid.isEmpty) return null;
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/inventory/catalog').replace(
      queryParameters: {
        'view': 'grid',
        'page': '1',
        'limit': '1',
        'systemId': sid,
      },
    );
    final res = await _http.get(uri, headers: await sessionAuthHeaders());
    if (res.statusCode < 200 || res.statusCode >= 300) return null;
    final decoded = jsonDecode(res.body);
    if (decoded is! Map<String, dynamic>) return null;
    final rows = decoded['rows'];
    if (rows is! List || rows.isEmpty) return null;
    final first = rows.first;
    if (first is Map<String, dynamic>) return first;
    return null;
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

  /// Paged catalog grid for the live `/inventory/catalog` mirror screen.
  /// Returns the raw `{rows, total, brands, categories, vendors}` envelope so
  /// the caller can drive infinite-scroll without losing pagination metadata.
  /// Server scopes by `session.lid`, so the rows are always location-correct.
  Future<Map<String, dynamic>> fetchCatalogGrid({
    String q = '',
    int page = 1,
    int limit = 200,
  }) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/inventory/catalog').replace(
      queryParameters: {
        'view': 'grid',
        'page': '$page',
        'limit': '$limit',
        if (q.trim().isNotEmpty) 'q': q.trim(),
      },
    );
    final res = await _http.get(uri, headers: await sessionAuthHeaders());
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is! Map<String, dynamic>) {
      return {'rows': const <Map<String, dynamic>>[], 'total': 0};
    }
    return decoded;
  }

  /// EPC-level rows for one custom SKU at the active location.
  /// `GET /api/inventory/catalog?customSkuId=<uuid>` —
  /// each entry: `{serial_number, epc, status, bin_code, last_seen_at, sku, name, color, size}`.
  Future<List<Map<String, dynamic>>> fetchCatalogEpcs(String customSkuId) async {
    final id = customSkuId.trim();
    if (id.isEmpty) return [];
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/inventory/catalog').replace(
      queryParameters: {'customSkuId': id},
    );
    final res = await _http.get(uri, headers: await sessionAuthHeaders());
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is! List) return [];
    return decoded.whereType<Map<String, dynamic>>().toList();
  }

  /// Multi-result catalog search across all fields (name, UPC, SKU, asset ID).
  /// Returns up to [limit] rows from `/api/inventory/catalog?view=grid`.
  Future<List<Map<String, dynamic>>> catalogSearch(String q, {int limit = 10}) async {
    final qt = q.trim();
    if (qt.length < 3) return [];
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/inventory/catalog').replace(
      queryParameters: {
        'view': 'grid',
        'page': '1',
        'limit': '$limit',
        'q': qt,
      },
    );
    final res = await _http.get(uri, headers: await sessionAuthHeaders());
    if (res.statusCode < 200 || res.statusCode >= 300) return [];
    final decoded = jsonDecode(res.body);
    if (decoded is! Map<String, dynamic>) return [];
    final rows = decoded['rows'];
    if (rows is! List) return [];
    return rows.whereType<Map<String, dynamic>>().toList();
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

  /// Returns every custom SKU under a matrix at the active location, with
  /// `color_code`, `size`, and `epc_count`. Used by the Bin Assign multi-
  /// colour picker to enumerate the colours available for "same product
  /// different colour" assignment.
  Future<List<Map<String, dynamic>>> fetchCustomSkusByMatrix(String matrixId) async {
    final id = matrixId.trim();
    if (id.isEmpty) return [];
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/inventory/catalog').replace(
      queryParameters: {'matrixId': id},
    );
    final res = await _http.get(uri, headers: await sessionAuthHeaders());
    if (res.statusCode < 200 || res.statusCode >= 300) return [];
    final decoded = jsonDecode(res.body);
    if (decoded is! List) return [];
    return decoded.whereType<Map<String, dynamic>>().toList();
  }

  /// `mode`:
  ///   - `'homeless_only'` (default) — server only moves items whose
  ///     `bin_id IS NULL`. Leaves items already in another bin alone.
  ///   - `'all'` — server moves every matching item regardless of where it
  ///     currently lives. Used by the Bin Assign "MOVE ALL HERE" choice.
  Future<Map<String, dynamic>> postPutawayAssign({
    required String deviceId,
    required String binCode,
    required String skuScanned,
    required String scope,
    String mode = 'homeless_only',
  }) async {
    final base = await resolveBaseUrl();
    final uri = Uri.parse('$base/api/inventory/putaway-assign');
    final body = jsonEncode({
      'deviceId': deviceId,
      'binCode': binCode,
      'skuScanned': skuScanned,
      'scope': scope,
      'mode': mode,
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

  /// Looks up — without moving anything — how items matching `skuScanned`
  /// are distributed across the location: homeless (`bin_id IS NULL`),
  /// already in this bin, or in some other bin. Drives the multi-bin
  /// resolution prompt on the Bin Assign screen.
  ///
  /// Response shape:
  ///   `{ ok, homeless, inThisBin, inOtherBins: [{binCode, qty}], totalMatching }`
  Future<Map<String, dynamic>> previewPutawayAssign({
    required String deviceId,
    required String binCode,
    required String skuScanned,
    required String scope,
  }) async {
    final base = await resolveBaseUrl();
    final uri = Uri.parse('$base/api/inventory/putaway-preview');
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

  // --- Operations / Transfers (in flow on mobile) -----------------------
  // Server endpoints live under /api/operations/transfers/*. The mobile
  // Transfer In screen pulls pending slips for the operator's location,
  // opens one to view its expected EPCs, scans against it, and commits.

  /// `GET /api/operations/transfers/pending` — slips with state in-transit
  /// or partially_received whose destination is the operator's location.
  /// Returns a list of `{id, slip_number, source_location_*, rfid_pending,
  /// manual_pending, created_at, ...}` rows.
  Future<List<Map<String, dynamic>>> fetchPendingIncomingTransfers() async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/operations/transfers/pending');
    final res = await _http.get(uri, headers: await sessionAuthHeaders());
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is Map<String, dynamic>) {
      final rows = decoded['rows'];
      if (rows is List) {
        return rows
            .whereType<Map>()
            .map((r) => Map<String, dynamic>.from(r))
            .toList(growable: false);
      }
    }
    return const <Map<String, dynamic>>[];
  }

  /// `GET /api/operations/transfers/<uuid>` — full RFID + manual contents
  /// of a single slip, including which EPCs are still in-transit (received
  /// flag false) vs already received (true).
  Future<Map<String, dynamic>> fetchTransferDetail(String transferId) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/operations/transfers/$transferId');
    final res = await _http.get(uri, headers: await sessionAuthHeaders());
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is Map<String, dynamic>) return decoded;
    return <String, dynamic>{};
  }

  /// `POST /api/operations/transfers/receive` — flip RFID items to in-stock
  /// and settle named manual destination-side adjustments. Returns
  /// `{ok, transferId, rfidReceived, manualReceived, state}`. The new
  /// state is `received` if everything matched, `partially_received`
  /// otherwise.
  Future<Map<String, dynamic>> commitTransferReceive({
    required String transferId,
    required List<String> epcs,
    List<String> manualAdjustmentIds = const [],
  }) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/operations/transfers/receive');
    final body = <String, dynamic>{
      'transferId': transferId,
      'epcs': epcs,
      if (manualAdjustmentIds.isNotEmpty)
        'manualConfirms':
            manualAdjustmentIds.map((id) => {'adjustmentId': id}).toList(),
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

  /// `POST /api/rfid/encode-finalize` — Phase 3 post-write confirmation.
  /// Call this AFTER `RfidVendorChannel.writeEpcTag` returns true. The
  /// server promotes the new EPC from 'unknown' → 'in-stock' (LIVE) and
  /// dismisses the old EPC's row from the Defective EPCs modal (sets
  /// `defective_acknowledged_at = now()` — same dismiss mechanism the
  /// desktop button uses).
  ///
  /// Returns `{ ok, livePromoted, defectiveDismissed }`. Best-effort —
  /// the chip write already succeeded by the time we get here, so a
  /// finalize failure is a soft warning, not a flow-blocking error.
  Future<Map<String, dynamic>?> postEncodeFinalize({
    required String newEpc,
    String? oldEpc,
  }) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/rfid/encode-finalize');
    final body = jsonEncode({
      'newEpc': newEpc.toUpperCase(),
      if (oldEpc != null && oldEpc.isNotEmpty) 'oldEpc': oldEpc.toUpperCase(),
    });
    final res = await _http.post(
      uri,
      headers: {
        ...await sessionAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: body,
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is Map<String, dynamic>) return decoded;
    return null;
  }

  /// `GET /api/handheld/encode-events` — re-encode reports list for the
  /// mobile Inventory → Reports → RE-ENCODE tile. Returns the active
  /// session location's recent encode_events rows (newest first).
  /// Best-effort empty list on failure so the screen can degrade
  /// gracefully — handheld already prefers fail-open UX.
  Future<List<Map<String, dynamic>>> fetchEncodeEvents({
    int limit = 200,
    String? status,
  }) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
    final uri = Uri.parse('$base/api/handheld/encode-events').replace(
      queryParameters: <String, String>{
        'deviceId': deviceId,
        'limit': '$limit',
        if (status != null && status.isNotEmpty) 'status': status,
      },
    );
    final res = await _http.get(uri, headers: await handheldAuthHeaders());
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is! Map<String, dynamic>) return const [];
    final rows = decoded['rows'];
    if (rows is! List) return const [];
    return rows.whereType<Map<String, dynamic>>().toList();
  }

  /// `GET /api/mobile/permissions` — Phase 2 mobile RBAC payload. Returns
  /// the operator's mobile role, the flat `hiddenScreens` allow-list, and
  /// the nested `permissions` map. Authenticated with the same session JWT
  /// every other `/api/*` call uses (no new auth flow).
  ///
  /// Returns null on a transient parse failure so [MobilePermissions] can
  /// fall back to its cached value without nuking it. Non-2xx responses
  /// throw [WmsApiException] so the caller can log the HTTP code.
  Future<Map<String, dynamic>?> fetchMobilePermissions() async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/mobile/permissions');
    final res = await _http.get(uri, headers: await sessionAuthHeaders());
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is Map<String, dynamic>) return decoded;
    return null;
  }

  /// `GET /api/scanner/status-labels` — operator-visible status labels for
  /// the handheld Status Change screen. Each row carries `applicable`
  /// indicating whether the requesting user can pick it (super-admin gets
  /// all rows; managers exclude system-only / super-admin-locked).
  ///
  /// Returns `{rows: List, super_admin: bool}`.
  Future<Map<String, dynamic>> fetchScannerStatusLabels() async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/scanner/status-labels');
    final res = await _http.get(uri, headers: await sessionAuthHeaders());
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is Map<String, dynamic>) return decoded;
    return <String, dynamic>{'rows': <dynamic>[], 'super_admin': false};
  }

  /// Look up an EPC's catalog row + current item state for the active
  /// location. Used by the Status Change screen when a UHF read should
  /// jump straight from the scanner over the search step. Returns null
  /// when the EPC isn't present at this location.
  Future<Map<String, dynamic>?> lookupCatalogByEpc(String epc) async {
    final e = epc.trim();
    if (e.isEmpty) return null;
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/inventory/catalog').replace(
      queryParameters: {
        'view': 'grid',
        'page': '1',
        'limit': '1',
        'q': e,
      },
    );
    final res = await _http.get(uri, headers: await sessionAuthHeaders());
    if (res.statusCode < 200 || res.statusCode >= 300) return null;
    final decoded = jsonDecode(res.body);
    if (decoded is Map<String, dynamic>) {
      final rows = decoded['rows'];
      if (rows is List && rows.isNotEmpty && rows.first is Map<String, dynamic>) {
        return rows.first as Map<String, dynamic>;
      }
    }
    return null;
  }

  /// Switch the active session location for the current user. Server mints
  /// a new JWT scoped to [locationId]; we save it in prefs so subsequent
  /// API calls (catalog, count, etc.) reflect the new location.
  /// Returns true on success, false on rejection (invalid location for
  /// this tenant or user).
  Future<bool> switchSessionLocation(String locationId) async {
    final id = locationId.trim();
    if (id.isEmpty) return false;
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/session/location');
    final res = await _http.post(
      uri,
      headers: {
        ...await sessionAuthHeaders(),
        'Content-Type': 'application/json',
        'X-Carbon-Mobile': '1',
      },
      body: jsonEncode({'locationId': id}),
    );
    if (res.statusCode < 200 || res.statusCode >= 300) return false;
    try {
      final decoded = jsonDecode(res.body);
      if (decoded is Map<String, dynamic>) {
        final token = decoded['token'] as String?;
        if (token != null && token.isNotEmpty) {
          await setSessionToken(token);
        }
      }
    } catch (_) {
      return false;
    }
    return true;
  }

  /// `POST /api/rfid/encode-resolve` — what does WMS know about this EPC?
  /// Returns `{ok, status: 'known'|'valid_orphan'|'foreign', epc, decoded?,
  /// item?}`. Used by the handheld Encode screen during the brief read
  /// half of the trigger pull, so the operator sees the tag's current
  /// SKU/state before we overwrite it.
  Future<Map<String, dynamic>> postEncodeResolve(String epc) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/rfid/encode-resolve');
    final res = await _http.post(
      uri,
      headers: {
        ...await sessionAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: jsonEncode({'epc': epc.trim().toUpperCase()}),
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is Map<String, dynamic>) return decoded;
    return <String, dynamic>{};
  }

  /// `POST /api/rfid/encode-claim` — atomic "next serial + insert items
  /// row + return the new EPC". Server-side computes `MAX(serial)+1` for
  /// the SKU/location with a 100,001 floor for fresh SKUs and signs the
  /// new EPC for the handheld to write to the chip. Optional `oldEpc`
  /// gets marked `tag_killed` server-side.
  ///
  /// Returns `{ok, epc, serial, system_id}` on success.
  Future<Map<String, dynamic>> postEncodeClaim({
    required String customSkuId,
    String? oldEpc,
  }) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/rfid/encode-claim');
    final body = <String, dynamic>{'customSkuId': customSkuId.trim()};
    if (oldEpc != null && oldEpc.trim().isNotEmpty) {
      body['oldEpc'] = oldEpc.trim().toUpperCase();
    }
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
        // Tells the server to skip its own outbound POST to the printer
        // — that POST hangs until timeout when the WMS runs in Coolify
        // (Hetzner egress can't reach the warehouse-LAN printer at
        // 192.168.1.3). Server still mints serials + inserts items rows
        // and returns the rendered ZPL; the handheld then sends the ZPL
        // directly to the printer over TCP (it IS on the same LAN).
        'X-Carbon-Mobile': '1',
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
  ///
  /// Pre-1.2.42 swallowed every error and returned `{}`, which surfaced as
  /// dash placeholders on the dashboard with no clue why. Now returns
  /// `{__error: 'reason'}` on failure so the screen can show the operator
  /// a "tap to retry" affordance + log the actual reason. Successful
  /// responses don't carry `__error`.
  Future<Map<String, dynamic>> fetchDashboardStats() async {
    try {
      final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
      final uri = Uri.parse('$base/api/dashboard/summary');
      final headers = await sessionAuthHeaders();
      final hasAuth = headers.containsKey('Authorization');
      final res = await _http.get(uri, headers: headers);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return {'__error': 'http ${res.statusCode}${hasAuth ? '' : ' (no auth header)'}'};
      }
      final decoded = jsonDecode(res.body);
      if (decoded is Map<String, dynamic>) return decoded;
      return {'__error': 'bad shape'};
    } catch (e) {
      return {'__error': '$e'};
    }
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

  // ── Re-encode module (Search and Encode) ────────────────────────────────
  // Spec: /api/v1/catalog/items, /api/v1/rfid/serial/next, /api/v1/rfid/encode-events.

  /// Exact lookup by Custom SKU. Returns `null` on 404 / empty result.
  /// Response shape: { id, system_id, name, custom_sku, sku }
  Future<Map<String, dynamic>?> catalogItemByCustomSku(String customSku) async {
    final q = customSku.trim();
    if (q.isEmpty) return null;
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/v1/catalog/items').replace(
      queryParameters: {'custom_sku': q},
    );
    final res = await _http.get(uri, headers: await sessionAuthHeaders());
    if (res.statusCode == 404) return null;
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is! Map<String, dynamic>) return null;
    if (decoded.isEmpty) return null;
    if (decoded['error'] != null) return null;
    return decoded;
  }

  /// Next per-warehouse serial counter for re-encoded tags.
  Future<int> nextRfidSerial({required String warehouseId}) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/v1/rfid/serial/next');
    final res = await _http.post(
      uri,
      headers: {
        ...await sessionAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: jsonEncode({'warehouse_id': warehouseId}),
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is! Map<String, dynamic>) {
      throw WmsApiException(500, 'serial/next: bad response');
    }
    final v = decoded['serial'];
    if (v is int) return v;
    if (v is num) return v.toInt();
    if (v is String) {
      final parsed = int.tryParse(v);
      if (parsed != null) return parsed;
    }
    throw WmsApiException(500, 'serial/next: missing serial');
  }

  /// Record an encoding event (success, not_found, or tag write failure).
  Future<void> postRfidEncodeEvent({
    required String oldEpc,
    String? newEpc,
    int? systemId,
    int? serial,
    required String customSku,
    required String warehouseId,
    required String deviceId,
    String? status,
  }) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/v1/rfid/encode-events');
    final body = <String, dynamic>{
      'old_epc': oldEpc,
      if (newEpc != null) 'new_epc': newEpc,
      if (systemId != null) 'system_id': systemId,
      if (serial != null) 'serial': serial,
      'custom_sku': customSku,
      'warehouse_id': warehouseId,
      'device_id': deviceId,
      'encoded_at': DateTime.now().toUtc().toIso8601String(),
      if (status != null && status.isNotEmpty) 'status': status,
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

  /// Dismiss one or more EPCs from this handheld's Cloud + Geiger queue.
  /// Called when the operator slide-deletes a row OR when a Take-an-
  /// Action flow resolves the EPC (re-encode success on the same chip,
  /// etc.). Server marks the row `consumed` so subsequent polls no
  /// longer return it. Idempotent (already-consumed → dismissed=0).
  Future<int> dismissEpcQueueItems({
    required String deviceId,
    required List<String> epcs,
  }) async {
    final cleaned = epcs
        .map((e) => e.trim().toUpperCase())
        .where((e) => e.isNotEmpty)
        .toList(growable: false);
    if (cleaned.isEmpty) return 0;
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/handheld/epc-queue');
    final body = jsonEncode({'deviceId': deviceId, 'epcs': cleaned});
    final headers = <String, String>{
      ...await handheldAuthHeaders(),
      'Content-Type': 'application/json',
      'x-wms-device-id': deviceId,
    };
    final res = await _http.post(uri, headers: headers, body: body);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is Map<String, dynamic>) {
      return (decoded['dismissed'] as num?)?.toInt() ?? 0;
    }
    return 0;
  }

  /// Mobile poller for this handheld's EPC drop queue (Cloud + Geiger).
  /// Read-only since 2026-05-29 — server keeps every queued EPC until
  /// it's explicitly dismissed via `dismissEpcQueueItems`, so each poll
  /// returns the full pending set (operator's working list survives
  /// app relaunches and shift handovers). Returns `{ deviceUuid,
  /// epcs, count }`.
  Future<({String deviceUuid, List<String> epcs, int count})>
      pollMyEpcQueue({required String deviceId}) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/handheld/epc-queue');
    final headers = <String, String>{
      ...await handheldAuthHeaders(),
      'x-wms-device-id': deviceId,
    };
    final res = await _http.get(uri, headers: headers);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is Map<String, dynamic>) {
      final epcsRaw = decoded['epcs'];
      final epcs = epcsRaw is List ? epcsRaw.cast<String>() : <String>[];
      return (
        deviceUuid: decoded['deviceUuid'] as String? ?? '',
        epcs: epcs,
        count: decoded['count'] as int? ?? epcs.length,
      );
    }
    return (deviceUuid: '', epcs: <String>[], count: 0);
  }

  /* ---------- Add-On Count + scan-finalize (v1) ---------- */

  Future<List<Map<String, dynamic>>> listScanSources({
    bool includeCompleted = false,
    int limit = 100,
  }) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
    final uri = Uri.parse('$base/api/handheld/scan-sources').replace(
      queryParameters: <String, String>{
        'deviceId': deviceId,
        if (includeCompleted) 'includeCompleted': '1',
        'limit': '$limit',
      },
    );
    final res = await _http.get(uri, headers: await handheldAuthHeaders());
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is! Map<String, dynamic>) return const [];
    final rows = decoded['rows'];
    if (rows is! List) return const [];
    return rows.whereType<Map<String, dynamic>>().toList();
  }

  Future<List<String>> getScanSourceEpcs({
    required String sourceType,
    required String sourceId,
  }) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
    final uri = Uri.parse('$base/api/handheld/scan-sources/$sourceId/epcs').replace(
      queryParameters: <String, String>{
        'type': sourceType,
        'deviceId': deviceId,
      },
    );
    final res = await _http.get(uri, headers: await handheldAuthHeaders());
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is! Map<String, dynamic>) return const [];
    final epcs = decoded['epcs'];
    if (epcs is! List) return const [];
    return epcs.whereType<String>().map((e) => e.toUpperCase()).toList();
  }

  Future<Map<String, dynamic>> startAddOnSession({
    required String sourceType,
    required String sourceId,
    required String sourceSlip,
  }) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
    final uri = Uri.parse('$base/api/handheld/add-on-sessions');
    final body = jsonEncode({
      'sourceType': sourceType,
      'sourceId': sourceId,
      'sourceSlip': sourceSlip,
      'deviceId': deviceId,
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
    return decoded is Map<String, dynamic> ? decoded : <String, dynamic>{};
  }

  Future<Map<String, dynamic>> getAddOnSession(String sessionId) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
    final uri = Uri.parse('$base/api/handheld/add-on-sessions/$sessionId').replace(
      queryParameters: {'deviceId': deviceId},
    );
    final res = await _http.get(uri, headers: await handheldAuthHeaders());
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    return decoded is Map<String, dynamic> ? decoded : <String, dynamic>{};
  }

  Future<void> touchAddOnSession(String sessionId) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
    final uri = Uri.parse('$base/api/handheld/add-on-sessions/$sessionId').replace(
      queryParameters: {'op': 'touch', 'deviceId': deviceId},
    );
    final res = await _http.post(uri, headers: await handheldAuthHeaders());
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
  }

  Future<Map<String, dynamic>> signoutAddOnSession(String sessionId) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
    final uri = Uri.parse('$base/api/handheld/add-on-sessions/$sessionId').replace(
      queryParameters: {'op': 'signout', 'deviceId': deviceId},
    );
    final res = await _http.post(uri, headers: await handheldAuthHeaders());
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    return decoded is Map<String, dynamic> ? decoded : <String, dynamic>{};
  }

  /// Submit one EPC read to the session. Server dedupes against the in-source
  /// list (passed as [inSource]) and the cross-device session ledger; outcome
  /// is 'new', 'duplicate', or 'failed'.
  Future<Map<String, dynamic>> submitAddOnSessionEpc({
    required String sessionId,
    required String epc,
    bool inSource = false,
    bool validationFailed = false,
    String? failureReason,
  }) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
    final uri = Uri.parse('$base/api/handheld/add-on-sessions/$sessionId/epc');
    final body = jsonEncode({
      'epc': epc,
      'inSource': inSource,
      'validationFailed': validationFailed,
      if (failureReason != null) 'failureReason': failureReason,
      'deviceId': deviceId,
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
    return decoded is Map<String, dynamic> ? decoded : <String, dynamic>{};
  }

  Future<Map<String, dynamic>> requestJoinAddOnSession(String sessionId) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
    final uri = Uri.parse('$base/api/handheld/add-on-sessions/$sessionId/join-request');
    final body = jsonEncode({'kind': 'request', 'deviceId': deviceId});
    final headers = <String, String>{
      'Content-Type': 'application/json',
      ...await handheldAuthHeaders(),
    };
    final res = await _http.post(uri, headers: headers, body: body);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    return decoded is Map<String, dynamic> ? decoded : <String, dynamic>{};
  }

  /// Re-open a completed Add-On session so the operator can keep scanning.
  /// Server gates this on super-admin role. Returns the updated session row
  /// on success (`{id, state, source_type, source_id, source_slip}`).
  /// Throws [WmsApiException(403, …)] when the logged-in user isn't super
  /// admin — callers should surface that as an "only super admin can
  /// re-open" message rather than retrying.
  ///
  /// Uses the *session* bearer (not handheld API key) because the role
  /// check needs a real user identity.
  Future<Map<String, dynamic>> reopenAddOnSession(String sessionId) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/api/handheld/add-on-sessions/$sessionId/reopen');
    final headers = <String, String>{
      'Content-Type': 'application/json',
      ...await sessionAuthHeaders(),
    };
    final res = await _http.post(uri, headers: headers, body: '{}');
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    return decoded is Map<String, dynamic> ? decoded : <String, dynamic>{};
  }

  Future<Map<String, dynamic>> respondJoinAddOnSession({
    required String sessionId,
    required bool approve,
    String? requesterUserId,
    String? requesterDeviceId,
  }) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
    final uri = Uri.parse('$base/api/handheld/add-on-sessions/$sessionId/join-request');
    final body = jsonEncode({
      'kind': 'respond',
      'approve': approve,
      if (requesterUserId != null) 'requesterUserId': requesterUserId,
      if (requesterDeviceId != null) 'requesterDeviceId': requesterDeviceId,
      'deviceId': deviceId,
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
    return decoded is Map<String, dynamic> ? decoded : <String, dynamic>{};
  }

  /// Bulk EPC → product info enrichment for handheld screens. Used by
  /// Add-On Count to populate review-row labels (sku/name/color/size).
  Future<List<Map<String, dynamic>>> lookupEpcs(List<String> epcs) async {
    if (epcs.isEmpty) return const [];
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
    final uri = Uri.parse('$base/api/handheld/epc-lookup');
    final body = jsonEncode({'epcs': epcs, 'deviceId': deviceId});
    final headers = <String, String>{
      'Content-Type': 'application/json',
      ...await handheldAuthHeaders(),
    };
    final res = await _http.post(uri, headers: headers, body: body);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw WmsApiException(res.statusCode, res.body);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is! Map<String, dynamic>) return const [];
    final rows = decoded['rows'];
    if (rows is! List) return const [];
    return rows.whereType<Map<String, dynamic>>().toList();
  }

  /// Unified SAVE/UPLOAD finalisation. [intent] is 'save' or 'upload';
  /// [screen] is 'count_inventory' / 'count_inventory_override' / 'add_on_count'.
  /// [clientFilename] when non-null overrides the server's auto-named CSV
  /// filename — used by the count screen so the operator-visible name on
  /// the web reports page matches what the operator saw at commit time
  /// (`count-MMDD-HMM-FirstName.csv`).
  Future<Map<String, dynamic>> postScanFinalize({
    required String intent,
    required String screen,
    required List<Map<String, dynamic>> rows,
    bool overrideCatalog = false,
    String? addOnSourceType,
    String? addOnSourceId,
    String? addOnSessionId,
    String? clientFilename,
  }) async {
    final base = (await resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
    final deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
    final uri = Uri.parse('$base/api/handheld/scan-finalize');
    final body = jsonEncode({
      'intent': intent,
      'screen': screen,
      'overrideCatalog': overrideCatalog,
      'rows': rows,
      'deviceId': deviceId,
      if (addOnSourceType != null) 'addOnSourceType': addOnSourceType,
      if (addOnSourceId != null) 'addOnSourceId': addOnSourceId,
      if (addOnSessionId != null) 'addOnSessionId': addOnSessionId,
      if (clientFilename != null && clientFilename.isNotEmpty)
        'clientFilename': clientFilename,
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
    return decoded is Map<String, dynamic> ? decoded : <String, dynamic>{};
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
