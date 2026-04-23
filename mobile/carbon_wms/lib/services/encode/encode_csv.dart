import 'package:carbon_wms/services/encode/encode_tag_result.dart';

// Comma-escape per RFC 4180: wrap in double-quotes and double any embedded quote
// IFF the field contains one of: , " \r \n. Otherwise return verbatim.
String csvField(String? raw) {
  final s = raw ?? '';
  final needsQuote = s.contains(RegExp(r'[",\r\n]'));
  if (!needsQuote) return s;
  return '"${s.replaceAll('"', '""')}"';
}

/// Builds a full re-encode session CSV. Columns:
///   scanned_at, old_epc, new_epc, system_id, serial, custom_sku, item_name,
///   status, success, failure_reason
String buildEncodeSessionCsv(Iterable<EncodeTagResult> rows) {
  final b = StringBuffer(
    'scanned_at,old_epc,new_epc,system_id,serial,custom_sku,item_name,status,success,failure_reason\n',
  );
  for (final r in rows) {
    b
      ..write(csvField(r.at.toUtc().toIso8601String()))..write(',')
      ..write(csvField(r.oldEpc))..write(',')
      ..write(csvField(r.newEpc ?? ''))..write(',')
      ..write(csvField(r.systemId?.toString() ?? ''))..write(',')
      ..write(csvField(r.serial?.toString() ?? ''))..write(',')
      ..write(csvField(r.customSku ?? ''))..write(',')
      ..write(csvField(r.itemName ?? ''))..write(',')
      ..write(csvField(r.status.csv))..write(',')
      ..write(r.wasSuccessful ? 'true' : 'false')..write(',')
      ..write(csvField(r.failureReason.csv))..write('\n');
  }
  return b.toString();
}
