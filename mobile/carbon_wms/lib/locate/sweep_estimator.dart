/// Locate 2.0 stage E — guided sweep.
///
/// The operator stands still and sweeps the reader slowly left↔right. Each
/// valid-RSSI read of the followed tag is paired with the phone's heading AT
/// RECEIPT, but only while the phone is turning slowly (≤ [maxTurnDegPerSec]),
/// so a read that left the tag a few tens of milliseconds earlier still lands
/// in the right 30° sector. Evidence is grouped into broad sectors; a side is
/// named only when TWO passes agree and the best sector clearly beats the
/// runner-up. Otherwise the answer is "Direction unclear".
///
/// Left/right is not assumed from the sensor's sign: [calibrate] learns it from
/// a "turn to your right" step at the start of every sweep.
class SweepEstimator {
  SweepEstimator({
    this.sectorDeg = 30,
    this.minPassArcDeg = 60,
    this.maxTurnDegPerSec = 60,
    this.marginDb = 3,
  });

  final double sectorDeg;
  final double minPassArcDeg;
  final double maxTurnDegPerSec;
  final double marginDb;

  double? _origin; // heading at sweep start (raw degrees)
  int _sign = 0; // +1 / -1 once calibrated: raw yaw delta × sign = "to the right"
  double? _calibStart;

  double? _lastYaw;
  int _lastYawMs = 0;
  double _turnRate = 999;

  // Pass tracking (in calibrated relative degrees, + = right).
  double? _passMin;
  double? _passMax;
  int _passDir = 0;
  int passes = 0;

  /// sector index → list of (pass, rssi)
  final Map<int, List<(int, int)>> _samples = <int, List<(int, int)>>{};
  final Set<int> covered = <int>{};

  bool get calibrated => _sign != 0;

  void reset() {
    _origin = null;
    _sign = 0;
    _calibStart = null;
    _lastYaw = null;
    _turnRate = 999;
    _passMin = null;
    _passMax = null;
    _passDir = 0;
    passes = 0;
    _samples.clear();
    covered.clear();
  }

  static double _wrap(double d) {
    var x = d % 360;
    if (x > 180) x -= 360;
    if (x < -180) x += 360;
    return x;
  }

  /// Relative heading (+ = operator's right of where the sweep started).
  double? get relativeHeading {
    if (_origin == null || _lastYaw == null || _sign == 0) return null;
    return _wrap(_lastYaw! - _origin!) * _sign;
  }

  /// Feed a heading sample from the motion sensor.
  void onYaw(double yawDeg, int nowMs) {
    if (_lastYaw != null) {
      final dt = (nowMs - _lastYawMs) / 1000.0;
      if (dt > 0) {
        final inst = _wrap(yawDeg - _lastYaw!).abs() / dt;
        _turnRate = _turnRate == 999 ? inst : _turnRate * 0.7 + inst * 0.3;
      }
    }
    _lastYaw = yawDeg;
    _lastYawMs = nowMs;
    _origin ??= yawDeg;
    _calibStart ??= yawDeg;

    final rel = relativeHeading;
    if (rel == null) return;
    // Pass detection: a pass ends when the sweep reverses after ≥ minPassArc.
    _passMin = _passMin == null ? rel : (rel < _passMin! ? rel : _passMin);
    _passMax = _passMax == null ? rel : (rel > _passMax! ? rel : _passMax);
    final arc = _passMax! - _passMin!;
    if (_passDir == 0) {
      if (rel >= _passMax! && arc > 10) _passDir = 1;
      if (rel <= _passMin! && arc > 10) _passDir = -1;
    } else if (arc >= minPassArcDeg) {
      final reversed = _passDir > 0 ? (_passMax! - rel) > 20 : (rel - _passMin!) > 20;
      if (reversed) {
        passes++;
        _passDir = -_passDir;
        _passMin = rel;
        _passMax = rel;
      }
    }
  }

