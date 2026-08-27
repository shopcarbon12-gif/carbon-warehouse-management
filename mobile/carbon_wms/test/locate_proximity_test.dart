import 'package:flutter_test/flutter_test.dart';

import 'package:carbon_wms/ui/screens/locate_tag_screen.dart';

/// Locks in the Locate-Tag proximity contract the operator asked for:
///   * the percentage tracks DISTANCE, monotonically
///   * 95-100% means the gun is on the tag, not "somewhere in this aisle"
///   * the meter behaves identically at every transmit power
int pct(int rssi, {double strong = kLocateStrongDbm}) =>
    (rssiToProximity01(rssi, strongDbm: strong) * 100).round();

void main() {
  group('proximity curve', () {
    test('anchors: contact is 100%, noise floor is 0%', () {
      expect(pct(-35), 100);
      expect(pct(-30), 100, reason: 'anything hotter than contact stays 100');
      expect(pct(-80), 0);
      expect(pct(-90), 0, reason: 'below the floor clamps, never goes negative');
    });

    test('95-100% is reserved for the last few centimetres', () {
      // The band that reads 95%+ must be a couple of dB wide at the very top,
      // which at 40*log10(d) is ~15% of the distance to the tag.
      expect(pct(-37), greaterThanOrEqualTo(95));
      expect(pct(-38), lessThan(95));
      // The old anchor was -45 and reported 100% there. That is roughly a
      // METRE out on an RFD8500 at full power — the bug being fixed.
      expect(pct(-45), lessThan(80),
          reason: '-45 dBm is about a metre away, must not read as "there"');
    });

    test('percentage falls monotonically as the tag gets further', () {
      // -35 -> -80 in 5 dB steps. Each step is ~1.33x the distance.
      var previous = 101;
      for (var rssi = -35; rssi >= -80; rssi -= 5) {
        final p = pct(rssi);
        expect(p, lessThan(previous), reason: 'not monotonic at $rssi dBm');
        previous = p;
      }
    });

    test('mid-range stays useful instead of pinning at either end', () {
      // Rough real-world distances on an RFD8500 at full power.
      expect(pct(-50), inInclusiveRange(60, 72)); // ~1 m
      expect(pct(-62), inInclusiveRange(34, 46)); // ~2 m
      expect(pct(-74), inInclusiveRange(8, 20)); // ~4 m
    });

    test('a hotter contact reading stretches the scale instead of clipping',
        () {
      // If this gun/tag pair peaks at -28 when touching, _strongRef adapts and
      // -28 becomes 100% — while -35 correctly drops below full scale.
      expect(pct(-28, strong: -28), 100);
      expect(pct(-35, strong: -28), lessThan(100));
      expect(pct(-35, strong: -28), greaterThan(80));
    });
  });

  group('power normalisation', () {
    test('is a no-op at full power', () {
      expect(powerNormalisedRssi(-50, powerDbm: 30, maxDbm: 30), -50);
    });

    test('same distance reads the same percentage at any power', () {
      // Backscatter: P_rx tracks P_tx dB-for-dB. A spot that reads -35 (i.e.
      // touching) at 30 dBm reads -53 at 12 dBm. Both must show 100%.
      const contactAtFullPower = -35;
      const contactAt12dBm = contactAtFullPower - 18;

      final full = powerNormalisedRssi(
        contactAtFullPower,
        powerDbm: 30,
        maxDbm: 30,
      );
      final low = powerNormalisedRssi(
        contactAt12dBm,
        powerDbm: 12,
        maxDbm: 30,
      );

      expect(low, full);
      expect(pct(low!), 100);
      // ...and this is what regressed before the fix: without normalisation
      // the same physical spot collapsed to a third of the bar.
      expect(pct(contactAt12dBm), lessThan(70));
    });

    test('C72E ceiling of 23 dBm is its own full-power reference', () {
      // Slider at max on a C72E means the radio is at 23, not 30 — offset 0.
      expect(powerNormalisedRssi(-40, powerDbm: 23, maxDbm: 23), -40);
      // Half power on that radio shifts by the difference from ITS max.
      expect(powerNormalisedRssi(-52, powerDbm: 11, maxDbm: 23), -40);
    });

    test('offset is bounded so a bad capability read cannot pin the meter', () {
      // A nonsense 200 dB span must not turn a far tag into 100%.
      expect(powerNormalisedRssi(-75, powerDbm: 1, maxDbm: 30), -50);
      expect(powerNormalisedRssi(null, powerDbm: 12, maxDbm: 30), isNull);
    });
  });
}
