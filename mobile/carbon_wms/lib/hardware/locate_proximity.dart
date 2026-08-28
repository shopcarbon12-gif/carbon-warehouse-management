/// Proximity model for Locate/Geiger — derived from measured Tag Test data,
/// not from theory.
///
/// ## Why this is built on transmit power rather than signal strength
///
/// Two Tag Test runs (2026-08-28, RFD8500 + Motorola Edge 5G UW, two different
/// tags on garments) measured signal strength against distance at six power
/// levels. Two things came out of it that decide the whole design:
///
/// **1. Signal strength is blind in the near zone.** At contact, dropping the
/// transmit power by 25 dB moved the reading by 1 dB (−21 → −22 on both tags).
/// The receiver is simply pinned. Across the first two feet the reading moves
/// about 3 dB, which is inside the noise. So in the last two feet — precisely
/// where an operator needs precision — signal strength carries no usable
/// distance information at any power.
///
/// **2. Signal strength is ambiguous in the far zone.** Multipath nulls make
/// it non-monotonic: tag B read ≈−46 dBm at 4 ft, 7 ft AND 8 ft. Tag A read
/// ≈−49 at both 5 ft and 7 ft. Read counts swung from 4 to 322 between
/// adjacent steps.
///
/// What WAS clean and monotonic was the lowest power at which the tag could
/// still be heard:
///
/// ```
///            0 ft   1 ft   2 ft   3 ft   4 ft+
///   Tag A      5      5     15     25    25-30
///   Tag B      5      5     10     20    25-30
/// ```
///
/// That is a *threshold* test rather than a measurement, which is why it
/// survives both problems: it doesn't care that the receiver is saturated, and
/// it doesn't care that a null knocked 10 dB off one particular reading. It
/// was also consistent across two tags where the raw readings were not — at
/// 1 ft and 5 dBm the two tags differed by 14 dB, yet both were heard at
/// 5 dBm and both went silent at 2 ft.
///
/// So: the rung does the near work, where signal strength is blind, and signal
/// strength does the far work, where the ladder has run out of rungs.
library;

/// Transmit power rungs, strongest first. Index 0 is full power.
const List<int> kLocateRungsDbm = <int>[30, 25, 20, 15, 10, 5];

/// Percentage band owned by each rung, indexed to match [kLocateRungsDbm].
///
/// Edges come from the measured distances each rung corresponds to:
/// only-at-30 is 5-13 ft, 25 is 3-8 ft, 20 is 3 ft, 15 is 2 ft, 10 is 2 ft,
/// and 5 dBm means 0-1 ft. Bands are contiguous, so stepping down lands on the
/// floor of the new band, which is the ceiling of the old one — the number can
/// never jump backwards when the power changes.
const List<({double lo, double hi})> kLocateRungBands = <({double lo, double hi})>[
  (lo: 0.00, hi: 0.35), // 30 dBm only  — 5-13 ft
  (lo: 0.35, hi: 0.60), // 25 dBm       — 3-8 ft
  (lo: 0.60, hi: 0.75), // 20 dBm       — 3 ft
  (lo: 0.75, hi: 0.84), // 15 dBm       — 2 ft
  (lo: 0.84, hi: 0.90), // 10 dBm       — 2 ft
  (lo: 0.90, hi: 1.00), // 5 dBm        — 0-1 ft
];

/// Signal-strength window used to position the meter WITHIN a rung's band.
///
/// One window for every rung on purpose. Within a band the rung has already
/// established roughly where you are; this only spreads the number across that
/// band so it keeps moving as you walk, instead of sitting frozen until the
/// next rung change. The measured data supports it — at 25 dBm the reading
/// ran −40 dBm at 3 ft down to −63 dBm at 9 ft — but the rung is what carries
/// the actual distance claim, so precision here is not critical.
const double kRungWeakDbm = -62;
const double kRungStrongDbm = -30;

/// Position within a rung's band, 0..1, from a raw signal reading.
double rungFraction(int? rssi) {
  if (rssi == null) return 0;
  const span = kRungStrongDbm - kRungWeakDbm;
  return ((rssi - kRungWeakDbm) / span).clamp(0.0, 1.0);
}

/// Overall 0..1 proximity for a rung and the strength heard at that rung.
///
/// Monotonic by construction: every rung's band sits entirely above the band
/// of the rung above it, so getting closer can only ever raise the number.
double proximityFor(int rungIndex, int? rssi) {
  final i = rungIndex.clamp(0, kLocateRungBands.length - 1);
  final band = kLocateRungBands[i];
  return (band.lo + (band.hi - band.lo) * rungFraction(rssi)).clamp(0.0, 1.0);
}

/// Human label for what a rung means in distance, for the diagnostic line.
String rungDistanceHint(int rungIndex) {
  switch (rungIndex.clamp(0, kLocateRungsDbm.length - 1)) {
    case 5:
      return 'WITHIN ~1 FT';
    case 4:
    case 3:
      return '~2 FT';
    case 2:
      return '~3 FT';
    case 1:
      return '3-8 FT';
    default:
      return '5 FT+';
  }
}

/// Where the current reading sits against the best of the last few seconds.
///
/// The sensor-free half of direction finding: it needs no orientation at all,
/// only the signal's own history, so it still works when the phone is not
/// rigidly attached to the sled and device yaw is therefore meaningless.
enum HotCold { hottest, warm, colder }

/// Classify [proximity] against [sweepPeak] with HYSTERESIS.
///
/// [previous] is what the operator is currently being shown. Without it, this
/// was a bare ratio republished ten times a second, so any dip flipped the
/// word and the next reading flipped it back — the display changed faster than
/// it could be read. Each state now has a wider band to leave than to enter,
/// so a signal hovering near a boundary stays put instead of chattering.
HotCold hotColdFrom(double proximity, double sweepPeak, {HotCold? previous}) {
  if (sweepPeak <= 0) return HotCold.warm;
  final ratio = (proximity / sweepPeak).clamp(0.0, 2.0);
  switch (previous) {
    case HotCold.hottest:
      // Already claiming "hottest" — hold it until clearly off the peak.
      if (ratio >= 0.80) return HotCold.hottest;
      return ratio >= 0.62 ? HotCold.warm : HotCold.colder;
    case HotCold.colder:
      // Already claiming "colder" — needs a real recovery to climb back.
      if (ratio >= 0.92) return HotCold.hottest;
      return ratio >= 0.82 ? HotCold.warm : HotCold.colder;
    case HotCold.warm:
    case null:
      if (ratio >= 0.92) return HotCold.hottest;
      return ratio >= 0.70 ? HotCold.warm : HotCold.colder;
  }
}
