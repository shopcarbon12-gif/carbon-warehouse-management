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

  static RfidTagRead? tryParse(String raw, {int? rssi}) {
    var u = raw.trim().toUpperCase().replaceAll(RegExp(r'[^0-9A-F]'), '');
    if (u.isEmpty) return null;
    // Pad odd-length hex (e.g. 5-byte EPC stored as 10 nibbles) to even byte boundary.
    if (u.length.isOdd) u = '0$u';

    return RfidTagRead(epcHex24: u, rssi: rssi);
  }
}
