// Printing.convertHtml is marked deprecated in 5.13 but remains the supported
// HTML→PDF path on Android; the suggested replacements are desktop/web only.
// ignore_for_file: deprecated_member_use
import 'package:pdf/pdf.dart';
import 'package:printing/printing.dart';

/// Renders the transfer slip HTML (the SAME document the desktop prints, fetched
/// from `/api/operations/transfers/{id}/pdf`) to a PDF on-device and hands it to
/// the platform.
///
///   • [printSlip] opens the system print sheet — WiFi / network printers and
///     "Save as PDF" are both listed there by Android's print framework.
///   • [shareSlip] opens the share sheet so the operator can save the PDF to the
///     device or any installed cloud app (Drive, Dropbox, …).
///
/// The slip itself is already persisted in the WMS the moment the transfer
/// commits, so it shows up in Reports → Transfers exactly like the desktop
/// version — no separate upload step is needed.
class TransferSlipPrinter {
  const TransferSlipPrinter._();

  static Future<bool> printSlip({
    required String html,
    required String docName,
  }) {
    return Printing.layoutPdf(
      name: docName,
      onLayout: (PdfPageFormat format) =>
          Printing.convertHtml(format: format, html: html),
    );
  }

  static Future<void> shareSlip({
    required String html,
    required String docName,
  }) async {
    final bytes = await Printing.convertHtml(
      format: PdfPageFormat.letter,
      html: html,
    );
    await Printing.sharePdf(bytes: bytes, filename: '$docName.pdf');
  }
}
