import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart' show MethodChannel, MissingPluginException, PlatformException;

// Shared scan-event audio cues used by any RFID scanning screen (Count, Encode, …).
//
// All five cues go through a single native Android SoundPool via the
// `carbon_wms/scan_sound` MethodChannel. Pre-decoded to PCM at init time, so every
// [play] fires through the kernel mixer with sub-millisecond latency and overlapping
// cues mix rather than cut each other off.
//
// There is intentionally NO Dart audioplayers fallback on this path: mixing engines
// caused three independent regressions this session —
//   - audioplayers AudioFocus callbacks starved the UI thread
//   - MediaPlayer state machine silently no-op'd on second plays
//   - audioplayers PlayerMode.lowLatency rejected our short MP3s
// One engine, one code path, predictable behaviour.
//
// Cue → asset mapping lives in the native ScanSoundPool.
enum ScanCue { read, success, error, start, stop }

class ScanSounds {
  static final ScanSounds instance = ScanSounds._();
  ScanSounds._();

  static const MethodChannel _channel = MethodChannel('carbon_wms/scan_sound');

  bool _ready = false;
  Future<void>? _initFuture;

  Future<void> init() => _initFuture ??= _doInit();

  Future<void> _doInit() async {
    try {
      final ok = await _channel.invokeMethod<bool>('init');
      _ready = ok == true;
      debugPrint('[ScanSounds] native SoundPool init -> $_ready');
    } on MissingPluginException {
      _ready = false;
      debugPrint('[ScanSounds] native channel missing (not Android? test?)');
    } on PlatformException catch (e) {
      _ready = false;
      debugPrint('[ScanSounds] native init PlatformException: ${e.message}');
    } catch (e) {
      _ready = false;
      debugPrint('[ScanSounds] native init failed: $e');
    }
  }

  // Fire-and-forget. Safe before init completes (becomes a no-op on the native side).
  // [volume] defaults to 1.0 (full), clamped 0..1 by the native layer.
  void play(ScanCue cue, {double volume = 1.0}) {
    if (!_ready) return;
    _channel.invokeMethod<void>('playCue', <String, dynamic>{
      'cue': _cueKey(cue),
      'volume': volume.clamp(0.0, 1.0),
    }).catchError((_) {});
  }

  /// Kill every in-flight stream immediately. Used on pause / popup-open so read
  /// clicks don't bleed over success/error cues.
  void stopAll() {
    if (!_ready) return;
    _channel.invokeMethod<void>('stopAll').catchError((_) {});
  }

  Future<void> dispose() async {
    try { await _channel.invokeMethod<void>('dispose'); } catch (_) {/* ignore */}
    _ready = false;
    _initFuture = null;
  }

  static String _cueKey(ScanCue cue) {
    switch (cue) {
      case ScanCue.read:    return 'read';
      case ScanCue.start:   return 'start';
      case ScanCue.stop:    return 'stop';
      case ScanCue.success: return 'success';
      case ScanCue.error:   return 'error';
    }
  }
}
