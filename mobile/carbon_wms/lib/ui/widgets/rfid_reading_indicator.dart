// Visual-only "the radio is reading" cue for the add-on screens (no sound, no
// haptics). Add-On Count / Add-On Catalog stay silent while passing known
// stock, which looked like a frozen scanner; this chip shows reads are
// arriving even when none of them is new.

import 'dart:async';
import 'dart:collection';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:carbon_wms/services/live_catalog_models.dart';
import 'package:carbon_wms/theme/app_theme.dart';

/// Cheap per-read marker: screens call mark() on EVERY raw tag read (known/ignored ones
/// included) — it only stores a timestamp and bumps a counter; no notify, no setState.
class RfidReadPulse {
  // Monotonic and allocation-free (a DateTime per read adds up on a dense pass).
  static final Stopwatch _clock = Stopwatch()..start();

  /// Current time on the clock [lastReadMs] uses.
  static int nowMs() => _clock.elapsedMilliseconds;

  int _lastReadMs = -1;
  int _readsTotal = 0;

  void mark() {
    _lastReadMs = _clock.elapsedMilliseconds;
    _readsTotal++;
  }

  /// [nowMs] value of the latest read, -1 when none since the last [reset].
  int get lastReadMs => _lastReadMs;
  int get readsTotal => _readsTotal;

  void reset() {
    _lastReadMs = -1;
    _readsTotal = 0;
  }
}

class RfidReadingIndicator extends StatefulWidget {
  const RfidReadingIndicator({
    super.key,
    required this.scanning,
    required this.pulse,
    this.catalogSync,
    this.padding,
  });

  final bool scanning;
  final RfidReadPulse pulse;
  final ValueListenable<LiveCatalogSyncState>? catalogSync;

  /// Outer padding; defaults to 12w × 6h.
  final EdgeInsetsGeometry? padding;

  @override
  State<RfidReadingIndicator> createState() => _RfidReadingIndicatorState();
}

enum _Mode { idle, reading, quiet }

