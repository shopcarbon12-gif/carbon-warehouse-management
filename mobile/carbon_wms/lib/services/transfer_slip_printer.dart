import 'dart:typed_data';

import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;
import 'package:printing/printing.dart';

import 'package:carbon_wms/util/format_user_name.dart';

/// Builds the transfer packing slip as a PDF **natively on-device** from the
/// transfer detail JSON (the same record the desktop shows) and hands it to the
/// platform.
///
///   • [printSlip] opens the system print sheet — WiFi / network printers and
///     "Save as PDF" are both listed there by Android's print framework.
///   • [shareSlip] opens the share sheet so the operator can save the PDF to the
///     device or any installed cloud app (Drive, Dropbox, …).
///
/// Why native and not `Printing.convertHtml`: the HTML→PDF path renders through
/// a headless WebView that silently fails/hangs on the rugged handhelds (the
/// Print/Save buttons "did nothing"). Laying the slip out with the `pdf`
/// package removes the WebView entirely, so it is deterministic and offline.
///
/// The slip itself is already persisted in the WMS the moment the transfer
/// commits, so it also shows up in Reports → Transfers like the desktop version.
class TransferSlipPrinter {
  const TransferSlipPrinter._();

  static Future<bool> printSlip({
    required Map<String, dynamic> detail,
    required String docName,
  }) async {
    final bytes = await _build(detail, docName);
    return Printing.layoutPdf(name: docName, onLayout: (_) async => bytes);
  }

  static Future<void> shareSlip({
    required Map<String, dynamic> detail,
    required String docName,
  }) async {
    final bytes = await _build(detail, docName);
    await Printing.sharePdf(bytes: bytes, filename: '$docName.pdf');
  }

  // ── PDF layout ──────────────────────────────────────────────────────────────
  static const PdfColor _ink = PdfColor.fromInt(0xFF171D1D);
  static const PdfColor _slate = PdfColor.fromInt(0xFF3F4A4A);
  static const PdfColor _muted = PdfColor.fromInt(0xFF8A9090);
  static const PdfColor _teal = PdfColor.fromInt(0xFF1B7D7D);
  static const PdfColor _line = PdfColor.fromInt(0xFFD7DEDE);
  static const PdfColor _zebra = PdfColor.fromInt(0xFFF2F5F5);

  static String _s(dynamic v) => (v ?? '').toString().trim();

  static String _desc(Map row) => [row['name'], row['color'], row['size']]
      .map((e) => _s(e))
      .where((e) => e.isNotEmpty)
      .join(' · ')
      .toUpperCase();

