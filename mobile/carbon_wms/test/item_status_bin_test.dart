import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:carbon_wms/ui/widgets/item_status_bin.dart';

void main() {
  test('status names follow the UI wording', () {
    expect(itemStatusLabel('in-stock'), 'LIVE');
    expect(itemStatusLabel('tag_killed'), 'TAG KILLED');
    expect(itemStatusLabel('retired'), 'RETIRED');
    expect(itemStatusLabel('unknown'), 'UNKNOWN');
    expect(itemStatusLabel(null), 'NOT IN WMS');
    expect(itemStatusLabel(''), 'NOT IN WMS');
  });

  testWidgets('line shows the status chip and the formatted bin', (tester) async {
    await tester.pumpWidget(ScreenUtilInit(
      designSize: const Size(412, 917),
      builder: (_, __) => const MaterialApp(
        home: Scaffold(body: ItemStatusBinLine(status: 'in-stock', bin: '6B02C')),
      ),
    ));
    expect(find.text('LIVE'), findsOneWidget);
    expect(find.text('BIN 6-B-02-C'), findsOneWidget);
  });

  testWidgets('no bin assigned → status only; hidden status → nothing', (tester) async {
    await tester.pumpWidget(ScreenUtilInit(
      designSize: const Size(412, 917),
      builder: (_, __) => const MaterialApp(
        home: Scaffold(
          body: Column(children: [
            ItemStatusBinLine(status: 'sold', bin: null),
            ItemStatusBinLine(status: null, bin: '', showStatus: false),
          ]),
        ),
      ),
    ));
    expect(find.text('SOLD'), findsOneWidget);
    expect(find.textContaining('BIN'), findsNothing);
    expect(find.text('NOT IN WMS'), findsNothing);
  });
}