class _RfidReadingIndicatorState extends State<RfidReadingIndicator>
    with SingleTickerProviderStateMixin {
  static const Duration _tick = Duration(milliseconds: 200);
  static const int _recentReadMs = 600;
  static const int _rateWindowTicks = 5; // 5 × 200 ms = 1 s
  static const Duration _offlineAfter = Duration(seconds: 30);

  static const Color _teal = AppColors.primary;
  static const Color _amber = Color(0xFFE09F1F);
  static const Color _grey = AppColors.textMuted;
  static const Color _warn = Color(0xFFD9534F);

  Timer? _timer;
  late final AnimationController _blink;
  final ListQueue<int> _samples = ListQueue<int>();

  _Mode _mode = _Mode.idle;
  String _label = 'IDLE';
  String _suffix = '';
  bool _suffixIsWarning = false;

  @override
  void initState() {
    super.initState();
    _blink = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 600),
      lowerBound: 0.3,
      upperBound: 1.0,
      value: 1.0,
    );
    widget.catalogSync?.addListener(_onCatalogSync);
    _syncTimer();
    _recompute(initial: true);
  }

  @override
  void didUpdateWidget(covariant RfidReadingIndicator old) {
    super.didUpdateWidget(old);
    if (old.catalogSync != widget.catalogSync) {
      old.catalogSync?.removeListener(_onCatalogSync);
      widget.catalogSync?.addListener(_onCatalogSync);
    }
    if (old.scanning != widget.scanning || old.pulse != widget.pulse) {
      _samples.clear();
      _syncTimer();
    }
    // Parent is rebuilding anyway — refresh fields without a second setState.
    _recompute(initial: true);
  }

  @override
  void dispose() {
    widget.catalogSync?.removeListener(_onCatalogSync);
    _timer?.cancel();
    _blink.dispose();
    super.dispose();
  }

  /// The 200 ms sampler runs only while scanning.
  void _syncTimer() {
    if (widget.scanning) {
      _timer ??= Timer.periodic(_tick, (_) {
        _sample();
        _recompute();
      });
    } else {
      _timer?.cancel();
      _timer = null;
    }
  }

  void _onCatalogSync() => _recompute();

  // Sampled only on the 200 ms tick (never on a parent rebuild) so the rate
  // window stays exactly 1 s.
  void _sample() {
    final total = widget.pulse.readsTotal;
    if (_samples.isNotEmpty && total < _samples.last) _samples.clear(); // pulse was reset
    _samples.addLast(total);
    while (_samples.length > _rateWindowTicks + 1) {
      _samples.removeFirst();
    }
  }

  int _readsPerSecond() {
    if (_samples.length < 2) return 0;
    final spanMs = (_samples.length - 1) * _tick.inMilliseconds;
    return ((_samples.last - _samples.first) * 1000 / spanMs).round();
  }

  void _recompute({bool initial = false}) {
    if (!mounted) return;
    _Mode mode;
    String label;
    if (!widget.scanning) {
      mode = _Mode.idle;
      label = 'IDLE';
    } else {
      final rate = _readsPerSecond();
      final last = widget.pulse.lastReadMs;
      final recent = last >= 0 && RfidReadPulse.nowMs() - last <= _recentReadMs;
      if (recent) {
        mode = _Mode.reading;
        label = 'READING · ${rate < 1 ? 1 : rate}/s';
      } else {
        mode = _Mode.quiet;
        label = 'SCANNING · no tags in range';
      }
    }

    var suffix = '';
    var warning = false;
    final sync = widget.catalogSync?.value;
    if (sync != null) {
      if (sync.phase == LiveCatalogPhase.loading) {
        suffix = ' · LOADING CATALOG…';
      } else if (sync.error != null) {
        final last = sync.lastSyncedAt;
        if (last == null) {
          suffix = ' · CATALOG OFFLINE';
          warning = true;
        } else {
          final age = DateTime.now().difference(last);
          if (age > _offlineAfter) {
            suffix = ' · CATALOG OFFLINE (synced ${_ago(age)} ago)';
            warning = true;
          }
        }
      }
    }

    if (mode != _mode) {
      if (mode == _Mode.reading) {
        _blink.repeat(reverse: true);
      } else {
        _blink.stop();
        _blink.value = 1.0;
      }
    }
    final changed =
        mode != _mode || label != _label || suffix != _suffix || warning != _suffixIsWarning;
    if (!changed) return;
    void apply() {
      _mode = mode;
      _label = label;
      _suffix = suffix;
      _suffixIsWarning = warning;
    }

    if (initial) {
      apply();
    } else {
      setState(apply);
    }
  }

  static String _ago(Duration d) {
    if (d.inMinutes < 1) return '${d.inSeconds}s';
    if (d.inHours < 1) return '${d.inMinutes}m';
    return '${d.inHours}h';
  }

  @override
  Widget build(BuildContext context) {
    final color = switch (_mode) {
      _Mode.idle => _grey,
      _Mode.reading => _teal,
      _Mode.quiet => _amber,
    };
    final style = GoogleFonts.spaceGrotesk(
      fontSize: 11.sp,
      fontWeight: FontWeight.w700,
      letterSpacing: 1.2,
      color: color,
    );
    return Padding(
      padding: widget.padding ?? EdgeInsets.symmetric(horizontal: 12.w, vertical: 6.h),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Container(
          padding: EdgeInsets.symmetric(horizontal: 10.w, vertical: 5.h),
          decoration: BoxDecoration(
            color: color.withValues(alpha: 0.10),
            border: Border.all(color: color.withValues(alpha: 0.55)),
            borderRadius: BorderRadius.circular(2.r),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              RepaintBoundary(
                child: FadeTransition(
                  opacity: _blink,
                  child: Container(
                    width: 8.r,
                    height: 8.r,
                    decoration: BoxDecoration(color: color, shape: BoxShape.circle),
                  ),
                ),
              ),
              SizedBox(width: 8.w),
              Flexible(
                child: Text.rich(
                  TextSpan(
                    text: _label,
                    style: style,
                    children: [
                      if (_suffix.isNotEmpty)
                        TextSpan(
                          text: _suffix,
                          style: style.copyWith(color: _suffixIsWarning ? _warn : _grey),
                        ),
                    ],
                  ),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
