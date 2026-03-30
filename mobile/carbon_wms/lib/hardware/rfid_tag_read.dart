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
    final u = raw.trim().toUpperCase();
    if (u.length != 24) return null;
    if (!RegExp(r'^[0-9A-F]{24}$').hasMatch(u)) return null;
    return RfidTagRead(epcHex24: u, rssi: rssi);
  }
}
