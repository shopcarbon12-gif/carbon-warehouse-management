import 'package:flutter_test/flutter_test.dart';

import 'package:carbon_wms/hardware/locate_bearing.dart';

/// A tag sitting at [tagYaw]. Signal falls off as the gun points away from it,
/// which is what makes a sweep able to find it at all — a rough stand-in for
/// the RFD8500's antenna lobe.
int simulatedRssi(double gunYaw, double tagYaw, {int peak = -40, double lobe = 70}) {
  final off = normaliseDeg(tagYaw - gunYaw).abs();
  return (peak - (off / lobe) * 30).round();
}

void main() {
  final t0 = DateTime(2026, 8, 27, 12);

  group('BearingEstimator', () {
    test('a sweep across the tag finds its bearing', () {
      final est = BearingEstimator();
      // Operator sweeps 0..180 with the tag sitting at 90.
      for (var yaw = 0.0; yaw <= 180; yaw += 5) {
        est.add(yaw, simulatedRssi(yaw, 90), t0);
      }
      // Now pointing at 0 — the tag should read as 90 degrees to the right.
      final fix = est.fix(0, t0);
      expect(fix, isNotNull);
      expect(fix!.relativeDeg, closeTo(90, 12));
      expect(turnLabel(fix.relativeDeg), startsWith('RIGHT'));
    });

    test('reports the tag to the LEFT with the correct sign', () {
      final est = BearingEstimator();
      for (var yaw = 0.0; yaw <= 180; yaw += 5) {
        est.add(yaw, simulatedRssi(yaw, 40), t0);
      }
      final fix = est.fix(140, t0);
      expect(fix, isNotNull);
      expect(fix!.relativeDeg, lessThan(0), reason: 'negative means left');
      expect(turnLabel(fix.relativeDeg), startsWith('LEFT'));
    });

    test('standing still yields NO fix — one antenna cannot do this', () {
      final est = BearingEstimator();
      // 200 reads, all from the same heading. This is the case the physics
      // genuinely cannot answer, so the estimator must decline rather than
      // guess.
      for (var i = 0; i < 200; i++) {
        est.add(12.0, -45, t0);
      }
      expect(est.fix(12, t0), isNull);
    });

    test('a narrow sweep is still not enough coverage', () {
      final est = BearingEstimator();
      for (var yaw = 0.0; yaw <= 25; yaw += 5) {
        est.add(yaw, simulatedRssi(yaw, 90), t0);
      }
      expect(est.fix(0, t0), isNull);
    });

    test('a flat field yields no fix (anti-multipath guard)', () {
      final est = BearingEstimator();
      // Swept properly, but every heading reads the same — no lobe, nothing to
      // pick out. Pointing anywhere would be a guess.
      for (var yaw = 0.0; yaw < 360; yaw += 10) {
        est.add(yaw, -55, t0);
      }
      expect(est.fix(0, t0), isNull);
    });

    test('contrast below the threshold is rejected', () {
      final est = BearingEstimator();
      for (var yaw = 0.0; yaw < 360; yaw += 10) {
        // 3 dB of spread — under the 6 dB minimum.
        est.add(yaw, yaw == 90 ? -52 : -55, t0);
      }
      expect(est.fix(0, t0), isNull);
    });

    test('stale evidence expires so a fix follows the operator', () {
      final est = BearingEstimator();
      for (var yaw = 0.0; yaw <= 180; yaw += 5) {
        est.add(yaw, simulatedRssi(yaw, 90), t0);
      }
      expect(est.fix(0, t0), isNotNull);
      // Ten seconds later, having walked elsewhere, none of it counts.
      expect(est.fix(0, t0.add(const Duration(seconds: 10))), isNull);
    });

    test('reset clears everything', () {
      final est = BearingEstimator();
      for (var yaw = 0.0; yaw <= 180; yaw += 5) {
        est.add(yaw, simulatedRssi(yaw, 90), t0);
      }
      est.reset();
      expect(est.fix(0, t0), isNull);
    });

    test('keeps the strongest read per heading, not the latest', () {
      final est = BearingEstimator();
      for (var yaw = 0.0; yaw < 360; yaw += 10) {
        est.add(yaw, -70, t0);
      }
      // A strong read at 90, then a fade at the same heading. The peak is the
      // honest geometry; the fade is multipath.
      est.add(90, -35, t0);
      est.add(90, -75, t0);
      final fix = est.fix(0, t0);
      expect(fix, isNotNull);
      expect(fix!.peakRssi, -35);
      expect(fix.relativeDeg, closeTo(95, 10));
    });
  });

  group('turnLabel', () {
    test('dead ahead reads as straight, not a tiny angle', () {
      expect(turnLabel(0), 'STRAIGHT AHEAD');
      expect(turnLabel(15), 'STRAIGHT AHEAD');
      expect(turnLabel(-19), 'STRAIGHT AHEAD');
    });

    test('behind reads as turn around', () {
      expect(turnLabel(170), 'TURN AROUND');
      expect(turnLabel(-150), 'TURN AROUND');
    });

    test('sides carry the angle', () {
      expect(turnLabel(-45), 'LEFT 45°');
      expect(turnLabel(60), 'RIGHT 60°');
    });
  });

  group('normaliseDeg', () {
    test('wraps into -180..180', () {
      expect(normaliseDeg(0), 0);
      expect(normaliseDeg(190), closeTo(-170, 0.001));
      expect(normaliseDeg(-190), closeTo(170, 0.001));
      expect(normaliseDeg(360), 0);
      expect(normaliseDeg(540), closeTo(180, 0.001));
    });
  });

  group('distance in feet and inches', () {
    test('every 12 dB is roughly twice as far', () {
      final near = estimateFeet(-35);
      final far = estimateFeet(-47);
      expect(far / near, closeTo(2.0, 0.05));
    });

    test('reads in feet across the working range', () {
      expect(distanceLabel(-47), '≈ 2 FT');
      expect(distanceLabel(-59), '≈ 4 FT');
      expect(distanceLabel(-71), '≈ 8 FT');
      expect(distanceLabel(-80), '15+ FT');
    });

    test('the last foot collapses to ON THE TAG, in inches', () {
      // RSSI saturates in the near field, so inches cannot be resolved here —
      // the readout says so instead of inventing a number.
      expect(distanceLabel(-35), 'ON THE TAG');
      expect(distanceLabel(-25), 'ON THE TAG');
      expect(distanceSubLabel(-30), 'UNDER 12 IN');
      expect(distanceSubLabel(-60), isNull);
    });

    test('no reading yields no distance claim', () {
      expect(distanceLabel(null), '—');
      expect(distanceSubLabel(null), isNull);
    });

    test('distance never goes backwards as signal weakens', () {
      var previous = 0.0;
      for (var rssi = -30; rssi >= -85; rssi -= 5) {
        final ft = estimateFeet(rssi);
        expect(ft, greaterThan(previous));
        previous = ft;
      }
    });
  });
}