  static Future<Uint8List> _build(
      Map<String, dynamic> detail, String docName) async {
    final slip = _s(detail['slip_number']);
    final state = _s(detail['state']).toUpperCase();
    final createdAt = _s(detail['created_at']);
    final date = createdAt.isEmpty
        ? ''
        : createdAt.replaceFirst('T', ' ').split('.').first;
    final fromCode = _s(detail['source_location_code']);
    final fromName = _s(detail['source_location_name']);
    final toCode = _s(detail['destination_location_code']);
    final toName = _s(detail['destination_location_name']);
    final by = formatUserDisplayName(
      detail['created_by_first']?.toString(),
      detail['created_by_last']?.toString(),
      detail['created_by_email']?.toString(),
    );

    // Group RFID lines by SKU → count; keep manual lines with their qty.
    final rfid = (detail['rfid'] as List?) ?? const [];
    final order = <String>[];
    final groups = <String, Map<String, dynamic>>{};
    for (final r in rfid) {
      if (r is! Map) continue;
      final sku = _s(r['sku']);
      final key = sku.isNotEmpty ? sku : _s(r['epc']);
      final g = groups.putIfAbsent(key, () {
        order.add(key);
        return {'sku': sku, 'desc': _desc(r), 'qty': 0};
      });
      g['qty'] = (g['qty'] as int) + 1;
    }
    final manual = (detail['manual'] as List?) ?? const [];

    var rfidTotal = 0;
    for (final k in order) {
      rfidTotal += groups[k]!['qty'] as int;
    }
    var manualTotal = 0;
    for (final m in manual) {
      if (m is Map) manualTotal += (m['qty'] as num?)?.toInt() ?? 0;
    }

    final rows = <List<String>>[
      for (final k in order)
        [
          _s(groups[k]!['sku']),
          _s(groups[k]!['desc']),
          'RFID',
          '${groups[k]!['qty']}',
        ],
      for (final m in manual)
        if (m is Map)
          [
            _s(m['sku']),
            _desc(m),
            'MANUAL',
            '${(m['qty'] as num?)?.toInt() ?? 0}',
          ],
    ];

    pw.Widget label(String t) => pw.Text(t,
        style: pw.TextStyle(
            fontSize: 7, color: _muted, fontWeight: pw.FontWeight.bold));
    pw.Widget value(String t, {PdfColor color = _ink, double size = 12}) =>
        pw.Text(t.isEmpty ? '—' : t,
            style: pw.TextStyle(
                fontSize: size, color: color, fontWeight: pw.FontWeight.bold));

    final doc = pw.Document(title: docName);
    doc.addPage(
      pw.Page(
        pageFormat: PdfPageFormat.letter,
        margin: const pw.EdgeInsets.all(36),
        build: (ctx) => pw.Column(
          crossAxisAlignment: pw.CrossAxisAlignment.start,
          children: [
            // Header
            pw.Row(
              mainAxisAlignment: pw.MainAxisAlignment.spaceBetween,
              crossAxisAlignment: pw.CrossAxisAlignment.start,
              children: [
                pw.Column(crossAxisAlignment: pw.CrossAxisAlignment.start, children: [
                  pw.Text('TRANSFER SLIP',
                      style: pw.TextStyle(
                          fontSize: 20,
                          color: _ink,
                          fontWeight: pw.FontWeight.bold,
                          letterSpacing: 1)),
                  pw.SizedBox(height: 2),
                  pw.Text('Carbon WMS',
                      style: const pw.TextStyle(fontSize: 10, color: _muted)),
                ]),
                pw.Column(crossAxisAlignment: pw.CrossAxisAlignment.end, children: [
                  value('#${slip.isEmpty ? "—" : slip}', color: _teal, size: 18),
                  pw.SizedBox(height: 2),
                  pw.Container(
                    padding: const pw.EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                    color: _zebra,
                    child: pw.Text(state.isEmpty ? 'IN-TRANSIT' : state,
                        style: pw.TextStyle(
                            fontSize: 8,
                            color: _slate,
                            fontWeight: pw.FontWeight.bold,
                            letterSpacing: 0.6)),
                  ),
                ]),
              ],
            ),
            pw.SizedBox(height: 14),
            pw.Divider(color: _line, thickness: 1),
            pw.SizedBox(height: 10),

            // From → To
            pw.Row(children: [
              pw.Expanded(
                child: pw.Column(crossAxisAlignment: pw.CrossAxisAlignment.start, children: [
                  label('FROM'),
                  pw.SizedBox(height: 2),
                  value(fromCode),
                  pw.Text(fromName.toUpperCase(),
                      style: const pw.TextStyle(fontSize: 9, color: _slate)),
                ]),
              ),
              pw.Container(
                  padding: const pw.EdgeInsets.symmetric(horizontal: 14),
                  child: pw.Text('→',
                      style: const pw.TextStyle(fontSize: 18, color: _teal))),
              pw.Expanded(
                child: pw.Column(crossAxisAlignment: pw.CrossAxisAlignment.start, children: [
                  label('TO'),
                  pw.SizedBox(height: 2),
                  value(toCode),
                  pw.Text(toName.toUpperCase(),
                      style: const pw.TextStyle(fontSize: 9, color: _slate)),
                ]),
              ),
            ]),
            pw.SizedBox(height: 10),
            pw.Row(children: [
              pw.Expanded(
                  child: pw.Column(crossAxisAlignment: pw.CrossAxisAlignment.start, children: [
                label('DATE'),
                pw.SizedBox(height: 2),
                value(date, size: 10),
              ])),
              pw.Expanded(
                  child: pw.Column(crossAxisAlignment: pw.CrossAxisAlignment.start, children: [
                label('CREATED BY'),
                pw.SizedBox(height: 2),
                value(by, size: 10),
              ])),
            ]),
            pw.SizedBox(height: 16),

            // Line table
            pw.Table(
              border: pw.TableBorder.symmetric(
                  inside: const pw.BorderSide(color: _line, width: 0.5)),
              columnWidths: {
                0: const pw.FlexColumnWidth(2.2),
                1: const pw.FlexColumnWidth(4),
                2: const pw.FlexColumnWidth(1.4),
                3: const pw.FlexColumnWidth(1),
              },
              children: [
                pw.TableRow(
                  decoration: const pw.BoxDecoration(color: _ink),
                  children: [
                    _th('SKU'),
                    _th('DESCRIPTION'),
                    _th('TYPE'),
                    _th('QTY', align: pw.TextAlign.right),
                  ],
                ),
                for (var i = 0; i < rows.length; i++)
                  pw.TableRow(
                    decoration: pw.BoxDecoration(
                        color: i.isOdd ? _zebra : PdfColors.white),
                    children: [
                      _td(rows[i][0], mono: true),
                      _td(rows[i][1]),
                      _td(rows[i][2],
                          color: rows[i][2] == 'RFID' ? _teal : _slate),
                      _td(rows[i][3], align: pw.TextAlign.right, bold: true),
                    ],
                  ),
                if (rows.isEmpty)
                  pw.TableRow(children: [
                    _td('—'),
                    _td('No lines on this slip'),
                    _td(''),
                    _td(''),
                  ]),
              ],
            ),
            pw.SizedBox(height: 14),

            // Totals
            pw.Align(
              alignment: pw.Alignment.centerRight,
              child: pw.Column(crossAxisAlignment: pw.CrossAxisAlignment.end, children: [
                _totalLine('RFID', rfidTotal),
                _totalLine('MANUAL', manualTotal),
                pw.SizedBox(height: 4),
                _totalLine('TOTAL', rfidTotal + manualTotal, strong: true),
              ]),
            ),

            pw.Spacer(),
            pw.Divider(color: _line, thickness: 0.5),
            pw.Text(
                'Carbon WMS · transfer packing slip · generated on device',
                style: const pw.TextStyle(fontSize: 8, color: _muted)),
          ],
        ),
      ),
    );
    return doc.save();
  }