  /// Calibration: called while the operator is asked to turn RIGHT. Once the
  /// heading has moved ≥ 15°, the direction of that move defines "right".
  /// Returns true when calibrated.
  bool calibrate() {
    if (_sign != 0) return true;
    if (_calibStart == null || _lastYaw == null) return false;
    final d = _wrap(_lastYaw! - _calibStart!);
    if (d.abs() < 15) return false;
    _sign = d > 0 ? 1 : -1;
    _origin = _lastYaw; // start the sweep from here
    _passMin = null;
    _passMax = null;
    _passDir = 0;
    return true;
  }

  /// Feed one valid-RSSI read of the followed tag.
  void onSignal(int rssi) {
    final rel = relativeHeading;
    if (rel == null) return;
    if (_turnRate > maxTurnDegPerSec) return; // too fast to trust the pairing
    final sector = (rel / sectorDeg).floor();
    covered.add(sector);
    final list = _samples.putIfAbsent(sector, () => <(int, int)>[]);
    list.add((passes, rssi));
    if (list.length > 400) list.removeRange(0, 200);
  }

  bool get turningTooFast => _turnRate != 999 && _turnRate > maxTurnDegPerSec;

  static double? _median(List<int> v) {
    if (v.length < 3) return null;
    final s = [...v]..sort();
    return s[s.length ~/ 2].toDouble();
  }

  int? _bestSectorForPass(int pass) {
    int? best;
    double bestMed = -999;
    _samples.forEach((sector, list) {
      final m = _median([for (final s in list) if (s.$1 == pass) s.$2]);
      if (m != null && m > bestMed) {
        bestMed = m;
        best = sector;
      }
    });
    return best;
  }

  /// The current answer.
  SweepResult result() {
    if (!calibrated) return const SweepResult(SweepStatus.calibrating);
    if (passes < 2) return SweepResult(SweepStatus.collecting, passes: passes);
    final a = _bestSectorForPass(passes - 1);
    final b = _bestSectorForPass(passes - 2);
    if (a == null || b == null || (a - b).abs() > 1) {
      return SweepResult(SweepStatus.unclear, passes: passes);
    }
    // Combined medians: best must beat the best non-adjacent runner-up.
    final meds = <int, double>{};
    _samples.forEach((sector, list) {
      final m = _median([for (final s in list) s.$2]);
      if (m != null) meds[sector] = m;
    });
    final bestSector = meds.entries.reduce((x, y) => x.value >= y.value ? x : y).key;
    double runner = -999;
    meds.forEach((sector, m) {
      if ((sector - bestSector).abs() > 1 && m > runner) runner = m;
    });
    if (runner > -999 && meds[bestSector]! - runner < marginDb) {
      return SweepResult(SweepStatus.unclear, passes: passes);
    }
    final centre = (bestSector + 0.5) * sectorDeg;
    return SweepResult(SweepStatus.found, passes: passes, bestRelativeDeg: centre);
  }
}

enum SweepStatus { calibrating, collecting, unclear, found }

class SweepResult {
  const SweepResult(this.status, {this.passes = 0, this.bestRelativeDeg});

  final SweepStatus status;
  final int passes;

  /// Centre of the strongest sector, degrees right (+) / left (−) of the sweep start.
  final double? bestRelativeDeg;

  /// Plain words relative to where the operator is pointing now.
  String instruction(double? currentRelativeDeg) {
    switch (status) {
      case SweepStatus.calibrating:
        return 'Turn slightly to your RIGHT';
      case SweepStatus.collecting:
        return 'Sweep slowly left ↔ right · pass ${passes + 1} of 2';
      case SweepStatus.unclear:
        return 'Direction unclear — move sideways and sweep again';
      case SweepStatus.found:
        final cur = currentRelativeDeg;
        if (cur == null || bestRelativeDeg == null) return 'Strongest signal found';
        var d = bestRelativeDeg! - cur;
        if (d > 180) d -= 360;
        if (d < -180) d += 360;
        if (d.abs() <= 20) return 'Strongest signal straight ahead';
        return d > 0 ? 'Strongest signal to your RIGHT' : 'Strongest signal to your LEFT';
    }
  }
}
