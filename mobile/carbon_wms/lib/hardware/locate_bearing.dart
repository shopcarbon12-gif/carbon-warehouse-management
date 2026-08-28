/// Direction-finding and distance estimation for the Locate-Tag geiger.
///
/// Pure Dart, no Flutter and no platform calls, so the whole thing is unit
/// testable. The screen feeds it (yaw, power-normalised RSSI) pairs and asks
/// for a fix; everything else here is arithmetic.
///
/// ## Why a sweep is required
///
/// The RFD8500 has ONE antenna. Bearing needs an aperture — two or more
/// elements a known distance apart, so their phase can be compared — which is
/// how a phased-array reader (Zebra's ceiling ATR7000, say) does true
/// angle-of-arrival. A single element cannot resolve angle at all while it is
/// held still, no matter what maths you apply to it.
///
/// What a single element DOES have is a directional antenna: a main lobe out
/// the front of the gun with real front-to-back rejection. So received power
/// is a function of BOTH distance and where the gun is pointing. Rotate the
/// gun, record signal against rotation, and the angle where the signal peaks
/// is the bearing to the tag. That is a synthesised aperture built out of the
/// operator's own sweep, and it is why the UI has to ask for one.
///
/// ## Why yaw comes from the gyro, not the compass
///
/// A magnetometer inside steel racking, next to a transmitting UHF radio and a
/// phone's own speakers, is not trustworthy. We do not need absolute heading
/// anyway — only "the peak was 40° left of where you are pointing right now",
/// which is a difference of two readings taken seconds apart. Android's
/// `GAME_ROTATION_VECTOR` (gyro + accelerometer, magnetometer deliberately
/// excluded) is exactly that: rock-solid over a few seconds, with a slow yaw
/// drift that is irrelevant at this timescale.
library;

import 'dart:math' as math;

/// One angular bin's worth of evidence.
class _Bin {
  _Bin(this.rssi, this.at);
  int rssi;
  DateTime at;
}

/// A usable bearing to the tag.
class BearingFix {
  const BearingFix({
    required this.relativeDeg,
    required this.contrastDb,
    required this.peakRssi,
    required this.coverageDeg,
  });

  /// Where the tag is relative to where the gun currently points.
  /// Negative = left, positive = right, 0 = straight ahead. Range -180..180.
  final double relativeDeg;

  /// Peak minus median across the swept bins. This is the discrimination the
  /// fix is built on — a flat field means the antenna pattern told us nothing.
  final double contrastDb;

  /// Strongest normalised RSSI observed, at the peak bearing.
  final int peakRssi;

  /// How much of the circle the operator actually swept.
  final double coverageDeg;
}

/// Why the estimator can or cannot name a direction right now.
enum BearingReason {
  /// Not enough of an arc swept yet — the operator needs to keep turning.
  needMoreSweep,

  /// Swept plenty, but signal barely varies with heading. Either the tag is so
  /// close that the antenna lobe stops discriminating, or the aisle is
  /// reflective enough that there is no honest peak to point at.
  fieldTooFlat,

  /// Good fix.
  locked,
}

/// Outcome of one bearing evaluation, including the reason when there's no fix.
class BearingResult {
  const BearingResult({
    required this.reason,
    required this.coverageDeg,
    required this.contrastDb,
    this.fix,
  });

  final BearingReason reason;
  final double coverageDeg;
  final double contrastDb;
  final BearingFix? fix;
}

/// Accumulates signal-vs-heading and extracts a bearing once the operator has
/// swept enough of an arc for the answer to mean something.
class BearingEstimator {
  BearingEstimator({
    this.binCount = 36,
    this.ttl = const Duration(seconds: 6),
    this.minCoverageDeg = 60,
    this.minContrastDb = 4,
  }) : assert(binCount > 0);

  /// Angular resolution. 36 bins = 10° each, which is finer than the antenna
  /// lobe can actually resolve but keeps the peak search smooth.
  final int binCount;

  /// How long a bin stays trustworthy. The operator is walking while they
  /// sweep, so evidence gathered from a different spot on the floor is about a
  /// different geometry and has to expire.
  final Duration ttl;

  /// Minimum arc that must have been swept before we will name a direction.
  /// Below this the operator has effectively been standing still, which is the
  /// case a single antenna genuinely cannot answer.
  final double minCoverageDeg;

  /// Minimum peak-to-median spread. This is the anti-multipath guard: in a
  /// steel aisle a reflection off an upright can put a real lobe in the wrong
  /// place, but a genuine line-of-sight peak stands proud of the field. If
  /// nothing stands out we report no fix rather than pointing somewhere wrong.
  ///
  /// 4 dB, not 6: a handheld's front-to-back rejection is 10-20 dB, so a real
  /// sweep past a tag clears this comfortably, while 6 dB was rejecting
  /// legitimate fixes when the operator swept a shallower arc.
  final double minContrastDb;

  final Map<int, _Bin> _bins = <int, _Bin>{};

  double get _binWidth => 360.0 / binCount;

  void reset() => _bins.clear();

  /// Fold one observation in. Keeps the strongest reading per bin — fades are
  /// multipath artefacts, peaks are the honest geometry.
  ///
  /// A bin's age is the age of the READING IT HOLDS, and a weaker read must
  /// never refresh it. Getting that wrong made the estimator destroy itself:
  /// the previous version bumped `at` on every sample regardless of strength,
  /// so a bin's all-time maximum could never expire while the operator kept
  /// sweeping through it. Sweep back and forth a few times and every bin was
  /// pinned at its historical peak, the peak-to-median spread collapsed to
  /// nothing, and the contrast guard rejected everything from then on — a
  /// permanent "OFF DIRECTIONS" that got worse the harder the operator tried.
  void add(double yawDeg, int rssi, DateTime now) {
    final idx = _binOf(yawDeg);
    final existing = _bins[idx];
    if (existing == null || _expired(existing, now) || rssi >= existing.rssi) {
      _bins[idx] = _Bin(rssi, now);
    }
    // Otherwise: a weaker read at a heading we already have a stronger, still
    // fresh reading for. Leave it — and leave its age alone so it expires on
    // schedule and the picture keeps refreshing.
  }

