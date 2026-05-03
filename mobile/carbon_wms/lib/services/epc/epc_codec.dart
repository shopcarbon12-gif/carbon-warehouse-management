// EPC96 codec — config-driven SGTIN-96 decode that mirrors the server's
// `lib/server/epc-decode.ts`. The active layout is loaded from
// `tenant_epc_config` via the `mobile-sync` endpoint and cached on the
// `MobileSettingsRepository`. Carbon Jeans constants are kept here as the
// fallback so the codec works on first launch before the first sync.
//
// Layout (MSB -> LSB):  [prefixBits] | [assetBits] | [serialBits] = 96 bits.

const String kCarbonEpcPrefix = 'F0A0B';
const int kEpcLength = 24;
const int kMaxSerial = 0xFFFFFFFFF; // 36 bits

const EpcConfig kFallbackEpcConfig = EpcConfig(
  prefixHex: kCarbonEpcPrefix,
  prefixBits: 20,
  assetBits: 40,
  serialBits: 36,
  assetPaddingDigits: 13,
);

final RegExp _hex24 = RegExp(r'^[0-9A-Fa-f]{24}$');
final RegExp _hexAny = RegExp(r'^[0-9A-Fa-f]+$');

class EpcConfig {
  const EpcConfig({
    required this.prefixHex,
    required this.prefixBits,
    required this.assetBits,
    required this.serialBits,
    required this.assetPaddingDigits,
  });

  final String prefixHex;
  final int prefixBits;
  final int assetBits;
  final int serialBits;
  final int assetPaddingDigits;

  bool get isValidLayout =>
      prefixBits + assetBits + serialBits == 96 &&
      prefixHex.isNotEmpty &&
      _hexAny.hasMatch(prefixHex);

  /// Parse the `epc_config` payload from `GET /api/settings/mobile-sync`.
  /// Returns null when the field is missing/invalid so callers fall back to
  /// [kFallbackEpcConfig].
  static EpcConfig? fromMobileSyncRoot(Map<String, dynamic>? root) {
    if (root == null) return null;
    final raw = root['epc_config'];
    if (raw is! Map) return null;
    final pfx = raw['prefix_hex'] ?? raw['prefixHex'];
    final pb = raw['prefix_bits'] ?? raw['prefixBits'];
    final ab = raw['asset_bits'] ?? raw['assetBits'];
    final sb = raw['serial_bits'] ?? raw['serialBits'];
    final pad = raw['asset_padding_digits'] ?? raw['assetPaddingDigits'];
    if (pfx is! String || pb is! num || ab is! num || sb is! num) return null;
    final cfg = EpcConfig(
      prefixHex: pfx.trim().toUpperCase(),
      prefixBits: pb.round(),
      assetBits: ab.round(),
      serialBits: sb.round(),
      assetPaddingDigits: pad is num ? pad.round() : 0,
    );
    if (!cfg.isValidLayout) return null;
    return cfg;
  }

  Map<String, dynamic> toJson() => {
        'prefix_hex': prefixHex,
        'prefix_bits': prefixBits,
        'asset_bits': assetBits,
        'serial_bits': serialBits,
        'asset_padding_digits': assetPaddingDigits,
      };
}

enum DecodedEpcReason {
  badLength,
  badHex,
  wrongPrefix,
  badConfig,
}

class DecodedEpc {
  const DecodedEpc({
    required this.valid,
    required this.prefixHex,
    this.reason,
    this.systemId,
    this.serial,
  });

  final bool valid;
  final DecodedEpcReason? reason;

  /// Hex form of the prefix bits we read out of the EPC (uppercased).
  final String prefixHex;

  /// Decoded asset/item# (the catalog `ls_system_id`). Null when !valid.
  final BigInt? systemId;

  /// Decoded serial. Null when !valid.
  final BigInt? serial;
}

BigInt _bigPow2(int bits) => BigInt.one << bits;

