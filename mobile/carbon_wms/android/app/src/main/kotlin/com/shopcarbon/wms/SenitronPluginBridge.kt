package com.shopcarbon.wms

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import io.flutter.plugin.common.EventChannel
import java.io.BufferedReader
import java.io.InputStreamReader

/**
 * Tails logcat filtered to the hqs tag (V hqs: <epc>------epc) and forwards
 * every new EPC to Flutter via rfid_tag_stream and OUTPUT_BARCODE_RFID broadcast.
 *
 * Uses a single persistent subprocess (`logcat -v time -s hqs:V`) instead of
 * repeated -d dumps, so no lines are lost between polls during a tag burst and
 * the fork overhead is paid once per session.
 */
class SenitronPluginBridge(
  private val context: Context,
  private val mainHandler: Handler = Handler(Looper.getMainLooper()),
) {
  private val TAG = "SenitronBridge"

  var tagSink: EventChannel.EventSink? = null

  private val seenEpcs = java.util.Collections.newSetFromMap(
    java.util.concurrent.ConcurrentHashMap<String, Boolean>()
  )

  fun clearSeenEpcs() { seenEpcs.clear() }

  @Volatile private var running = false
  private var logcatThread: Thread? = null

  fun start() {
    if (running) return
    running = true
    val t = Thread {
      tailLogcat()
    }
    t.isDaemon = true
    t.name = "senitron-logcat"
    t.start()
    logcatThread = t
    Log.d(TAG, "logcat tail bridge started (hqs:V filter)")
  }

  fun stop() {
    running = false
    logcatThread?.interrupt()
    logcatThread = null
    Log.d(TAG, "logcat bridge stopped")
  }

  private fun tailLogcat() {
    while (running) {
      var proc: Process? = null
      try {
        // -v time gives timestamp prefix; -s hqs:V limits to exactly the EPC tag.
        // Persistent process — we drain lines as they arrive, no polling gap.
        // Tail all logcat — filter inside for EPC patterns from any scanner tag.
        proc = ProcessBuilder("logcat", "-v", "time")
          .redirectErrorStream(false)
          .start()
        val reader = BufferedReader(InputStreamReader(proc.inputStream))
        while (running) {
          val line = reader.readLine() ?: break  // process exited
          if (!matchesEpcLine(line)) continue
          val epc = extractEpc(line) ?: continue
          val clean = epc.uppercase().replace(Regex("[^0-9A-F]"), "")
          if (clean.length < 8) continue  // too short to be a real EPC
          if (!seenEpcs.add(clean)) continue
          Log.d(TAG, "EPC from logcat: $clean (line: $line)")
          emitAndBroadcast(clean)
        }
      } catch (e: InterruptedException) {
        break
      } catch (e: Exception) {
        if (!running) break
        Log.e(TAG, "logcat error: ${e.message} — restarting in 500ms")
        try { Thread.sleep(500) } catch (_: InterruptedException) { break }
      } finally {
        proc?.destroy()
      }
    }
  }

  private fun matchesEpcLine(line: String): Boolean {
    // hqs firmware pattern: "V hqs: <epc>------epc"
    if (line.contains("------epc", ignoreCase = true)) return true
    // Chainway scanner service may log tag reads under various tags
    if (line.contains("rfid", ignoreCase = true) && line.contains("epc", ignoreCase = true)) return true
    // Fallback: scanner stack logs long hex payloads without explicit "epc" markers.
    if (line.contains("rscja", ignoreCase = true) &&
        Regex("([0-9A-Fa-f]{16,})").containsMatchIn(line)) return true
    return false
  }

  private fun extractEpc(line: String): String? {
    // Pattern 1: <epc>------epc
    if (line.contains("------epc")) {
      val colonIdx = line.lastIndexOf(':')
      if (colonIdx >= 0) {
        val payload = line.substring(colonIdx + 1).trim()
        return payload.substringBefore("------epc").trim()
      }
    }
    // Pattern 2: epc=<value> or EPC:<value> style
    val epcEq = Regex("(?i)epc[=:]\\s*([0-9A-Fa-f]{8,})", RegexOption.IGNORE_CASE).find(line)
    if (epcEq != null) return epcEq.groupValues[1]
    val longHex = Regex("([0-9A-Fa-f]{16,})").find(line)
    if (longHex != null) return longHex.groupValues[1]
    return null
  }

  private fun emitAndBroadcast(clean: String) {
    runCatching {
      context.sendBroadcast(Intent("com.rscja.scanner.action.OUTPUT_BARCODE_RFID").apply {
        putExtra("scannerdata", clean)
        putExtra("epc", clean)
      })
    }
    runCatching {
      context.sendBroadcast(Intent("android.intent.action.BARCODEOUTPUT").apply {
        putExtra("scannerdata", clean)
        putExtra("epc", clean)
      })
    }
    val sink = tagSink ?: return
    mainHandler.post { sink.success(mapOf("epc" to clean, "rssi" to 0)) }
  }

  fun dispose() {
    stop()
  }
}
