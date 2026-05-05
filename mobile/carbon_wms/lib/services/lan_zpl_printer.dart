import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// LAN-direct ZPL print from the handheld.
///
/// Used by Print + Encode flows when the cloud WMS can't reach the
/// warehouse-LAN printer (typical Coolify deployment). The handheld is
/// on the same LAN as the printer and can talk to it directly.
///
/// Two transports:
///
///   • **HTTP POST** (`port 80, uri "PSTPRNT"`) — Zebra ZD500R-class
///     printers expose ZPL over HTTP at `http://<host>/<uri>`. ZPL goes
///     in the request body; printer commits on 200 OK. This is the same
///     transport the server-side `rfid-commission` print path uses.
///   • **Raw TCP** (`port 9100`) — Zebra "JetDirect" raw ZPL socket.
///     Connect, write the bytes, close. Some installs disable 9100 in
///     favor of 80/PSTPRNT only.
///
/// 1.2.47 hardcoded raw TCP/9100. The user's printer has 9100 disabled
/// and only listens on 80/PSTPRNT (curl test confirmed), so prints
/// claimed success at the socket layer but nothing came out. 1.2.48
/// supports both transports and routes by `printer_port` returned from
/// the server.
///
/// Returns null on success, or a short reason string on failure
/// (timeout, connection refused, IO error, non-2xx HTTP). Never throws.
class LanZplPrinter {
  static const Duration _connectTimeout = Duration(seconds: 6);
  static const Duration _writeTimeout = Duration(seconds: 12);

  /// Send raw ZPL bytes to a printer.
  ///
  /// Picks the transport from [port]:
  ///   * 9100 → raw TCP / JetDirect.
  ///   * anything else (default 80) → HTTP POST to `http://host:port/uri`.
  ///
  /// [uri] is the path component for the HTTP transport (default
  /// `PSTPRNT`, matching Zebra's stock setup). Ignored for raw TCP.
  static Future<String?> send({
    required String host,
    int port = 80,
    String uri = 'PSTPRNT',
    required String zpl,
  }) async {
    if (zpl.trim().isEmpty) return 'empty zpl';
    if (port == 9100) {
      return _sendRawTcp(host: host, port: port, zpl: zpl);
    }
    return _sendHttp(host: host, port: port, uri: uri, zpl: zpl);
  }

  static Future<String?> _sendHttp({
    required String host,
    required int port,
    required String uri,
    required String zpl,
  }) async {
    HttpClient? client;
    try {
      client = HttpClient()..connectionTimeout = _connectTimeout;
      // Many Zebra firmwares expose self-signed or no-cert HTTP — disable
      // strict certificate validation so HTTPS-by-default doesn't blow
      // up. Plain http:// is what we use anyway.
      client.badCertificateCallback = (_, __, ___) => true;
      // Zebra ZD500R web-print is case-sensitive: /pstprnt returns 200,
      // /PSTPRNT returns 404. Most of the codebase carries the URI as
      // "PSTPRNT" — lowercase here so the existing data model doesn't
      // need a migration.
      final cleanUri = uri.toLowerCase().replaceAll(RegExp(r'^/+'), '');
      final url = Uri.parse('http://$host:$port/$cleanUri');
      final req = await client.postUrl(url).timeout(_connectTimeout);
      // Zebra firmware accepts plain text; setting a content-type isn't
      // strictly necessary but stops some proxies from rewriting.
      req.headers.set(HttpHeaders.contentTypeHeader, 'application/x-zpl');
      req.add(utf8.encode(zpl));
      final res = await req.close().timeout(_writeTimeout);
      // Drain the body so the connection releases cleanly.
      await res.drain<void>();
      if (res.statusCode >= 200 && res.statusCode < 300) {
        return null;
      }
      return 'http ${res.statusCode}';
    } on SocketException catch (e) {
      return 'tcp ${e.osError?.message ?? e.message}';
    } on TimeoutException {
      return 'timeout';
    } catch (e) {
      return '$e';
    } finally {
      try {
        client?.close(force: true);
      } catch (_) {/* best-effort */}
    }
  }

  static Future<String?> _sendRawTcp({
    required String host,
    required int port,
    required String zpl,
  }) async {
    Socket? socket;
    try {
      socket = await Socket.connect(host, port, timeout: _connectTimeout);
      socket.add(utf8.encode(zpl));
      await socket.flush().timeout(_writeTimeout);
      // Most Zebra firmware doesn't echo back on raw 9100 — closing is
      // enough to commit the print. Wait briefly to make sure flush
      // completes, then destroy to release the FD.
      await Future<void>.delayed(const Duration(milliseconds: 50));
      await socket.close();
      return null;
    } on SocketException catch (e) {
      return 'tcp ${e.osError?.message ?? e.message}';
    } on TimeoutException {
      return 'timeout';
    } catch (e) {
      return '$e';
    } finally {
      try {
        socket?.destroy();
      } catch (_) {/* best-effort */}
    }
  }
}
