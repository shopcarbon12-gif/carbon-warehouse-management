import 'dart:async';

import 'package:flutter/foundation.dart';

/// One platform subscription per EventChannel, shared by every Dart listener.
///
/// ## The bug this exists to fix (2026-10-15)
///
/// Flutter's [EventChannel] keeps ONE message handler per channel name. Every
/// `receiveBroadcastStream()` call that gets a listener replaces that handler,
/// and cancelling ANY of them clears it and tells Android to drop its sink
/// (the controller then throws every tag / trigger pull away). Screens each
/// opened their own stream, so:
///
///   * the newest screen's stream silently took the channel from the screen
///     below it, and
///   * when that newest screen closed, NOBODY received anything any more —
///     not the screen you came back to, not RfidManager — until some other
///     screen happened to open a fresh stream.
///
/// Cloud + Geiger → tap a line (Geiger) → back: the trigger and the tag reads
/// were both dead. Proven with the SDK's own EventChannel code under test.
///
/// ## Delivery rule
///
/// Same as the channels behaved while they worked, minus the dead end:
///
///   * Foreground listeners (screens): the NEWEST gets each event. When it
///     cancels, the one below it gets them again.
///   * Background listeners (RfidManager's scanner / fallback-barcode
///     subscriptions): only when no foreground listener exists, and only
///     until the first foreground listener appears after they subscribed.
///     That keeps today's reality — once a screen has taken the channel the
///     manager no longer hears reads — on purpose: RfidManager posts what it
///     hears to edge ingest (stock reconcile), and every screen that runs the
///     radio already has its own foreground listener.
class ChannelFanout<T> {
  ChannelFanout(this._open);

  /// Opens the single platform stream (called again only after the last
  /// listener left, or if the platform ended the stream).
  final Stream<T> Function() _open;

  final List<_FanoutListener<T>> _listeners = <_FanoutListener<T>>[];
  StreamSubscription<T>? _upstream;

  Stream<T> stream({bool background = false}) {
    final entry = _FanoutListener<T>(background);
    entry.controller = StreamController<T>.broadcast(
      sync: true,
      onListen: () {
        if (!background) {
          for (final l in _listeners) {
            if (l.background) l.starved = true;
          }
        }
        _listeners
          ..remove(entry)
          ..add(entry);
        _ensureUpstream();
      },
      onCancel: () {
        _listeners.remove(entry);
        if (_listeners.isEmpty) {
          final up = _upstream;
          _upstream = null;
          unawaited(up?.cancel());
        }
      },
    );
    return entry.controller.stream;
  }

  void _ensureUpstream() {
    _upstream ??= _open().listen(
      (e) => _target?.controller.add(e),
      onError: (Object e, StackTrace st) => _target?.controller.addError(e, st),
      onDone: () {
        _upstream = null;
        if (_listeners.isNotEmpty) _ensureUpstream();
      },
    );
  }

  _FanoutListener<T>? get _target {
    for (var i = _listeners.length - 1; i >= 0; i--) {
      if (!_listeners[i].background) return _listeners[i];
    }
    for (var i = _listeners.length - 1; i >= 0; i--) {
      if (!_listeners[i].starved) return _listeners[i];
    }
    return null;
  }

  @visibleForTesting
  int get listenerCount => _listeners.length;
}

class _FanoutListener<T> {
  _FanoutListener(this.background);

  final bool background;
  bool starved = false;
  late final StreamController<T> controller;
}
