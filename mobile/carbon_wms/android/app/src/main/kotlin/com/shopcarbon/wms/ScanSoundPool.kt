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
 * Native scan-event audio played through [android.media.SoundPool].
 *
 * All five cues (start, stop, read, success, error) share one SoundPool so every
 * cue goes through the same low-latency kernel mixer path. MP3s are pre-decoded
 * at init time so each [playCue] call fires with sub-millisecond latency and
 * overlapping cues mix rather than cut each other off.
 *
 * This is the ONLY audio path for scan UI — the Dart side no longer touches
 * audioplayers for these cues. That eliminates the AudioFocus callback storm
 * and the MediaPlayer state-machine "first-play vs resume" traps.
 *
 * Flutter contract (MethodChannel `carbon_wms/scan_sound`):
 *   - `init`        → loads all cue assets, returns `true` once all succeed.
 *   - `play`        → legacy per-tag read (same as `playCue` with cue="read").
 *   - `playCue`     → args {cue: "start"|"stop"|"read"|"success"|"error", volume: 0..1}.
 *                     Fire-and-forget; overlapping calls are mixed by the pool.
 *   - `stopAll`     → kills every in-flight stream immediately.
 *   - `dispose`     → releases the pool.
 */
class ScanSoundPool(private val context: Context) : MethodChannel.MethodCallHandler {
  private var pool: SoundPool? = null
  /** Cue key → SoundPool soundId (populated asynchronously by the load callback). */
  private val soundIds: MutableMap<String, Int> = mutableMapOf()
  /** soundIds whose async load has completed successfully. */
  private val loadedIds: MutableSet<Int> = mutableSetOf()
  private val activeStreams: MutableList<Int> = mutableListOf()
  private val lock = Any()

  /**
   * User-controlled global volume scale (0..1) set from the Settings screen
   * volume slider. Multiplied with the per-call volume in [playCue] so the
   * RSSI ramp inside [playTagBeep] still works — but capped by the user's
   * preference. Defaults to 1.0 (no attenuation) until Dart pushes a value.
   */
  @Volatile private var userVolume: Float = 1.0f

  companion object {
    private const val TAG = "ScanSoundPool"
    private const val CHANNEL = "carbon_wms/scan_sound"
    // SoundPool mixer concurrency — enough headroom for overlapping tag reads at
    // burst rates without dropping cues.
    private const val MAX_STREAMS = 8

    // Cue key → flutter asset path. Must match the keys used from Dart.
    private val ASSETS: Map<String, String> = mapOf(
      "read"    to "assets/sounds/uhf-read-tag.mp3",
      "start"   to "assets/sounds/uhf-start.mp3",
      "stop"    to "assets/sounds/uhf-stop.mp3",
      "success" to "assets/sounds/success.mp3",
      "error"   to "assets/sounds/uhf-error.mp3",
    )

    /**
     * Process-wide singleton reference so native RFID controllers can fire the
     * per-tag beep from inside their emit path, without the Dart round-trip.
     * Set by [MainActivity.configureFlutterEngine] after [register] is called.
     */
    @Volatile var shared: ScanSoundPool? = null
  }

  fun register(messenger: BinaryMessenger) {
    MethodChannel(messenger, CHANNEL).setMethodCallHandler(this)
  }