  /// Best available bearing, or null when the evidence doesn't support one.
  BearingFix? fix(double currentYawDeg, DateTime now) =>
      evaluate(currentYawDeg, now).fix;

  /// Like [fix], but also reports WHY there is no fix. The UI surfaces this so
  /// a "no direction" on the floor is self-explaining — needing a wider sweep
  /// and seeing a flat multipath field look identical to the operator
  /// otherwise, and they call for opposite reactions.
  BearingResult evaluate(double currentYawDeg, DateTime now) {
    _bins.removeWhere((_, b) => _expired(b, now));
    final coverage = _bins.length * _binWidth;

    if (_bins.length < 2 || coverage < minCoverageDeg) {
      return BearingResult(
        reason: BearingReason.needMoreSweep,
        coverageDeg: coverage,
        contrastDb: 0,
      );
    }

    var peakIdx = -1;
    var peakRssi = -1000;
    for (final e in _bins.entries) {
      if (e.value.rssi > peakRssi) {
        peakRssi = e.value.rssi;
        peakIdx = e.key;
      }
    }

    final sorted = _bins.values.map((b) => b.rssi).toList()..sort();
    final median = sorted[sorted.length ~/ 2].toDouble();
    final contrast = peakRssi - median;
    if (contrast < minContrastDb) {
      return BearingResult(
        reason: BearingReason.fieldTooFlat,
        coverageDeg: coverage,
        contrastDb: contrast,
      );
    }

    final peakYaw = peakIdx * _binWidth + _binWidth / 2;
    return BearingResult(
      reason: BearingReason.locked,
      coverageDeg: coverage,
      contrastDb: contrast,
      fix: BearingFix(
        relativeDeg: normaliseDeg(peakYaw - currentYawDeg),
        contrastDb: contrast,
        peakRssi: peakRssi,
        coverageDeg: coverage,
      ),
    );
  }

  bool _expired(_Bin b, DateTime now) => now.difference(b.at) > ttl;

  int _binOf(double yawDeg) {
    final wrapped = yawDeg % 360;
    return (wrapped / _binWidth).floor() % binCount;
  }
}

/// Wrap an angle into -180..180, where negative reads as "to the left".
double normaliseDeg(double deg) {
  var x = deg % 360;
  if (x > 180) x -= 360;
  return x;
}

/// Turn a relative bearing into something an operator can act on without
/// doing trigonometry in an aisle.
String turnLabel(double relativeDeg) {
  final a = relativeDeg.abs();
  if (a <= 20) return 'STRAIGHT AHEAD';
  if (a >= 135) return 'TURN AROUND';
  final side = relativeDeg < 0 ? 'LEFT' : 'RIGHT';
  return '$side ${a.round()}°';
}

/// Distance estimate from a power-normalised RSSI, in feet.
///
/// Inverts the backscatter law `P_rx = P_tx + K − 40·log10(d)` against a
/// reference point: [kDistanceRefDbm] is taken to be [kDistanceRefFeet] away.
/// Every 12 dB below that is twice as far.
///
/// This is an ESTIMATE and the UI presents it as one. The constant K folds in
/// the inlay, the tag's orientation, and what it is stuck to — denim absorbs,
/// a metal rail reflects — so two tags at the same distance genuinely read
/// differently. The bucketing in [distanceLabel] is deliberately coarse so the
/// readout never implies precision the physics can't deliver.
const double kDistanceRefDbm = -35.0;
const double kDistanceRefFeet = 1.0;

double estimateFeet(int normalisedRssi) {
  final exponent = (kDistanceRefDbm - normalisedRssi) / 40.0;
  return kDistanceRefFeet * math.pow(10, exponent).toDouble();
}

/// Coarse, honest distance bucket in feet and inches.
///
/// Below about a foot the estimate stops being meaningful: the receiver
/// saturates and the tag is in the antenna's near field, so signal strength
/// no longer grows as you close the last few inches. That band collapses to a
/// single "ON THE TAG" rather than inventing an inch count — the proximity
/// dial and the beep cadence already own the final approach.
String distanceLabel(int? normalisedRssi) {
  if (normalisedRssi == null) return '—';
  final ft = estimateFeet(normalisedRssi);
  // Inclusive: the reference point itself ([kDistanceRefDbm] at one foot) is
  // already inside the saturation band, so it belongs to "on the tag".
  if (ft <= 1.0) return 'ON THE TAG';
  if (ft < 1.6) return '≈ 1 FT';
  if (ft < 2.6) return '≈ 2 FT';
  if (ft < 3.6) return '≈ 3 FT';
  if (ft < 5.0) return '≈ 4 FT';
  if (ft < 7.0) return '≈ 6 FT';
  if (ft < 9.0) return '≈ 8 FT';
  if (ft < 13.0) return '≈ 10 FT';
  return '15+ FT';
}

/// Sub-label for the sub-foot band, so the panel still speaks inches where
/// inches are the natural unit.
String? distanceSubLabel(int? normalisedRssi) {
  if (normalisedRssi == null) return null;
  return estimateFeet(normalisedRssi) <= 1.0 ? 'UNDER 12 IN' : null;
}
