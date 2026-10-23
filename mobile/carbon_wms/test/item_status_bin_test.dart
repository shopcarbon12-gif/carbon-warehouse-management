import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:carbon_wms/ui/widgets/item_status_bin.dart';
import 'package:carbon_wms/ui/widgets/store_zone_icon.dart';

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

  // Owner, 2026-10-22: a tag in the STORE zone shows the teal store icon
  // only — no "ZONE STORE" text; any other zone keeps its name.
  testWidgets('STORE zone → store icon, no text; other zones keep their name', (tester) async {
    await tester.pumpWidget(ScreenUtilInit(
      designSize: const Size(412, 917),
      builder: (_, __) => const MaterialApp(
        home: Scaffold(
          body: Column(children: [
            ItemStatusBinLine(status: 'in-stock', bin: null, zone: 'Store'),
            ItemStatusBinLine(status: 'in-stock', bin: null, zone: 'Window'),
          ]),
        ),
      ),
    ));
    expect(find.byType(StoreZoneIcon), findsOneWidget);
    expect(find.textContaining('STORE'), findsNothing);
    expect(find.text('ZONE WINDOW'), findsOneWidget);
  });

  test('store zone name match and count parsing', () {
    expect(isStoreZone('Store'), isTrue);
    expect(isStoreZone(' STORE '), isTrue);
    expect(isStoreZone('Storefront'), isFalse);
    expect(isStoreZone(null), isFalse);
    expect(storeZoneCountOf({'store_zone_count': 3}), 3);
    expect(storeZoneCountOf({'storeZoneCount': '2'}), 2);
    expect(storeZoneCountOf({'sku': 'x'}), 0);
    expect(storeZoneCountOf(null), 0);
  });
}
