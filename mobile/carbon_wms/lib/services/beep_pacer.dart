import 'dart:async';

import 'package:carbon_wms/services/scan_sounds.dart';

/// One beep per call, never closer than [minGap]; a burst queues at most [maxBacklog]
/// beeps (extra requests are dropped) so a dense pass can't saturate SoundPool or
/// trail seconds behind the tags.
class BeepPacer {
  BeepPacer({
    this.minGap = const Duration(milliseconds: 70),
    this.maxBacklog = 8,
    this.cue = ScanCue.read,
  });

  final Duration minGap;
  final int maxBacklog;
  final ScanCue cue;

  // Monotonic clock: wall-clock jumps (NTP, manual time change) must not
  // stall or burst the pacer.
  final Stopwatch _clock = Stopwatch()..start();
  Duration? _lastPlayAt;
  int _backlog = 0;
  Timer? _timer;
  bool _disposed = false;

  /// Plays immediately if the gap has passed, else queues (≤ [maxBacklog]).
  void request() {
    if (_disposed) return;
    if (_timer != null) {
      // A drain is already scheduled — just queue behind it.
      if (_backlog < maxBacklog) _backlog++;
      return;
    }
    final now = _clock.elapsed;
    final last = _lastPlayAt;
    if (last == null || now - last >= minGap) {
      _play(now);
      return;
    }
    _backlog = 1;
    _timer = Timer(minGap - (now - last), _drain);
  }

  void _drain() {
    _timer = null;
    if (_disposed || _backlog <= 0) return;
    _backlog--;
    _play(_clock.elapsed);
    if (_backlog > 0) _timer = Timer(minGap, _drain);
  }

  void _play(Duration at) {
    _lastPlayAt = at;
    ScanSounds.instance.play(cue);
  }

  /// Drop the backlog (call on STOP).
  void cancel() {
    _timer?.cancel();
    _timer = null;
    _backlog = 0;
  }

  void dispose() {
    cancel();
    _disposed = true;
  }
}
