// Pure EPC96 encode/decode for Carbon Jeans tags.
// Current: F0A0B (20 bits) + system_id (40 bits) + serial (36 bits).
// Legacy: anything not starting with F0A0B or not 24 hex chars.

const String kCarbonEpcPrefix = 'F0A0B';
const int kEpcLength = 24;
const int kMaxSerial = 0xFFFFFFFFF; // 36 bits

final RegExp _hex24 = RegExp(r'^[0-9A-Fa-f]{24}$');

bool isCurrentFormat(String epc) {
  if (epc.length != kEpcLength) return false;
  if (!_hex24.hasMatch(epc)) return false;
  return epc.toUpperCase().startsWith(kCarbonEpcPrefix);
}

int? decodeSystemId(String epc) {
  if (epc.length != kEpcLength) return null;
  final hex = epc.substring(5, 15);
  return int.tryParse(hex, radix: 16);
}

int? decodeSerial(String epc) {
  if (epc.length != kEpcLength) return null;
  final hex = epc.substring(15, 24);
  return int.tryParse(hex, radix: 16);
}

String buildEpc(int systemId, int serial) {
  final sys = systemId.toRadixString(16).padLeft(10, '0').toUpperCase();
  final ser = serial.toRadixString(16).padLeft(9, '0').toUpperCase();
  return '$kCarbonEpcPrefix$sys$ser';
}

/// Extract a Custom SKU slice from a legacy EPC using 1-indexed, inclusive positions.
/// Example: extractCustomSku('C12511004024211069556920', 1, 13) -> 'C125110040242'.
String extractCustomSku(String epc, int start, int end) {
  return epc.substring(start - 1, end);
}
