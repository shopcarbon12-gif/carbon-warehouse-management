import 'package:flutter/material.dart';

import 'package:carbon_wms/ui/screens/status_reports_screen.dart';

/// Damages report — the DAMAGED subset of the status-change audit trail.
/// Reuses [StatusChangeReportView] with `damagedOnly: true`.
class DamagesReportsScreen extends StatelessWidget {
  const DamagesReportsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const StatusChangeReportView(title: 'DAMAGES', damagedOnly: true);
  }
}