  override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
    when (call.method) {
      "init"    -> result.success(initPool())
      "play"    -> { playCue("read", 1.0f); result.success(null) }
      "playCue" -> {
        val args = call.arguments as? Map<*, *>
        val cue = (args?.get("cue") as? String) ?: "read"
        val volRaw = (args?.get("volume") as? Number)?.toFloat() ?: 1.0f
        val vol = volRaw.coerceIn(0f, 1f)
        playCue(cue, vol)
        result.success(null)
      }
      "setUserVolume" -> {
        val args = call.arguments as? Map<*, *>
        val v = (args?.get("volume") as? Number)?.toFloat() ?: 1.0f
        userVolume = v.coerceIn(0f, 1f)
        Log.d(TAG, "userVolume set to $userVolume")
        result.success(null)
      }
      "stopAll" -> { stopAll(); result.success(null) }
      "dispose" -> { disposePool(); result.success(null) }
      else      -> result.notImplemented()
    }
  }

  private fun initPool(): Boolean = synchronized(lock) {
    if (pool != null && soundIds.size == ASSETS.size) return true

    return try {
      // USAGE_MEDIA / CONTENT_TYPE_MUSIC routes through STREAM_MUSIC, which
      // survives Chainway ringer-silent mode. USAGE_ASSISTANCE_SONIFICATION
      // gets mapped to notification-like streams that are muted by SILENT.
      val attrs = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
        .build()
      val p = SoundPool.Builder()
        .setMaxStreams(MAX_STREAMS)
        .setAudioAttributes(attrs)
        .build()

      p.setOnLoadCompleteListener { _, sid, status ->
        synchronized(lock) {
          if (status == 0) {
            loadedIds += sid
            Log.d(TAG, "SoundPool loaded sid=$sid (${loadedIds.size}/${ASSETS.size})")
          } else {
            Log.w(TAG, "SoundPool load failed sid=$sid status=$status")
          }
        }
      }

      // Load each cue asset. IDs start returning immediately; playback before
      // a specific cue's load completes is a quiet no-op (streamId == 0).
      val flutterLoader = io.flutter.FlutterInjector.instance().flutterLoader()
      for ((cue, assetPath) in ASSETS) {
        try {
          val lookupKey = flutterLoader.getLookupKeyForAsset(assetPath)
          val afd: AssetFileDescriptor = context.assets.openFd(lookupKey)
          val sid = p.load(afd, 1)
          afd.close()
          soundIds[cue] = sid
          Log.d(TAG, "queued cue=$cue sid=$sid asset=$assetPath")
        } catch (e: Throwable) {
          Log.e(TAG, "failed to queue cue=$cue: ${e.message}", e)
        }
      }
      pool = p
      Log.d(TAG, "SoundPool initialized, streams=$MAX_STREAMS, cues=${soundIds.size}")
      true
    } catch (t: Throwable) {
      Log.e(TAG, "initPool failed: ${t.message}", t)
      disposePool()
      false
    }
  }

  /**
   * Native-originated per-tag read beep with RSSI-scaled volume.
   *
   * Called from inside the RFID controllers' emit path so the beep does not
   * wait for a Dart→MethodChannel→native round-trip. Floor at 0.3 so
   * low-signal reads stay audible, ceiling at 1.0 at touch proximity.
   *
   * [rssiNormalized] is the already-normalized 0–100 value (dBm → 0–100
   * scaling lives in the caller so the proximity UI and audio agree).
   */
  fun playTagBeep(rssiNormalized: Int) {
    val n = rssiNormalized.coerceIn(0, 100)
    val vol = (0.3f + (n / 100.0f) * 0.7f).coerceIn(0f, 1f)
    playCue("read", vol)
  }

  private fun playCue(cue: String, volume: Float) {
    val p = pool
    if (p == null) { Log.w(TAG, "playCue($cue): pool is null"); return }
    val sid: Int
    val ready: Boolean
    synchronized(lock) {
      sid = soundIds[cue] ?: run {
        Log.w(TAG, "playCue($cue): no sid registered")
        return
      }
      ready = loadedIds.contains(sid)
    }
    if (!ready) {
      Log.w(TAG, "playCue($cue): sid=$sid not loaded yet")
      return
    }
    // priority=1, loop=0 (one-shot), rate=1.0 neutral pitch. Per-call volume
    // is scaled by the user's preference set from the Settings screen
    // (carbon_wms/scan_sound 'setUserVolume') so the RSSI ramp inside
    // [playTagBeep] is preserved but capped at the user's chosen level.
    val finalVol = (volume * userVolume).coerceIn(0f, 1f)
    Log.d("LAT", "BEEP_PLAY ts=${System.currentTimeMillis()} cue=$cue base=$volume user=$userVolume final=$finalVol")
    val streamId = p.play(sid, finalVol, finalVol, 1, 0, 1.0f)
    if (streamId == 0) {
      Log.w(TAG, "playCue($cue): SoundPool.play returned 0 (sid=$sid, pool busy?)")
      return
    }
    synchronized(lock) {
      activeStreams += streamId
      if (activeStreams.size > MAX_STREAMS * 2) {
        activeStreams.removeAt(0)
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
    loadedIds.clear()
    soundIds.clear()
    try { pool?.release() } catch (_: Throwable) { /* ignore */ }
    pool = null
  }
}
