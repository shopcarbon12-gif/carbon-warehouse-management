import 'package:flutter_test/flutter_test.dart';

import 'package:carbon_wms/hardware/locate_proximity.dart';

/// Locks in the proximity contract against the MEASURED Tag Test data
/// (2026-08-28, RFD8500 + Motorola Edge 5G UW, two tags on garments).
///
/// Measured peak signal at 30 dBm, and the lowest power each distance was
/// still heard at:
///
/// ```
///   ft     0    1    2    3    4    5    7    9   12
///   A    -21  -22  -24  -38  -39  -49  -50  -54  -65
///   B    -21  -23  -27  -33  -46  -43  -46  -51   —
///   lowest power heard (A)   5    5   15   25   25   25   25   25   30
/// ```
int pct(int rungIndex, int rssi) =>
    (proximityFor(rungIndex, rssi) * 100).round();

/// Rung index for a transmit power, as the screen's ladder indexes them.
int rung(int dbm) => kLocateRungsDbm.indexOf(dbm);

void main() {
  group('rung bands', () {
    test('are contiguous, so a power change can never lower the number', () {
      for (var i = 0; i < kLocateRungBands.length - 1; i++) {
        expect(kLocateRungBands[i].hi, kLocateRungBands[i + 1].lo,
            reason: 'gap or overlap between rung $i and ${i + 1}');
      }
    });

    test('span the full 0..1 range', () {
      expect(kLocateRungBands.first.lo, 0.0);
      expect(kLocateRungBands.last.hi, 1.0);
    });

    test('every rung outranks every wider rung, whatever the signal', () {
      // The worst possible reading on a narrower rung must still beat the best
      // possible reading on the rung above it. This is what makes closing in
      // monotonic regardless of how noisy the signal is.
      for (var i = 0; i < kLocateRungsDbm.length - 1; i++) {
        final bestWide = proximityFor(i, 0); // saturated, top of its band
        final worstNarrow = proximityFor(i + 1, -200); // nothing, band floor
        expect(worstNarrow, greaterThanOrEqualTo(bestWide),
            reason: 'rung $i overlaps rung ${i + 1}');
      }
    });
  });

  group('measured distances map to sensible percentages', () {
    test('0-1 ft (heard at 5 dBm) reads 90-100%', () {
      expect(pct(rung(5), -22), inInclusiveRange(90, 100)); // 0 ft, both tags
      expect(pct(rung(5), -29), inInclusiveRange(90, 100)); // 1 ft, tag A
      expect(pct(rung(5), -43), inInclusiveRange(90, 100)); // 1 ft, tag B
    });

    test('2 ft (heard at 10-15 dBm) reads 75-90%', () {
      expect(pct(rung(15), -33), inInclusiveRange(75, 90)); // tag A @ 2 ft
      expect(pct(rung(10), -40), inInclusiveRange(75, 90)); // tag B @ 2 ft
    });

    test('3 ft (heard at 20 dBm) reads 60-75%', () {
      expect(pct(rung(20), -40), inInclusiveRange(60, 75)); // tag B @ 3 ft
    });

    test('3-8 ft (heard at 25 dBm) reads 35-60%', () {
      expect(pct(rung(25), -40), inInclusiveRange(35, 60)); // ~3 ft
      expect(pct(rung(25), -54), inInclusiveRange(35, 60)); // ~5 ft
      expect(pct(rung(25), -63), inInclusiveRange(35, 60)); // ~9 ft
    });

    test('far zone (30 dBm only) reads 0-35% and tracks signal', () {
      expect(pct(rung(30), -65), inInclusiveRange(0, 5)); // ~12 ft
      expect(pct(rung(30), -54), inInclusiveRange(5, 20)); // ~9 ft
      expect(pct(rung(30), -38), inInclusiveRange(20, 35)); // ~3 ft
    });

    test('walking in produces a rising number the whole way', () {
      // The measured approach for tag A, rung by rung as the ladder would
      // narrow: 12 ft -> 9 ft -> 5 ft -> 3 ft -> 2 ft -> 1 ft.
      final walk = <int>[
        pct(rung(30), -65), // 12 ft
        pct(rung(30), -54), // 9 ft
        pct(rung(25), -54), // 5 ft
        pct(rung(25), -40), // 3 ft
        pct(rung(15), -33), // 2 ft
        pct(rung(5), -29), // 1 ft
      ];
      for (var i = 1; i < walk.length; i++) {
        expect(walk[i], greaterThan(walk[i - 1]),
            reason: 'step $i went backwards: $walk');
      }
    });
  });

  group('saturation is handled rather than fought', () {
    test('the near zone does not depend on signal strength', () {
      // At contact the receiver is pinned: 25 dB of power change moved the
      // reading 1 dB. So on the closest rung, a 20 dB spread in signal must
      // still land in the top band — the rung is what carries the claim.
      expect(pct(rung(5), -22), greaterThanOrEqualTo(90));
      expect(pct(rung(5), -43), greaterThanOrEqualTo(90));
    });

    test('an ambiguous far reading cannot masquerade as being close', () {
      // Tag B read about -46 dBm at 4 ft, 7 ft AND 8 ft. Whatever that means
      // for distance, at 30 dBm it must never imply the operator is on it.
      expect(pct(rung(30), -46), lessThan(35));
    });
  });

  group('hot/cold hysteresis', () {
    test('entering a state needs more than leaving it', () {
      // Rising through the boundary from warm does not latch hottest early...
      expect(hotColdFrom(0.85, 1.0, previous: HotCold.warm), HotCold.warm);
      expect(hotColdFrom(0.95, 1.0, previous: HotCold.warm), HotCold.hottest);
      // ...and once hottest, a small dip does not immediately drop it.
      expect(hotColdFrom(0.85, 1.0, previous: HotCold.hottest),
          HotCold.hottest);
    });

    test('a signal hovering at a boundary does not chatter', () {
      // The exact case the operator hit: HOTTEST -> COLD -> HOTTEST inside a
      // second. Oscillating either side of a single threshold must now stick.
      var state = HotCold.hottest;
      final seen = <HotCold>{};
      for (final ratio in [0.90, 0.83, 0.91, 0.84, 0.93, 0.82]) {
        state = hotColdFrom(ratio, 1.0, previous: state);
        seen.add(state);
      }
      expect(seen, {HotCold.hottest},
          reason: 'wobbling around the boundary changed the message: $seen');
    });

    test('a genuine collapse still reports colder', () {
      expect(hotColdFrom(0.30, 1.0, previous: HotCold.hottest), HotCold.colder);
    });

    test('a genuine recovery still climbs back', () {
      expect(hotColdFrom(0.98, 1.0, previous: HotCold.colder), HotCold.hottest);
    });

    test('no history yet is neutral rather than alarming', () {
      expect(hotColdFrom(0.5, 0), HotCold.warm);
    });
  });
}
