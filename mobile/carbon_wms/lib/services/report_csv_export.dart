import 'dart:io';

import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:printing/printing.dart';

/// Shared CSV export for every report screen. Builds a CSV from the report's
/// columns + rows, writes it to the device's `reports/` folder, AND opens the
/// OS share sheet so the operator can email / Drive / Dropbox it. One helper so
/// every report exports the same way.

String _cell(String v) =>
    RegExp(r'[",\n\r]').hasMatch(v) ? '"${v.replaceAll('"', '""')}"' : v;

String buildCsv(List<String> header, List<List<String>> rows) {
  final b = StringBuffer()..writeln(header.map(_cell).join(','));
  for (final r in rows) {
    b.writeln(r.map(_cell).join(','));
  }
  return b.toString();
}

/// Build the CSV, save it under `<storage>/reports/<filename>`, then share it.
/// Shows a snackbar with the saved path (and any failure).
Future<void> exportReportCsv(
  BuildContext context, {
  required List<String> header,
  required List<List<String>> rows,
  required String filename,
}) async {
  final messenger = ScaffoldMessenger.of(context);
  if (rows.isEmpty) {
    messenger.showSnackBar(
      const SnackBar(content: Text('Nothing to export yet.')),
    );
    return;
  }
  try {
    final csv = buildCsv(header, rows);
    final baseDir = await getExternalStorageDirectory() ??
        await getApplicationDocumentsDirectory();
    final dir = Directory('${baseDir.path}/reports');
    if (!await dir.exists()) await dir.create(recursive: true);
    final safe = filename.endsWith('.csv') ? filename : '$filename.csv';
    final path = '${dir.path}/$safe';
    final file = File(path);
    await file.writeAsString(csv);
    messenger.showSnackBar(
      SnackBar(content: Text('Saved $safe (${rows.length} rows)')),
    );
    // Also open the share sheet (email / Drive / Dropbox).
    try {
      await Printing.sharePdf(
        bytes: await file.readAsBytes(),
        filename: safe,
      );
    } catch (_) {/* save still succeeded */}
  } catch (e) {
    messenger.showSnackBar(SnackBar(content: Text('Export failed: $e')));
  }
}
