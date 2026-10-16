import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:carbon_wms/ui/widgets/scan_range.dart';

void main() {
  test('FAR takes every read and keeps quiet mode on', () {
    final s = ScanRangeSetting('t');
    expect(s.range, ScanRange.far);
    expect(s.minRssi, isNull);
    expect(s.quietMode, isTrue);
    expect(s.passes(-90), isTrue);
    expect(s.passes(null), isTrue);
  });

  test('NEAR / MED gate on the minimum signal; no RSSI is never gated', () {
    final s = ScanRangeSetting('t')..range = ScanRange.near;
    expect(s.quietMode, isFalse);
    expect(s.passes(-55), isTrue);
    expect(s.passes(-40), isTrue);
    expect(s.passes(-56), isFalse);
    expect(s.passes(null), isTrue);
    s.range = ScanRange.medium;
    expect(s.passes(-65), isTrue);
    expect(s.passes(-66), isFalse);
  });

  test('each screen remembers its own range and gates', () async {
    SharedPreferences.setMockInitialValues({
      'zone_mgmt_range': 'near',
      'zone_mgmt_gate_near': -50,
    });
    final zone = ScanRangeSetting('zone_mgmt');
    await zone.load();
    expect(zone.range, ScanRange.near);
    expect(zone.minRssi, -50);
    expect(zone.gate[ScanRange.medium], -65);

    final bulk = ScanRangeSetting('bulk_geiger');
    await bulk.load();
    expect(bulk.range, ScanRange.far);

    bulk
      ..range = ScanRange.medium
      ..gate[ScanRange.medium] = -70;
    await bulk.save();
    final again = ScanRangeSetting('bulk_geiger');
    await again.load();
    expect(again.range, ScanRange.medium);
    expect(again.minRssi, -70);
    // Zone untouched.
    await zone.load();
    expect(zone.range, ScanRange.near);
  });
}
