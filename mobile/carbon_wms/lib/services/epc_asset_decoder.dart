class DecodedEpcParts {
  const DecodedEpcParts({
    required this.prefixHex,
    required this.assetId,
    required this.serial,
  });

  final String prefixHex;
  final String assetId;
  final int serial;
}

/// Decodes EPC96 according to tenant formula:
/// - Prefix: 20 bits (5 hex chars)
/// - Item/Asset: 40 bits (10 hex chars)
/// - Serial: 36 bits (9 hex chars)
DecodedEpcParts decodeAssetFromEpc(String epc24) {
  final raw = epc24.trim().toUpperCase();
  if (raw.length != 24) {
    return const DecodedEpcParts(prefixHex: '', assetId: 'INVALID', serial: 0);
  }
  final prefixHex = raw.substring(0, 5);
  final itemHex = raw.substring(5, 15);
  final serialHex = raw.substring(15);
  final assetDec = BigInt.parse(itemHex, radix: 16).toString();
  final serial = int.tryParse(serialHex, radix: 16) ?? 0;
  return DecodedEpcParts(
      prefixHex: prefixHex, assetId: assetDec, serial: serial);
}
