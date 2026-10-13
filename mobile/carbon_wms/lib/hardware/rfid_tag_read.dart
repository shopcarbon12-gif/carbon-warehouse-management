/// Single tag observation from the RFID sled (EPC + optional RSSI in dBm).
class RfidTagRead {
  const RfidTagRead({
    required this.epcHex24,
    this.rssi,
    this.generation,
    this.nativeMs,
    this.relativeProximity,
    this.raw,
  });

  /// Uppercase 24-character hex EPC payload.
  final String epcHex24;

  /// Received signal strength (dBm), e.g. -63. Stronger is closer to 0.
  final int? rssi;

  // ── Locate 2.0 measurement fields (Zebra controller; null elsewhere) ──

  /// Native read generation: bumps on every acknowledged power change and
  /// native-locate start, so reads taken under old settings can be dropped.
  final int? generation;

  /// Native monotonic receipt time (Android elapsedRealtime, ms).
  final int? nativeMs;

  /// Zebra TagLocationing relative proximity 0-100 (NOT a distance).
  final int? relativeProximity;

  /// Raw tag id as the SDK reported it, sent ONLY when it was not a clean
  /// 24-hex EPC. Locate treats such reads as identity/format errors.
  final String? raw;

  /// Exact canonical 96-bit EPC, or null when this read's identity is not a
  /// clean 24-hex-digit EPC (no padding, no stripping, no suffix guessing).
  String? get exactEpc96 =>
      raw == null && _epc96.hasMatch(epcHex24) ? epcHex24 : null;

  static final RegExp _epc96 = RegExp(r'^[0-9A-F]{24}$');

  /// Hoisted out of [tryParse]. `RegExp(...)` is a constructor call, so leaving
  /// the literal inline compiled a fresh pattern on EVERY tag read — and with a
  /// Locate-Tag pre-filter the RFD8500 delivers hundreds of reads a second,
  /// through two subscribers. That was hundreds of regex compilations per
  /// second on the UI isolate for a pattern that never changes.
  static final RegExp _nonHex = RegExp(r'[^0-9A-F]');

  static RfidTagRead? tryParse(
    String raw, {
    int? rssi,
    int? generation,
    int? nativeMs,
    int? relativeProximity,
    String? rawReported,
  }) {
    var u = raw.trim().toUpperCase().replaceAll(_nonHex, '');
    if (u.isEmpty) return null;
    // Pad odd-length hex (e.g. 5-byte EPC stored as 10 nibbles) to even byte boundary.
    if (u.length.isOdd) u = '0$u';

    return RfidTagRead(
      epcHex24: u,
      rssi: rssi,
      generation: generation,
      nativeMs: nativeMs,
      relativeProximity: relativeProximity,
      raw: rawReported,
    );
  }
}