/// Decode a 24-char hex EPC against the tenant bit layout.
///
/// Mirrors `lib/server/epc-decode.ts:decodeEpc` so mobile and server agree on
/// `systemId` for any tag the warehouse can read.
DecodedEpc decodeEpc(String epcHexInput, EpcConfig config) {
  final epcHex = epcHexInput.trim().toUpperCase();
  if (epcHex.length != kEpcLength) {
    return const DecodedEpc(
      valid: false,
      reason: DecodedEpcReason.badLength,
      prefixHex: '',
    );
  }
  if (!_hex24.hasMatch(epcHex)) {
    return const DecodedEpc(
      valid: false,
      reason: DecodedEpcReason.badHex,
      prefixHex: '',
    );
  }
  if (!config.isValidLayout) {
    return const DecodedEpc(
      valid: false,
      reason: DecodedEpcReason.badConfig,
      prefixHex: '',
    );
  }

  final bits96 = BigInt.parse(epcHex, radix: 16);
  final prefixShift = config.assetBits + config.serialBits;
  final prefixMask = _bigPow2(config.prefixBits) - BigInt.one;
  final prefixVal = (bits96 >> prefixShift) & prefixMask;

  final expectedPrefixVal = BigInt.parse(config.prefixHex, radix: 16);
  if (prefixVal != expectedPrefixVal) {
    final widthHex = ((config.prefixBits + 3) ~/ 4);
    final readHex = prefixVal.toRadixString(16).toUpperCase().padLeft(widthHex, '0');
    return DecodedEpc(
      valid: false,
      reason: DecodedEpcReason.wrongPrefix,
      prefixHex: readHex,
    );
  }

  final assetMask = _bigPow2(config.assetBits) - BigInt.one;
  final assetVal = (bits96 >> config.serialBits) & assetMask;
  final serialMask = _bigPow2(config.serialBits) - BigInt.one;
  final serialVal = bits96 & serialMask;

  return DecodedEpc(
    valid: true,
    prefixHex: config.prefixHex.toUpperCase(),
    systemId: assetVal,
    serial: serialVal,
  );
}

/// Display helper — pad systemId to the tenant's catalog digit width.
String formatSystemId(BigInt? systemId, EpcConfig config) {
  if (systemId == null) return '—';
  return systemId.toString().padLeft(config.assetPaddingDigits, '0');
}

bool isCurrentFormat(String epc, [EpcConfig config = kFallbackEpcConfig]) {
  if (epc.length != kEpcLength) return false;
  if (!_hex24.hasMatch(epc)) return false;
  return decodeEpc(epc, config).valid;
}

/// Backwards-compatible thin wrapper. Returns the systemId as a small `int`
/// when it fits in 53 bits (Dart double-safe range); otherwise returns null
/// and callers should switch to [decodeEpc] for the full BigInt value.
int? decodeSystemId(String epc, [EpcConfig config = kFallbackEpcConfig]) {
  final d = decodeEpc(epc, config);
  if (!d.valid || d.systemId == null) return null;
  final v = d.systemId!;
  if (v.bitLength > 53) return null;
  return v.toInt();
}

/// Backwards-compatible thin wrapper for the serial component.
int? decodeSerial(String epc, [EpcConfig config = kFallbackEpcConfig]) {
  final d = decodeEpc(epc, config);
  if (!d.valid || d.serial == null) return null;
  final v = d.serial!;
  if (v.bitLength > 53) return null;
  return v.toInt();
}

/// Build a 24-hex EPC from the tenant prefix + systemId + serial.
/// Mirrors `lib/utils/epc.ts:generateSGTIN96` packing.
String buildEpc(int systemId, int serial, [EpcConfig config = kFallbackEpcConfig]) {
  if (!config.isValidLayout) {
    throw StateError('EpcConfig invalid: bits do not sum to 96');
  }
  final widthAsset = ((config.assetBits + 3) ~/ 4);
  final widthSerial = ((config.serialBits + 3) ~/ 4);
  final sys = systemId
      .toRadixString(16)
      .padLeft(widthAsset, '0')
      .toUpperCase();
  final ser = serial
      .toRadixString(16)
      .padLeft(widthSerial, '0')
      .toUpperCase();
  return '${config.prefixHex.toUpperCase()}$sys$ser';
}

/// Extract a Custom SKU slice from a legacy EPC using 1-indexed, inclusive positions.
/// Example: extractCustomSku('C12511004024211069556920', 1, 13) -> 'C125110040242'.
String extractCustomSku(String epc, int start, int end) {
  return epc.substring(start - 1, end);
}
