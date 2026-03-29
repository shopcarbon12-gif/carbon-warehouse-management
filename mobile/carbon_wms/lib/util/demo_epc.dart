import 'dart:math';

/// Generates a valid 24-character uppercase hex EPC for demos and simulate-scan.
String randomDemoEpc() {
  const hex = '0123456789ABCDEF';
  final r = Random();
  return List.generate(24, (_) => hex[r.nextInt(16)]).join();
}
