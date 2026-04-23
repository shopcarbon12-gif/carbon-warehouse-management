import 'dart:async';
import 'dart:io';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart'
    show MethodChannel, MissingPluginException, PlatformException, rootBundle;
import 'package:path_provider/path_provider.dart';

// Shared scan-event audio cues used by any RFID scanning screen (Count, Encode, …).
// Senitron MP3s copied verbatim from SenitronRFID-v2.124.0:
//   uhf-start.mp3     -> start
//   uhf-stop.mp3      -> stop
//   uhf-read-tag.mp3  -> read  (native SoundPool preferred, audioplayers fallback)
//   success.mp3       -> success
//   uhf-error.mp3     -> error
//
// [read] goes through a native `android.media.SoundPool` on Android so rapid-fire tag
// sightings get sub-millisecond playback with mixer-level concurrency — matching how
// Senitron plays it. Other cues keep the Dart `audioplayers` path (they don't need
// low latency and each one has a dedicated player so a success chime doesn't truncate
// an in-flight click).
enum ScanCue { read, success, error, start, stop }

class ScanSounds {
  static final ScanSounds instance = ScanSounds._();
  ScanSounds._();

  static const MethodChannel _native = MethodChannel('carbon_wms/scan_sound');

  static const Map<ScanCue, String> _assets = {
    ScanCue.read:    'sounds/uhf-read-tag.mp3',
    ScanCue.success: 'sounds/success.mp3',
    ScanCue.error:   'sounds/uhf-error.mp3',
    ScanCue.start:   'sounds/uhf-start.mp3',
    ScanCue.stop:    'sounds/uhf-stop.mp3',
  };

  /// True once the native SoundPool has loaded the read-tag asset. While false
  /// (or on iOS / tests where the channel isn't registered), [play(read)] falls
  /// back to the audioplayers pool path below.
  bool _nativeReadReady = false;

  /// Fallback pool used by [play(read)] only when the native SoundPool couldn't
  /// be constructed (e.g. running in an emulator with a dead media HAL).
  AudioPool? _readFallbackPool;

  /// One dedicated player per non-read cue. Pre-warmed with [setSource] so the
  /// first fire has the same latency as the hundredth.
  final Map<ScanCue, AudioPlayer> _players = <ScanCue, AudioPlayer>{};

  Future<void>? _initFuture;

  Future<void> init() => _initFuture ??= _doInit();

  Future<void> _doInit() async {
    // Fire the native init first. If it succeeds the audioplayers fallback for
    // read is still constructed but never invoked — kept as a lifeboat.
    await _initNativeRead();

    // Dedicated audioplayers per non-read cue.
    for (final cue in ScanCue.values) {
      if (cue == ScanCue.read) continue;
      final p = AudioPlayer()
        ..setReleaseMode(ReleaseMode.stop)
        ..setPlayerMode(PlayerMode.lowLatency);
      try {
        await p.setSource(AssetSource(_assets[cue]!.replaceFirst('assets/', '')));
      } catch (e) {
        if (kDebugMode) {
          // ignore: avoid_print
          print('[ScanSounds] setSource $cue failed: $e');
        }
      }
      _players[cue] = p;
    }

    // Fallback pool for [read] — only used if native init failed.
    if (!_nativeReadReady) {
      try {
        final bytes = await rootBundle.load('assets/sounds/uhf-read-tag.mp3');
        final dir = await getTemporaryDirectory();
        final file = File('${dir.path}/wms_scan_read.mp3');
        await file.writeAsBytes(bytes.buffer.asUint8List(
          bytes.offsetInBytes,
          bytes.lengthInBytes,
        ));
        _readFallbackPool = await AudioPool.create(
          source: DeviceFileSource(file.path),
          maxPlayers: 6,
          minPlayers: 3,
          playerMode: PlayerMode.lowLatency,
        );
        if (kDebugMode) {
          // ignore: avoid_print
          print('[ScanSounds] native SoundPool unavailable; using audioplayers fallback pool');
        }
      } catch (e) {
        if (kDebugMode) {
          // ignore: avoid_print
          print('[ScanSounds] fallback pool build failed: $e');
        }
      }
    }
  }

  Future<void> _initNativeRead() async {
    try {
      final ok = await _native.invokeMethod<bool>('init');
      _nativeReadReady = ok == true;
      if (kDebugMode) {
        // ignore: avoid_print
        print('[ScanSounds] native SoundPool init -> $_nativeReadReady');
      }
    } on MissingPluginException {
      _nativeReadReady = false;
    } on PlatformException {
      _nativeReadReady = false;
    } catch (_) {
      _nativeReadReady = false;
    }
  }

  // Fire-and-forget. Safe before init completes (becomes a no-op).
  void play(ScanCue cue) {
    if (cue == ScanCue.read) {
      if (_nativeReadReady) {
        // Ignore result; it's one-way.
        _native.invokeMethod<void>('play').catchError((_) {});
        return;
      }
      final pool = _readFallbackPool;
      if (pool != null) {
        unawaited(() async {
          try { await pool.start(volume: 1.0); } catch (_) {}
        }());
      }
      return;
    }
    final p = _players[cue];
    if (p == null) return;
    // For one-shots (start/stop/success/error) we DO NOT stop() before resume —
    // that was clipping the in-flight cue whenever a second event arrived fast.
    // Let them play to completion; overlapping success+error is rare and acceptable.
    unawaited(() async {
      try {
        await p.seek(Duration.zero);
        await p.resume();
      } catch (_) {/* ignore */}
    }());
  }

  /// Kill every in-flight audio stream. Called on pause / popup-open so read
  /// beeps don't bleed over the error cue or continue after the user stopped scanning.
  void stopAll() {
    if (_nativeReadReady) {
      _native.invokeMethod<void>('stopAll').catchError((_) {});
    }
    final pool = _readFallbackPool;
    if (pool != null) {
      // AudioPool has no stop-all; nothing to do beyond not playing more.
    }
    for (final p in _players.values) {
      unawaited(() async {
        try { await p.stop(); } catch (_) {}
      }());
    }
  }

  Future<void> dispose() async {
    for (final p in _players.values) {
      try { await p.dispose(); } catch (_) {/* ignore */}
    }
    _players.clear();
    try { await _readFallbackPool?.dispose(); } catch (_) {/* ignore */}
    _readFallbackPool = null;
    try { await _native.invokeMethod<void>('dispose'); } catch (_) {/* ignore */}
    _nativeReadReady = false;
    _initFuture = null;
  }
}
