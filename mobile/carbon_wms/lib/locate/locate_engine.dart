import 'dart:math' as math;

/// Locate 2.0 — the measurement engine (pure Dart, no Flutter, no platform).
///
/// Rules this engine enforces (docs/LOCATE_TAG_PRECISION_PLAN.md):
///  * EXACT identity. A read counts only if its EPC is exactly one of the
///    targets. No suffix matching; a read whose id is not a clean 24-hex EPC is
///    counted as an identity/format error, never as the target.
///  * FRESH evidence. Reads stamped with an older generation (taken before the
///    last acknowledged power change / mode start) are dropped. Every reading
///    ages out; nothing "stays hot" after the tag goes quiet.
///  * NO invented strength. A read without RSSI proves the tag was detected,
///    nothing more — it never feeds the signal level.
///  * "Signal" is a plain strength scale at ONE applied power. It is not a
///    distance, not a closeness percentage and not a confidence.
class LocateObservation {
  const LocateObservation({
    required this.epc,
    required this.receivedMs,
    this.rssi,
    this.generation,
    this.relativeProximity,
    this.formatError = false,
  });

  /// Exact 24-hex EPC, or the raw id when [formatError].
  final String epc;
  final int receivedMs;
  final int? rssi;
  final int? generation;
  final int? relativeProximity;
  final bool formatError;
}

/// Evidence about one EPC under the current settings.
class TagEvidence {
  TagEvidence(this.epc);

  final String epc;

  /// (timeMs, rssi) — valid RSSI only.
  final List<(int, int)> rssi = <(int, int)>[];

  /// Detection times (any read of this EPC, with or without RSSI).
  final List<int> seen = <int>[];

  /// Latest Zebra relative proximity (native locate mode) and when.
  int? relativeProximity;
  int relativeAtMs = 0;

  int get lastSeenMs => seen.isEmpty ? 0 : seen.last;

  void prune(int nowMs, int keepMs) {
    final cut = nowMs - keepMs;
    while (rssi.isNotEmpty && rssi.first.$1 < cut) {
      rssi.removeAt(0);
    }
    while (seen.isNotEmpty && seen.first < cut) {
      seen.removeAt(0);
    }
  }

  /// Median of valid RSSI in the last [windowMs], or null.
  int? medianRssi(int nowMs, int windowMs) {
    final cut = nowMs - windowMs;
    final v = <int>[for (final r in rssi) if (r.$1 >= cut) r.$2]..sort();
    if (v.isEmpty) return null;
    return v[v.length ~/ 2];
  }

  /// Reads (any) in the last [windowMs].
  int readsIn(int nowMs, int windowMs) {
    final cut = nowMs - windowMs;
    var n = 0;
    for (var i = seen.length - 1; i >= 0 && seen[i] >= cut; i--) {
      n++;
    }
    return n;
  }

  /// Of the last [count] windows of [windowMs], how many contain a read.
  int windowsWithReads(int nowMs, {int count = 4, int windowMs = 250}) {
    var hits = 0;
    for (var w = 0; w < count; w++) {
      final hi = nowMs - w * windowMs;
      final lo = hi - windowMs;
      for (var i = seen.length - 1; i >= 0; i--) {
        final t = seen[i];
        if (t < lo) break;
        if (t <= hi) {
          hits++;
          break;
        }
      }
    }
    return hits;
  }
}

/// What the operator should be told right now.
enum LocatePresence {
  /// Scanning, target not heard (a missed read does not prove it is absent).
  searching,

  /// Target heard, but the reader gave no strength for it recently.
  detectedNoStrength,

  /// Target heard with valid strength.
  detected,
}

class LocateEngine {
  LocateEngine({
    required Iterable<String> targets,
    this.freshMs = 700,
    this.signalWindowMs = 200,
    this.floorDbm = -82,
    this.ceilDbm = -32,
  }) : _targets = {for (final t in targets) t.trim().toUpperCase()};

  /// Evidence older than this is not live (plan: clear within 500–750 ms).
  final int freshMs;

  /// Window the signal median is taken over.
  final int signalWindowMs;

  /// Signal scale: [floorDbm] → 0, [ceilDbm] → 1. A display scale only.
  final int floorDbm;
  final int ceilDbm;

  final Set<String> _targets;
  final Map<String, TagEvidence> _evidence = <String, TagEvidence>{};

  /// Reads with an older generation than this are discarded.
  int _acceptGeneration = 0;

  int formatErrors = 0;
  int staleDropped = 0;
  int otherTagReads = 0;
  int targetReads = 0;
  int nullRssiTargetReads = 0;
  int locReads = 0; // target reads carrying Zebra relative proximity

  /// Smoothed display signal 0..1 for the followed tag (EMA).
  double _smoothed = 0;
  int _lastSmoothMs = 0;

  /// Signal history for the strip: (timeMs, level 0..1 or null = not heard).
  final List<(int, double?)> history = <(int, double?)>[];

