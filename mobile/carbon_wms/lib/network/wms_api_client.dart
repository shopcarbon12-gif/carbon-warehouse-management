import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

/// Edge ingest payload to Carbon WMS (`POST /api/edge/ingest`).
class WmsApiClient {
  WmsApiClient({http.Client? httpClient}) : _http = httpClient ?? http.Client();

  static const String _prefsKeyBase = 'wms_server_base';
  static const String _prefsKeyEdge = 'wms_edge_api_key';

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

  void close() => _http.close();
}

class WmsApiException implements Exception {
  WmsApiException(this.statusCode, this.body);
  final int statusCode;
  final String body;

  @override
  String toString() => 'WmsApiException($statusCode): $body';
}
