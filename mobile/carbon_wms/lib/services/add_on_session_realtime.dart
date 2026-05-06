import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:flutter/foundation.dart';

/// Server-Sent Events client for an Add-On Count session.
///
/// Subscribes to `GET /api/handheld/add-on-sessions/<id>/events` and emits
/// parsed event objects. Reconnects automatically on transient errors using
/// the standard SSE Last-Event-ID header so no events are missed.
///
/// Used by:
///   - Owner: receives 'join_requested' → shows approve/decline popup
///   - Joined operator: receives 'join_approved' / 'join_declined'
///   - All: receives 'epc_new' from other devices → suppresses local beep,
///          'signed_out' → updates membership UI, 'completed/cancelled' → exits.
class AddOnSessionRealtime {
  AddOnSessionRealtime({
    required this.api,
    required this.sessionId,
  });

  final WmsApiClient api;
  final String sessionId;

  HttpClient? _http;
  StreamSubscription<List<int>>? _sub;
  bool _closed = false;
  int _lastEventId = 0;

  final _events = StreamController<AddOnRealtimeEvent>.broadcast();
  Stream<AddOnRealtimeEvent> get events => _events.stream;

  Future<void> start() async {
    if (_closed) return;
    final base = await api.resolveBaseUrl();
    final uri = Uri.parse('$base/api/handheld/add-on-sessions/$sessionId/events').replace(
      queryParameters: {'lastEventId': '$_lastEventId'},
    );
    _http = HttpClient()..idleTimeout = const Duration(seconds: 90);
    try {
      final req = await _http!.getUrl(uri);
      req.headers.set('Accept', 'text/event-stream');
      req.headers.set('Cache-Control', 'no-store');
      // Replay any events newer than what we've seen so far.
      if (_lastEventId > 0) {
        req.headers.set('Last-Event-ID', '$_lastEventId');
      }
      final headers = await api.handheldAuthHeaders();
      headers.forEach((k, v) => req.headers.set(k, v));
      final res = await req.close();
      if (res.statusCode != 200) {
        debugPrint('[AddOnSSE] non-200 status ${res.statusCode}, retrying in 3s');
        await Future<void>.delayed(const Duration(seconds: 3));
        if (!_closed) unawaited(start());
        return;
      }
      String buf = '';
      _sub = res.listen(
        (chunk) {
          buf += utf8.decode(chunk, allowMalformed: true);
          while (true) {
            final brk = buf.indexOf('\n\n');
            if (brk < 0) break;
            final raw = buf.substring(0, brk);
            buf = buf.substring(brk + 2);
            _processFrame(raw);
          }
        },
        onError: (Object _) {
          if (!_closed) {
            unawaited(_reconnect());
          }
        },
        onDone: () {
          if (!_closed) {
            unawaited(_reconnect());
          }
        },
        cancelOnError: false,
      );
    } catch (e) {
      debugPrint('[AddOnSSE] connect failed: $e');
      if (!_closed) unawaited(_reconnect());
    }
  }

  Future<void> _reconnect() async {
    await Future<void>.delayed(const Duration(seconds: 2));
    if (_closed) return;
    await _sub?.cancel();
    _sub = null;
    _http?.close(force: true);
    _http = null;
    await start();
  }

  void _processFrame(String frame) {
    String? type;
    String? dataLine;
    int? id;
    for (final line in frame.split('\n')) {
      if (line.startsWith(':')) continue;
      final colon = line.indexOf(':');
      if (colon < 0) continue;
      final field = line.substring(0, colon);
      final value = line.substring(colon + 1).trimLeft();
      if (field == 'event') {
        type = value;
      } else if (field == 'data') {
        dataLine = value;
      } else if (field == 'id') {
        final parsed = int.tryParse(value);
        if (parsed != null) id = parsed;
      }
    }
    final localId = id;
    if (localId != null && localId > _lastEventId) _lastEventId = localId;
    if (type == null || dataLine == null) return;
    Map<String, dynamic>? data;
    try {
      final j = jsonDecode(dataLine);
      if (j is Map<String, dynamic>) data = j;
    } catch (_) {/* ignore malformed */}
    if (data == null) return;
    _events.add(AddOnRealtimeEvent(
      id: id ?? 0,
      type: type,
      userId: data['userId'] as String?,
      deviceId: data['deviceId'] as String?,
      payload: (data['payload'] as Map<String, dynamic>?) ?? <String, dynamic>{},
    ));
  }

  Future<void> dispose() async {
    _closed = true;
    await _sub?.cancel();
    _http?.close(force: true);
    await _events.close();
  }
}

@immutable
class AddOnRealtimeEvent {
  const AddOnRealtimeEvent({
    required this.id,
    required this.type,
    required this.userId,
    required this.deviceId,
    required this.payload,
  });

  final int id;
  final String type;
  final String? userId;
  final String? deviceId;
  final Map<String, dynamic> payload;
}