  // Any-unit candidate following.
  String? _followed;
  String? _challenger;
  int _challengerSinceMs = 0;

  Set<String> get targets => Set.unmodifiable(_targets);
  String? get followed => _followed;
  int get acceptGeneration => _acceptGeneration;

  /// Remove a target (e.g. a unit already pulled).
  void removeTarget(String epc) {
    final e = epc.toUpperCase();
    _targets.remove(e);
    _evidence.remove(e);
    if (_followed == e) {
      _followed = null;
      _smoothed = 0;
    }
  }

  /// Start accepting only reads from [generation] onwards and forget all
  /// evidence — called after every acknowledged power change / mode start.
  void resetForGeneration(int? generation) {
    if (generation != null) _acceptGeneration = generation;
    _evidence.clear();
    _smoothed = 0;
    _lastSmoothMs = 0;
    _challenger = null;
  }

  /// Forget evidence without changing the accepted generation (pause, new sweep).
  void clearEvidence() => resetForGeneration(null);

  /// Feed one read. Returns true if it was evidence for a target.
  bool add(LocateObservation o) {
    if (o.formatError) {
      formatErrors++;
      return false;
    }
    if (o.generation != null && o.generation! < _acceptGeneration) {
      staleDropped++;
      return false;
    }
    if (!_targets.contains(o.epc)) {
      otherTagReads++;
      return false;
    }
    targetReads++;
    final ev = _evidence.putIfAbsent(o.epc, () => TagEvidence(o.epc));
    ev.seen.add(o.receivedMs);
    final r = o.rssi;
    if (r != null && r < 0 && r > -110) {
      ev.rssi.add((o.receivedMs, r));
    } else {
      nullRssiTargetReads++;
    }
    if (o.relativeProximity != null) {
      locReads++;
      ev.relativeProximity = o.relativeProximity!.clamp(0, 100);
      ev.relativeAtMs = o.receivedMs;
    }
    if (ev.seen.length > 2000) ev.seen.removeRange(0, 1000);
    if (ev.rssi.length > 2000) ev.rssi.removeRange(0, 1000);
    return true;
  }

  double levelFromDbm(int dbm) =>
      ((dbm - floorDbm) / (ceilDbm - floorDbm)).clamp(0.0, 1.0);

  TagEvidence? evidenceFor(String epc) => _evidence[epc.toUpperCase()];

  /// Choose which target to follow (any-unit mode) — the strongest freshly
  /// heard tag, switching only when another is clearly better for >1.5 s or
  /// the current one has gone quiet. Single-target mode always follows it.
  void _chooseFollowed(int nowMs) {
    if (_targets.length == 1) {
      _followed = _targets.first;
      return;
    }
    double score(TagEvidence e) {
      final m = e.medianRssi(nowMs, 600);
      final s = m == null ? 0.15 : levelFromDbm(m);
      final rate = (e.windowsWithReads(nowMs) / 4.0);
      return s * 0.7 + rate * 0.3;
    }

    TagEvidence? best;
    double bestScore = -1;
    for (final e in _evidence.values) {
      if (nowMs - e.lastSeenMs > freshMs) continue;
      final sc = score(e);
      if (sc > bestScore) {
        bestScore = sc;
        best = e;
      }
    }
    final cur = _followed == null ? null : _evidence[_followed!];
    final curFresh = cur != null && nowMs - cur.lastSeenMs <= 1500;
    if (best == null) {
      if (!curFresh) _followed = null;
      return;
    }
    if (!curFresh) {
      if (_followed != best.epc) _smoothed = 0;
      _followed = best.epc;
      _challenger = null;
      return;
    }
    if (best.epc == _followed) {
      _challenger = null;
      return;
    }
    if (bestScore > score(cur) + 0.15) {
      if (_challenger != best.epc) {
        _challenger = best.epc;
        _challengerSinceMs = nowMs;
      } else if (nowMs - _challengerSinceMs >= 1500) {
        _followed = best.epc;
        _challenger = null;
        _smoothed = 0; // a different tag's reading must not look like movement
      }
    } else {
      _challenger = null;
    }
  }

  /// Operator asked for another unit: follow the best OTHER fresh candidate.
  void tryAnotherUnit(int nowMs) {
    final skip = _followed;
    String? pick;
    var bestRate = -1;
    for (final e in _evidence.values) {
      if (e.epc == skip) continue;
      final r = e.readsIn(nowMs, 1500);
      if (r > bestRate) {
        bestRate = r;
        pick = e.epc;
      }
    }
    _followed = pick;
    _smoothed = 0;
    _challenger = null;
  }

