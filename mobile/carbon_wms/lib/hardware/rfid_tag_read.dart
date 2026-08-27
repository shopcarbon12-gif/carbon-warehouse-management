/// Single tag observation from the RFID sled (EPC + optional RSSI in dBm).
class RfidTagRead {
  const RfidTagRead({
    required this.epcHex24,
    this.rssi,
  });

  /// Uppercase 24-character hex EPC payload.
  final String epcHex24;

  /// Received signal strength (dBm), e.g. -63. Stronger is closer to 0.
  final int? rssi;

  /// Hoisted out of [tryParse]. `RegExp(...)` is a constructor call, so leaving
  /// the literal inline compiled a fresh pattern on EVERY tag read — and with a
  /// Locate-Tag pre-filter the RFD8500 delivers hundreds of reads a second,
  /// through two subscribers. That was hundreds of regex compilations per
  /// second on the UI isolate for a pattern that never changes.
  static final RegExp _nonHex = RegExp(r'[^0-9A-F]');

  static RfidTagRead? tryParse(String raw, {int? rssi}) {
    var u = raw.trim().toUpperCase().replaceAll(_nonHex, '');
    if (u.isEmpty) return null;
    // Pad odd-length hex (e.g. 5-byte EPC stored as 10 nibbles) to even byte boundary.
    if (u.length.isOdd) u = '0$u';

    return RfidTagRead(epcHex24: u, rssi: rssi);
  }
}
