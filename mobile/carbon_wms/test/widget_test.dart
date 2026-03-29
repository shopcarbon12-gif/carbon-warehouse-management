import 'package:flutter_test/flutter_test.dart';

import 'package:carbon_wms/main.dart';

void main() {
  testWidgets('dashboard loads (smoke)', (WidgetTester tester) async {
    await tester.pumpWidget(const CarbonWmsRoot());
    await tester.pumpAndSettle(const Duration(seconds: 2));
    expect(find.text('MODULES'), findsOneWidget);
  });
}
