/// One line for manual CSV upload (cycle count / inventory session).
class ManualCsvRow {
  ManualCsvRow({required this.epc, required this.at});

  final String epc;
  final DateTime at;
}
