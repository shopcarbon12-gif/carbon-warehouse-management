import 'package:flutter_test/flutter_test.dart';

import 'package:carbon_wms/locate/locate_engine.dart';
import 'package:carbon_wms/locate/sweep_estimator.dart';

const _a = 'E28011606000020000000001';
const _b = 'E28011606000020000000002';
const _other = 'E28011606000020000000099';

LocateObservation _obs(String epc, int t, {int? rssi = -50, int? gen, bool bad = false}) =>
    LocateObservation(epc: epc, receivedMs: t, rssi: rssi, generation: gen, formatError: bad);

/// Feed [epc] every [stepMs] from [from] to [to] (exclusive).
void _feed(LocateEngine e, String epc, int from, int to, {int stepMs = 20, int? rssi = -50, int? gen}) {
  for (var t = from; t < to; t += stepMs) {
    e.add(_obs(epc, t, rssi: rssi, gen: gen));
  }
}

void main() {
  group('LocateEngine — evidence', () {
    test('only the exact target counts; other tags and malformed ids are ignored', () {
      final e = LocateEngine(targets: [_a]);
      expect(e.add(_obs(_other, 10)), isFalse);
      expect(e.add(_obs('E2801160', 10, bad: true)), isFalse);
      expect(e.add(_obs(_a, 10)), isTrue);
      expect(e.otherTagReads, 1);
      expect(e.formatErrors, 1);
      expect(e.targetReads, 1);
    });

    test('reads from before the acknowledged power change are dropped', () {
      final e = LocateEngine(targets: [_a]);
      e.resetForGeneration(5);
      expect(e.add(_obs(_a, 10, gen: 4)), isFalse);
      expect(e.staleDropped, 1);
      expect(e.add(_obs(_a, 20, gen: 5)), isTrue);
    });

    test('searching → detected → loss clears the signal immediately', () {
      final e = LocateEngine(targets: [_a]);
      expect(e.tick(100).presence, LocatePresence.searching);
      _feed(e, _a, 100, 1100, rssi: -40);
      final hot = e.tick(1100);
      expect(hot.presence, LocatePresence.detected);
      expect(hot.signal, greaterThan(0.5));
      expect(hot.steady, isTrue);
      // Nothing for longer than freshMs (700) → back to searching, no lingering signal.
      final cold = e.tick(1100 + 800);
      expect(cold.presence, LocatePresence.searching);
      expect(cold.signal, isNull);
    });

    test('reads with no RSSI = detected, strength unavailable (never a fake level)', () {
      final e = LocateEngine(targets: [_a]);
      _feed(e, _a, 0, 600, rssi: null);
      final r = e.tick(600);
      expect(r.presence, LocatePresence.detectedNoStrength);
      expect(r.signal, isNull);
      expect(e.nullRssiTargetReads, greaterThan(0));
    });

    test('stronger RSSI gives a higher signal', () {
      final weak = LocateEngine(targets: [_a]);
      final strong = LocateEngine(targets: [_a]);
      _feed(weak, _a, 0, 1000, rssi: -75);
      _feed(strong, _a, 0, 1000, rssi: -45);
      expect(strong.tick(1000).signal!, greaterThan(weak.tick(1000).signal!));
    });
  });

  group('LocateEngine — any unit', () {
    test('follows the strongest unit and does not flip on a brief challenger', () {
      final e = LocateEngine(targets: [_a, _b]);
      _feed(e, _a, 0, 1000, rssi: -60);
      _feed(e, _b, 0, 1000, rssi: -75);
      expect(e.tick(1000).followedEpc, _a);
      // B becomes much stronger, but only for 0.5 s → keep following A.
      _feed(e, _a, 1000, 1500, rssi: -60);
      _feed(e, _b, 1000, 1500, rssi: -35);
      for (var t = 1000; t <= 1500; t += 50) {
        e.tick(t);
      }
      expect(e.tick(1500).followedEpc, _a);
      // B stays clearly stronger for > 1.5 s → switch.
      for (var t = 1500; t <= 3300; t += 50) {
        _feed(e, _a, t, t + 50, rssi: -60);
        _feed(e, _b, t, t + 50, rssi: -35);
        e.tick(t + 50);
      }
      expect(e.tick(3350).followedEpc, _b);
    });

    test('removeTarget (pulled) stops following that unit; tryAnotherUnit switches', () {
      final e = LocateEngine(targets: [_a, _b]);
      _feed(e, _a, 0, 1000, rssi: -50);
      _feed(e, _b, 0, 1000, rssi: -70);
      expect(e.tick(1000).followedEpc, _a);
      e.tryAnotherUnit(1000);
      expect(e.followed, _b);
      e.removeTarget(_b);
      expect(e.targets.contains(_b), isFalse);
      expect(e.add(_obs(_b, 1100)), isFalse);
    });
  });

  group('Narrowing', () {
    test('accepted only when heard in 3 of 4 windows at the new power', () {
      final e = LocateEngine(targets: [_a]);
      e.resetForGeneration(2);
      final trial = NarrowTrial(fromDbm: 30, toDbm: 25, startedMs: 0);
      _feed(e, _a, 0, 1200, stepMs: 30, gen: 2);
      expect(trial.decide(e, 500, _a), isNull);
      expect(trial.decide(e, 1200, _a), isTrue);
    });

    test('rejected when the tag goes quiet at the lower power', () {
      final e = LocateEngine(targets: [_a]);
      final trial = NarrowTrial(fromDbm: 30, toDbm: 25, startedMs: 0);
      _feed(e, _a, 0, 150, gen: 0);
      expect(trial.decide(e, 1200, _a), isFalse);
    });

    test('power ladder uses the reader\'s real levels', () {
      final levels = [for (var d = 10; d <= 30; d++) d];
      expect(nextPowerDown(levels, 30), 25);
      expect(nextPowerDown(levels, 15), 10);
      expect(nextPowerDown(levels, 10), isNull);
      expect(nextPowerUp(levels, 20), 25);
      expect(nextPowerDown(const [], 30), isNull);
    });
  });

  group('SweepEstimator', () {
    /// Calibrate by turning right (+yaw), then sweep [passes] times across
    /// −60..+60 with the strongest signal near +45 (operator's right).
    SweepEstimator sweep({int passes = 3, int sign = 1, double peakDeg = 45}) {
      final s = SweepEstimator();
      var t = 0;
      var yaw = 100.0;
      void at(double rel, {bool read = true}) {
        t += 50;
        yaw = 100 + 20 * sign + rel * sign;
        s.onYaw(yaw, t);
        s.calibrate();
        if (read && s.calibrated) {
          final rssi = (-50 - (rel - peakDeg).abs() / 3).round();
          s.onSignal(rssi);
        }
      }

      // Calibration: turn 20° right slowly.
      for (var d = 0.0; d <= 20; d += 2) {
        t += 50;
        s.onYaw(100 + d * sign, t);
        s.calibrate();
      }
      var rel = 0.0;
      var dir = 1;
      var p = 0;
      while (p < passes) {
        rel += 2.0 * dir;
        at(rel);
        if (rel >= 60 && dir == 1) {
          dir = -1;
          p++;
        } else if (rel <= -60 && dir == -1) {
          dir = 1;
          p++;
        }
      }
      // A little past the reversal so the last pass registers.
      for (var k = 0; k < 15; k++) {
        rel += 2.0 * dir;
        at(rel);
      }
      return s;
    }

    test('needs calibration first', () {
      expect(SweepEstimator().result().status, SweepStatus.calibrating);
    });

    test('two agreeing passes name the side, whatever the sensor sign', () {
      for (final sign in [1, -1]) {
        final s = sweep(sign: sign);
        final r = s.result();
        expect(r.status, SweepStatus.found, reason: 'sign $sign');
        expect(r.bestRelativeDeg, greaterThan(20));
        expect(r.instruction(-40), contains('RIGHT'));
        expect(r.instruction(r.bestRelativeDeg), contains('straight ahead'));
      }
    });

    test('flat field = direction unclear, never a guess', () {
      final s = SweepEstimator();
      var t = 0;
      for (var d = 0.0; d <= 20; d += 2) {
        t += 50;
        s.onYaw(100 + d, t);
        s.calibrate();
      }
      var rel = 0.0;
      var dir = 1;
      for (var i = 0; i < 400; i++) {
        rel += 2.0 * dir;
        if (rel >= 60) dir = -1;
        if (rel <= -60) dir = 1;
        t += 50;
        s.onYaw(120 + rel, t);
        s.onSignal(-60);
      }
      expect(s.passes, greaterThanOrEqualTo(2));
      expect(s.result().status, isNot(SweepStatus.found));
    });
  });
}
