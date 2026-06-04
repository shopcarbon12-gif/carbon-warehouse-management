import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'package:carbon_wms/network/wms_api_client.dart';

/// Lightweight Server-Sent-Events client for the per-location transfer live
/// mirror (`GET /api/operations/transfers/stream`). Hand-rolled over the
/// existing `http` package — `EventSource` can't set the Bearer header, and a
/// streamed `http.Request` can.
///
/// Emits one map per `data:` line. Auto-reconnects with a fixed backoff so a
/// dropped connection (Wi-Fi blip, server redeploy) heals itself. Screens just
/// listen to [events] and refresh their list when a relevant event arrives.
class TransferEventsClient {
  TransferEventsClient(this._api);

  final WmsApiClient _api;

  http.Client? _client;
  StreamSubscription<String>? _sub;
  Timer? _retry;
  bool _closed = false;

  final StreamController<Map<String, dynamic>> _controller =
      StreamController<Map<String, dynamic>>.broadcast();

  Stream<Map<String, dynamic>> get events => _controller.stream;

  Future<void> connect() async {
    if (_closed) return;
    try {
      final base =
          (await _api.resolveBaseUrl()).replaceAll(RegExp(r'/+$'), '');
      final headers = await _api.sessionAuthHeaders();
      final req = http.Request(
        'GET',
        Uri.parse('$base/api/operations/transfers/stream'),
      );
      req.headers.addAll(headers);
      req.headers['Accept'] = 'text/event-stream';
      req.headers['Cache-Control'] = 'no-cache';

      final client = http.Client();
      _client = client;
      final resp = await client.send(req);
      if (resp.statusCode != 200) {
        _scheduleRetry();
        return;
      }
      _sub = resp.stream
          .transform(utf8.decoder)
          .transform(const LineSplitter())
          .listen(
            _onLine,
            onError: (_) => _scheduleRetry(),
            onDone: _scheduleRetry,
            cancelOnError: true,
          );
    } catch (_) {
      _scheduleRetry();
    }
  }

  void _onLine(String line) {
    // SSE comment/heartbeat lines (": ping") and field lines other than data:
    // are ignored.
    if (!line.startsWith('data:')) return;
    final payload = line.substring(5).trim();
    if (payload.isEmpty) return;
    try {
      final decoded = jsonDecode(payload);
      if (decoded is Map<String, dynamic>) _controller.add(decoded);
    } catch (_) {
      /* malformed frame — skip */
    }
  }

  void _scheduleRetry() {
    _teardownConnection();
    if (_closed) return;
    _retry?.cancel();
    _retry = Timer(const Duration(seconds: 5), connect);
  }

  void _teardownConnection() {
    unawaited(_sub?.cancel());
    _sub = null;
    _client?.close();
    _client = null;
  }

  void dispose() {
    _closed = true;
    _retry?.cancel();
    _teardownConnection();
    unawaited(_controller.close());
  }
}
