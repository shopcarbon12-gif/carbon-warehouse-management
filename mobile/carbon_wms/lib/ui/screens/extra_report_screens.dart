import 'package:flutter/material.dart';

import 'package:carbon_wms/ui/screens/report_list_screen.dart';

/// Encode Commission report — chips written/commissioned (encode_events).
class EncodeCommissionReportScreen extends StatelessWidget {
  const EncodeCommissionReportScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return ReportListScreen(
      title: 'ENCODE COMMISSION',
      csvName: 'encode-commission',
      emptyText: 'No chips commissioned yet.',
      fetch: (api) => api.fetchEncodeEvents(limit: 300),
      columns: const [
        ReportCol('newEpc', 'epc', primary: true),
        ReportCol('customSku', 'custom_sku'),
        ReportCol('systemId', 'system_id'),
        ReportCol('serial', 'serial'),
        ReportCol('status', 'status'),
        ReportCol('encodedAt', 'encoded_at'),
        ReportCol('by', 'encoded_by'),
        ReportCol('deviceId', 'device'),
      ],
    );
  }
}

/// Add-On Catalog report — uncatalogued tags promoted to LIVE.
class AddOnCatalogReportScreen extends StatelessWidget {
  const AddOnCatalogReportScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return ReportListScreen(
      title: 'ADD-ON CATALOG',
      csvName: 'add-on-catalog',
      emptyText: 'No tags promoted to LIVE yet.',
      fetch: (api) => api.fetchAddOnCatalogReport(),
      columns: const [
        ReportCol('epc', 'epc', primary: true),
        ReportCol('decoded_sku', 'decoded_sku'),
        ReportCol('decoded_system_id', 'decoded_system_id'),
        ReportCol('added_status', 'added_status'),
        ReportCol('added_at', 'added_at'),
        ReportCol('added_by', 'added_by'),
        ReportCol('location', 'location'),
      ],
    );
  }
}

/// Label Print report — RFID hang-tags or Non-RFID price labels.
class LabelPrintReportScreen extends StatelessWidget {
  const LabelPrintReportScreen({super.key, required this.nonRfid});
  final bool nonRfid;

  @override
  Widget build(BuildContext context) {
    return ReportListScreen(
      title: nonRfid ? 'LABEL PRINT · NON-RFID' : 'LABEL PRINT · RFID',
      csvName: nonRfid ? 'label-print-non-rfid' : 'label-print-rfid',
      emptyText: 'No labels printed yet.',
      fetch: (api) => api.fetchLabelPrintReport(nonRfid: nonRfid),
      columns: nonRfid
          ? const [
              ReportCol('sku', 'custom_sku', primary: true),
              ReportCol('item_name', 'item_name'),
              ReportCol('qty', 'qty'),
              ReportCol('template', 'template'),
              ReportCol('printer', 'printer'),
              ReportCol('printed_at', 'printed_at'),
              ReportCol('printed_by', 'printed_by'),
            ]
          : const [
              ReportCol('epc', 'epc', primary: true),
              ReportCol('sku', 'custom_sku'),
              ReportCol('qty', 'qty'),
              ReportCol('template', 'template'),
              ReportCol('printer', 'printer'),
              ReportCol('printed_at', 'printed_at'),
              ReportCol('printed_by', 'printed_by'),
            ],
    );
  }
}
