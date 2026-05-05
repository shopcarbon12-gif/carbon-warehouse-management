import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// LAN-direct ZPL print over raw TCP.
///
/// Used by the handheld Print + Encode flows when the cloud WMS can't
/// reach the warehouse-LAN printer (typical Coolify deployment). The
/// handheld is on the same LAN as the printer and can send bytes
/// directly. Zebra ZD500R-class printers listen on TCP/9100 (raw ZPL
/// "JetDirect" port) — we connect, blast the ZPL, close.
///
/// Returns null on success, or a short reason string on failure
/// (timeout, connection refused, IO error). Never throws — the
/// handheld surfaces the reason via the same SnackBar / sound channel
/// the rest of the print flow uses.
class LanZplPrinter {
  static const Duration _connectTimeout = Duration(seconds: 6);
  static const Duration _writeTimeout = Duration(seconds: 12);

  /// Send raw ZPL bytes to [host]:[port] (default port 9100). Returns
  /// `null` on success, otherwise a short error reason.
  static Future<String?> send({
    required String host,
    int port = 9100,
    required String zpl,
  }) async {
    if (zpl.trim().isEmpty) return 'empty zpl';
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
