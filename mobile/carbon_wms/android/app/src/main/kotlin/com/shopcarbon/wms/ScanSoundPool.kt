package com.shopcarbon.wms

import android.content.Context
import android.content.res.AssetFileDescriptor
import android.media.AudioAttributes
import android.media.SoundPool
import android.util.Log
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * Native per-tag beep played through [android.media.SoundPool].
 *
 * Senitron's APK ships exactly the same `uhf-read-tag.mp3` we do, but plays it through
 * a custom Kotlin `SoundPoolPlayer` wrapping native SoundPool — which pre-decodes the MP3
 * to PCM at load time and then plays each subsequent [play] call with <1 ms latency via
 * the kernel mixer. The Dart `audioplayers` plugin's `AudioPool` cannot match that; each
 * playback still touches MediaPlayer's prepare/start pipeline, so rapid-fire tags trail
 * and occasionally queue.
 *
 * Flutter contract (MethodChannel `carbon_wms/scan_sound`):
 *   - `init`  → loads the asset, returns `true` on success, `false` if pool construction
 *              or asset decode fails. Dart falls back to the `audioplayers` path on false.
 *   - `play`  → fires a one-shot, fire-and-forget. Always succeeds once [init] has returned
 *              true; multiple overlapping calls are mixed by the stream engine, not queued.
 *   - `stopAll` → kills every in-flight stream immediately. Used by the pause / popup
 *              logic in [SearchAndEncodeScreen] so read clicks don't bleed over the error
 *              cue during the 10-second foreign-tag dialog.
 *   - `dispose` → releases the pool (tear-down on logout / activity finish).
 */
class ScanSoundPool(private val context: Context) : MethodChannel.MethodCallHandler {
  private var pool: SoundPool? = null
  private var soundId: Int = 0
  private var loaded: Boolean = false
  private val activeStreams: MutableList<Int> = mutableListOf()
  private val lock = Any()

  companion object {
    private const val TAG = "ScanSoundPool"
    private const val CHANNEL = "carbon_wms/scan_sound"
    // SoundPool internals: mixer concurrency. 6 matches Senitron's observed ceiling.
    private const val MAX_STREAMS = 6
    // Flutter asset path relative to the app's flutter_assets bundle.
    private const val READ_TAG_ASSET_KEY = "assets/sounds/uhf-read-tag.mp3"
  }

  fun register(messenger: BinaryMessenger) {
    MethodChannel(messenger, CHANNEL).setMethodCallHandler(this)
  }

  override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
    when (call.method) {
      "init"    -> result.success(initPool())
      "play"    -> { playOne(); result.success(null) }
      "stopAll" -> { stopAll(); result.success(null) }
      "dispose" -> { disposePool(); result.success(null) }
      else      -> result.notImplemented()
    }
  }

  private fun initPool(): Boolean = synchronized(lock) {
    if (loaded) return true
    return try {
      val attrs = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build()
      val p = SoundPool.Builder()
        .setMaxStreams(MAX_STREAMS)
        .setAudioAttributes(attrs)
        .build()
      // Flutter assets live in assets/flutter_assets/<key> inside the APK.
      val lookupKey = io.flutter.FlutterInjector.instance()
        .flutterLoader()
        .getLookupKeyForAsset(READ_TAG_ASSET_KEY)
      val afd: AssetFileDescriptor = context.assets.openFd(lookupKey)
      // Load is async; flip [loaded] on the completion listener so callers know when
      // it's safe to play. Firing play before load is cheap (returns streamId=0 = noop).
      p.setOnLoadCompleteListener { _, sid, status ->
        if (status == 0 && sid == soundId) {
          loaded = true
          Log.d(TAG, "native SoundPool ready: soundId=$sid")
        } else {
          Log.w(TAG, "native SoundPool load failed: status=$status")
        }
      }
      soundId = p.load(afd, 1)
      afd.close()
      pool = p
      Log.d(TAG, "native SoundPool initialized, streams=$MAX_STREAMS asset=$READ_TAG_ASSET_KEY")
      true
    } catch (t: Throwable) {
      Log.e(TAG, "init failed, Dart will fall back to audioplayers: ${t.message}", t)
      disposePool()
      false
    }
  }

  private fun playOne() {
    val p = pool ?: return
    if (!loaded) return
    // rate=1.0 neutral pitch, priority=1, loop=0 (one-shot), leftVol=rightVol=1.0 full.
    val streamId = p.play(soundId, 1.0f, 1.0f, 1, 0, 1.0f)
    if (streamId != 0) {
      synchronized(lock) {
        activeStreams += streamId
        // Keep the active list from growing unbounded on long sessions.
        if (activeStreams.size > MAX_STREAMS * 2) {
          activeStreams.removeAt(0)
        }
      }
    }
  }

  private fun stopAll() {
    val p = pool ?: return
    val snapshot: List<Int>
    synchronized(lock) {
      snapshot = activeStreams.toList()
      activeStreams.clear()
    }
    for (s in snapshot) {
      try { p.stop(s) } catch (_: Throwable) { /* stream may have already ended */ }
    }
  }

  private fun disposePool() = synchronized(lock) {
    activeStreams.clear()
    try { pool?.release() } catch (_: Throwable) { /* ignore */ }
    pool = null
    loaded = false
    soundId = 0
  }
}