  static pw.Widget _th(String t, {pw.TextAlign align = pw.TextAlign.left}) =>
      pw.Padding(
        padding: const pw.EdgeInsets.symmetric(horizontal: 8, vertical: 6),
        child: pw.Text(t,
            textAlign: align,
            style: pw.TextStyle(
                fontSize: 8,
                color: PdfColors.white,
                fontWeight: pw.FontWeight.bold,
                letterSpacing: 0.6)),
      );

  static pw.Widget _td(String t,
          {bool mono = false,
          bool bold = false,
          PdfColor color = _ink,
          pw.TextAlign align = pw.TextAlign.left}) =>
      pw.Padding(
        padding: const pw.EdgeInsets.symmetric(horizontal: 8, vertical: 6),
        child: pw.Text(t,
            textAlign: align,
            style: pw.TextStyle(
                fontSize: 9.5,
                color: color,
                fontWeight: bold ? pw.FontWeight.bold : pw.FontWeight.normal)),
      );

  static pw.Widget _totalLine(String k, int v, {bool strong = false}) =>
      pw.Padding(
        padding: const pw.EdgeInsets.only(top: 2),
        child: pw.Row(mainAxisSize: pw.MainAxisSize.min, children: [
          pw.Text('$k  ',
              style: pw.TextStyle(
                  fontSize: strong ? 11 : 9,
                  color: strong ? _ink : _muted,
                  fontWeight: pw.FontWeight.bold)),
          pw.SizedBox(width: 8),
          pw.Text('$v',
              style: pw.TextStyle(
                  fontSize: strong ? 14 : 11,
                  color: strong ? _teal : _slate,
                  fontWeight: pw.FontWeight.bold)),
        ]),
      );
}
