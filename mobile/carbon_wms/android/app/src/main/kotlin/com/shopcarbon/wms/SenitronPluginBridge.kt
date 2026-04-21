package com.shopcarbon.wms

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import io.flutter.plugin.common.EventChannel
import java.io.BufferedReader
import java.io.InputStreamReader

/**
 * Reads DeviceAPI_UHF logcat output in a background thread to extract EPC strings.
 *
 * The system com.rscja.scanner service (PID ~2359) logs every UHF read as:
 *   V hqs: F0A0B30E4F9BCB80000022AE------epc
 *
 * Since the system scanner does not broadcast EPCs to external apps (it only delivers
 * to its own internal components), we read from logcat as the bridge.
 */
class SenitronPluginBridge(
  private val context: Context,
  private val mainHandler: Handler = Handler(Looper.getMainLooper()),
) {
  private val TAG = "SenitronBridge"

  var tagSink: EventChannel.EventSink? = null

  @Volatile private var running = false
  private var logcatThread: Thread? = null

  fun start() {
    if (running) return
    running = true
    val t = Thread { runLogcat() }
    t.isDaemon = true
    t.name = "senitron-logcat"
    t.start()
    logcatThread = t
    Log.d(TAG, "logcat bridge started")
  }

  fun stop() {
    running = false
    logcatThread?.interrupt()
    logcatThread = null
    Log.d(TAG, "logcat bridge stopped")
  }

  private fun runLogcat() {
    try {
      // -T 1: start from last line (no backlog), -s hqs:V to only get hqs verbose lines.
      val proc = Runtime.getRuntime().exec(arrayOf("logcat", "-T", "1", "-s", "hqs:V"))
      val reader = BufferedReader(InputStreamReader(proc.inputStream))
      while (running) {
        val line = reader.readLine() ?: break
        // Line format: "MM-DD HH:MM:SS.mmm  PID  TID V hqs     : F0A0B...------epc"
        if (!line.contains("------epc")) continue
        val colonIdx = line.lastIndexOf(':')
        if (colonIdx < 0) continue
        val payload = line.substring(colonIdx + 1).trim()
        val epc = payload.substringBefore("------epc").trim()
        val clean = epc.uppercase().replace(Regex("[^0-9A-F]"), "")
        Log.d(TAG, "logcat EPC: $clean")
        val sink = tagSink ?: continue
        val payload2 = mapOf("epc" to clean, "rssi" to 0)
        mainHandler.post { sink.success(payload2) }
      }
      proc.destroy()
    } catch (e: InterruptedException) {
      Log.d(TAG, "logcat thread interrupted")
    } catch (e: Exception) {
      Log.e(TAG, "logcat bridge error: ${e.message}", e)
    }
    Log.d(TAG, "logcat bridge thread exited")
  }

  fun dispose() {
    stop()
  }
}