  /// Advance the engine and return the current view.
  LocateReading tick(int nowMs) {
    for (final e in _evidence.values) {
      e.prune(nowMs, 6000);
    }
    _chooseFollowed(nowMs);
    final ev = _followed == null ? null : _evidence[_followed!];
    final lastSeen = ev?.lastSeenMs ?? 0;
    final fresh = ev != null && nowMs - lastSeen <= freshMs;
    final med = ev?.medianRssi(nowMs, signalWindowMs);
    final freshRssi = med != null &&
        ev!.rssi.isNotEmpty &&
        nowMs - ev.rssi.last.$1 <= freshMs;

    final target = freshRssi ? levelFromDbm(med) : 0.0;
    final dt = _lastSmoothMs == 0 ? 0 : nowMs - _lastSmoothMs;
    _lastSmoothMs = nowMs;
    if (!fresh) {
      _smoothed = 0; // loss clears immediately — no lingering "hot"
    } else if (freshRssi) {
      final tau = target > _smoothed ? 60.0 : 140.0;
      final a = dt <= 0 ? 1.0 : 1 - math.exp(-dt / tau);
      _smoothed += (target - _smoothed) * a;
    }

    final presence = !fresh
        ? LocatePresence.searching
        : (freshRssi ? LocatePresence.detected : LocatePresence.detectedNoStrength);
    final level = presence == LocatePresence.detected ? _smoothed : null;

    history.add((nowMs, level));
    while (history.isNotEmpty && history.first.$1 < nowMs - 5000) {
      history.removeAt(0);
    }

    final relFresh = ev != null &&
        ev.relativeProximity != null &&
        nowMs - ev.relativeAtMs <= freshMs;

    var heard = 0;
    for (final e in _evidence.values) {
      if (nowMs - e.lastSeenMs <= 1500) heard++;
    }

    return LocateReading(
      presence: presence,
      followedEpc: _followed,
      signal: level,
      medianRssi: freshRssi ? med : null,
      relativeProximity: relFresh ? ev.relativeProximity : null,
      readsPerSec: ev?.readsIn(nowMs, 1000) ?? 0,
      windowsHit: ev?.windowsWithReads(nowMs) ?? 0,
      lastSeenAgeMs: ev == null || lastSeen == 0 ? null : nowMs - lastSeen,
      candidatesHeard: heard,
    );
  }
}

/// Immutable snapshot published to the UI each tick.
class LocateReading {
  const LocateReading({
    required this.presence,
    this.followedEpc,
    this.signal,
    this.medianRssi,
    this.relativeProximity,
    this.readsPerSec = 0,
    this.windowsHit = 0,
    this.lastSeenAgeMs,
    this.candidatesHeard = 0,
  });

  static const LocateReading idle = LocateReading(presence: LocatePresence.searching);

  final LocatePresence presence;
  final String? followedEpc;

  /// 0..1 strength at the current applied power; null unless [presence] is detected.
  final double? signal;
  final int? medianRssi;

  /// Zebra native-locate relative value 0-100 (only in that engine).
  final int? relativeProximity;
  final int readsPerSec;

  /// Of the last 4×250 ms windows, how many heard the followed tag.
  final int windowsHit;
  final int? lastSeenAgeMs;
  final int candidatesHeard;

  /// Repeatable detection — the bar for narrowing and for confirming.
  bool get steady => windowsHit >= 3;
}

/// Narrowing: try one lower power; accept it only if the tag is heard in at
/// least 3 of 4 consecutive 250 ms windows after the change was confirmed.
class NarrowTrial {
  NarrowTrial({required this.fromDbm, required this.toDbm, required this.startedMs});

  final int fromDbm;
  final int toDbm;
  final int startedMs;

  /// Decide once ~1.1 s of evidence at the new power exists.
  /// Returns true (accept), false (reject) or null (still collecting).
  bool? decide(LocateEngine engine, int nowMs, String? epc) {
    if (nowMs - startedMs < 1100) return null;
    final ev = epc == null ? null : engine.evidenceFor(epc);
    final hits = ev?.windowsWithReads(nowMs) ?? 0;
    return hits >= 3;
  }
}

/// The next lower / higher supported power step from [levels].
int? nextPowerDown(List<int> levels, int current) {
  final steps = _ladder(levels);
  for (final s in steps.reversed) {
    if (s < current) return s;
  }
  return null;
}

int? nextPowerUp(List<int> levels, int current) {
  for (final s in _ladder(levels)) {
    if (s > current) return s;
  }
  return null;
}

/// Coarse steps first (30/25/20/15/10/5 where supported), plus the reader's
/// own minimum — the real levels come from the connected reader at runtime.
List<int> _ladder(List<int> levels) {
  if (levels.isEmpty) return const [];
  final sorted = [...levels]..sort();
  final mn = sorted.first;
  final mx = sorted.last;
  final out = <int>{};
  for (final want in const [30, 25, 20, 15, 10, 5]) {
    if (want < mn || want > mx) continue;
    var best = sorted.first;
    for (final v in sorted) {
      if ((v - want).abs() < (best - want).abs()) best = v;
    }
    out.add(best);
  }
  out
    ..add(mn)
    ..add(mx);
  return out.toList()..sort();
}
