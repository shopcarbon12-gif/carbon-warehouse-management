package com.shopcarbon.wms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import io.flutter.plugin.common.EventChannel
import java.nio.charset.Charset
import java.nio.charset.StandardCharsets

/**
 * Forwards OEM 2D scan broadcasts (Chainway / MTK / generic) into Flutter via [EventChannel].
 * Many rugged devices send decode data as a broadcast instead of (or in addition to) keyboard wedge.
 */
class CarbonHardwareBarcodeRelay(
  private val context: Context,
) : EventChannel.StreamHandler {
  private var sink: EventChannel.EventSink? = null
  private var receiver: BroadcastReceiver? = null
  private val mainHandler = Handler(Looper.getMainLooper())
  private var scanTimeoutRunnable: Runnable? = null
  @Volatile private var scanActive = false
  @Volatile private var triggerRelayEnabled = true

  override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
    sink = events
    register()
  }

  override fun onCancel(arguments: Any?) {
    sink = null
  }

  fun activateTriggerRelay() {
    triggerRelayEnabled = true
    register() // re-registers if unregistered by deactivateTriggerRelay
  }

  /** Unregisters the broadcast receiver entirely so KEY_DOWN never reaches com.rscja.scanner. */
  fun deactivateTriggerRelay() {
    triggerRelayEnabled = false
    scanActive = false
    cancelScanTimeout()
    // Keep receiver registered so EPC broadcasts still reach Flutter while
    // trigger-driven 2D scan toggling is disabled.
    register()
  }

  fun dispose() {
    unregister()
    stopHardwareScan()
    sink = null
  }

  private fun register() {
    if (receiver != null) return
    receiver =
      object : BroadcastReceiver() {
        override fun onReceive(ctx: Context?, intent: Intent?) {
          if (intent == null) return
          val rxAction = intent.action ?: return
          Log.d(TAG, "RX action=$rxAction extras=${extrasSummary(intent)}")
          when (rxAction) {
            KEY_DOWN_ACTION -> {
              if (!triggerRelayEnabled) return
              if (scanActive) {
                stopHardwareScan()
              } else {
                startHardwareScan()
              }
              return
            }
            KEY_UP_ACTION -> {
              if (!triggerRelayEnabled) return
              // Keep scan on until decode or timeout; do not hard-stop on key-up.
              return
            }
          }
          val s = if (rxAction == "com.rscja.android.ScannerWrite") {
            extractScannerWriteEpc(intent) ?: return
          } else {
            extractBarcode(intent) ?: return
          }
          val t = s.trim()
          if (t.isEmpty()) return
          if (t.equals("barcodeCode", ignoreCase = true) ||
              t.equals("scannerdata", ignoreCase = true) ||
              t.equals("scan_data", ignoreCase = true)) {
            return
          }
          Log.d(TAG, "barcode event action=${intent.action} data=$t")
          // Keep OEM UHF inventory running for rapid multi-tag reads; idle timeout stops the session.
          // Stopping after each decode breaks continuous RFID (only ever one tag per START).
          resetScanIdleTimeout()
          sink?.success(t)
        }
      }
    val filter = IntentFilter()
    for (a in SCAN_ACTIONS) {
      filter.addAction(a)
    }
    val r = receiver!!
    try {
      if (Build.VERSION.SDK_INT >= 33) {
        context.applicationContext.registerReceiver(r, filter, Context.RECEIVER_EXPORTED)
      } else {
        @Suppress("DEPRECATION")
        context.applicationContext.registerReceiver(r, filter)
      }
    } catch (e: Exception) {
      Log.w(TAG, "registerReceiver failed", e)
    }
  }

  private fun unregister() {
    val r = receiver ?: return
    receiver = null
    try {
      context.applicationContext.unregisterReceiver(r)
    } catch (_: Exception) {
      /* already unregistered */
    }
  }

  private fun extractBarcode(intent: Intent): String? {
    for (key in STRING_EXTRA_KEYS) {
      val v = intent.getStringExtra(key)?.trim()?.takeIf { it.isNotEmpty() } ?: continue
      normalizeEpcCandidate(v)?.let { return it }
    }
    for (key in BYTE_EXTRA_KEYS) {
      val bytes = intent.getByteArrayExtra(key) ?: continue
      utf8String(bytes)?.trim()?.takeIf { it.isNotEmpty() }?.let { s ->
        normalizeEpcCandidate(s)?.let { return it }
      }
      val hex = bytes.joinToString("") { "%02X".format(it.toInt() and 0xFF) }
      normalizeEpcCandidate(hex)?.let { return it }
    }
    intent.dataString?.trim()?.takeIf { it.isNotEmpty() }?.let { s ->
      normalizeEpcCandidate(s)?.let { return it }
    }
    extractEpcFromAnyExtras(intent)?.let { return it }
    return null
  }

  private fun extractScannerWriteEpc(intent: Intent): String? {
    fun pick(raw: String?): String? = normalizeEpcCandidate(raw)
    for (key in STRING_EXTRA_KEYS) {
      pick(intent.getStringExtra(key))?.let { return it }
    }
    for (key in BYTE_EXTRA_KEYS) {
      val bytes = intent.getByteArrayExtra(key) ?: continue
      pick(runCatching { String(bytes, StandardCharsets.UTF_8) }.getOrNull())?.let { return it }
      val hex = bytes.joinToString("") { "%02X".format(it.toInt() and 0xFF) }
      pick(hex)?.let { return it }
    }
    val extras = intent.extras ?: return null
    for (key in extras.keySet()) {
      val v = extras.get(key) ?: continue
      when (v) {
        is String -> pick(v)?.let { return it }
        is ByteArray -> {
          pick(runCatching { String(v, StandardCharsets.UTF_8) }.getOrNull())?.let { return it }
          val hex = v.joinToString("") { "%02X".format(it.toInt() and 0xFF) }
          pick(hex)?.let { return it }
        }
      }
    }
    return null
  }

  private fun extractEpcFromAnyExtras(intent: Intent): String? {
    val extras = intent.extras ?: return null
    for (key in extras.keySet()) {
      when (val value = extras.get(key)) {
        is String -> normalizeEpcCandidate(value)?.let { return it }
        is ByteArray -> {
          utf8String(value)?.let { normalizeEpcCandidate(it)?.let { return it } }
          val hex = value.joinToString("") { "%02X".format(it.toInt() and 0xFF) }
          normalizeEpcCandidate(hex)?.let { return it }
        }
      }
    }
    return null
  }

  private fun normalizeEpcCandidate(raw: String?): String? {
    val s = raw?.trim()?.uppercase() ?: return null
    if (s.isEmpty()) return null
    if (s.contains("/") || s.contains(".XML")) return null
    if (s == "BARCODECODE" || s == "SCANNERDATA" || s == "SCAN_DATA") return null
    return Regex("([0-9A-F]{8,})").find(s)?.groupValues?.get(1)
  }

  private fun extrasSummary(intent: Intent): String {
    val extras = intent.extras ?: return "<none>"
    return buildString {
      for (key in extras.keySet()) {
        val value = extras.get(key)
        append(key).append("=")
        append(
          when (value) {
            is ByteArray -> "byte[${value.size}]"
            else -> value?.toString() ?: "null"
          }
        ).append("; ")
      }
    }
  }

  private fun utf8String(bytes: ByteArray): String? =
    try {
      String(bytes, StandardCharsets.UTF_8)
    } catch (_: Exception) {
      try {
        String(bytes, Charset.forName("GB2312"))
      } catch (_: Exception) {
        null
      }
    }

  fun startHardwareScan() {
    scanActive = true
    cancelScanTimeout()
    runCatching { context.sendBroadcast(Intent(ACTION_SCAN_START)) }
    scheduleScanTimeout(SCAN_TIMEOUT_MS)
  }

  /** Extend idle shutdown while tags keep arriving (continuous inventory). */
  private fun resetScanIdleTimeout() {
    if (!scanActive) return
    cancelScanTimeout()
    scheduleScanTimeout(SCAN_TIMEOUT_MS)
  }

  fun stopHardwareScan() {
    scanActive = false
    cancelScanTimeout()
    runCatching { context.sendBroadcast(Intent(ACTION_SCAN_STOP)) }
  }

  private fun scheduleScanTimeout(ms: Long) {
    val r = Runnable { stopHardwareScan() }
    scanTimeoutRunnable = r
    mainHandler.postDelayed(r, ms)
  }

  private fun cancelScanTimeout() {
    val r = scanTimeoutRunnable ?: return
    mainHandler.removeCallbacks(r)
    scanTimeoutRunnable = null
  }

  private companion object {
    const val TAG = "CarbonHardwareBarcode"

    /** Actions seen on Chainway / Mediatek / ScanManager-style stacks. */
    val SCAN_ACTIONS =
      arrayOf(
        KEY_DOWN_ACTION,
        KEY_UP_ACTION,
        "android.intent.action.BARCODEOUTPUT",          // primary C72E UHF output action
        "android.intent.action.OUTPUT_BARCODE_RFID",
        "com.rscja.scanner.action.OUTPUT_BARCODE_RFID",
        "com.rscja.android.OVER_RESULT",
        "com.rscja.android.OVERDATA_RESULT",
        "com.rscja.scanner.action.SCAN_RESULT_BROADCAST",
        "android.intent.action.SCANRESULT",
        "android.intent.action.SCAN_RESULT_BROADCAST",
        // "android.intent.action.SCAN_RESULT_BROADCAST_RFID" excluded — routing metadata only
        "com.rscja.android.DATA_RESULT",
        "com.rscja.android.ScannerWrite",
        "android.intent.ACTION_DECODE_DATA",
        "android.intent.action.DECODE_DATA",
        "com.android.decode.action.BARCODE_DECODED",
        "com.rscja.scanner.action.scanner",
        "com.rscja.scanner.action.scanner.RFID",
        "com.scanner.broadcast",
        "nlscan.action.SCANNER_RESULT",
      )

    val STRING_EXTRA_KEYS =
      arrayOf(
        "EXTRA_SCAN_DATA",
        "scanData",
        "scan_data",
        "SCAN_DATA",
        "barcodeCode",
        "epc",
        "EPC",
        "data_result",
        "DATA_RESULT",
        "barcode_string",
        "BARCODE_STRING",
        "decode_data",
        "scannerdata",
        "SCAN_BARCODE",
        "data",
        "barcodeData",
        "barcode",
      )

    val BYTE_EXTRA_KEYS =
      arrayOf(
        "EXTRA_SCAN_DATA",
        "SCAN_DATA",
        "barcode",
        "BARCODE",
        "barcodeBytes",
        "decode_data",
      )

    const val KEY_DOWN_ACTION = "com.rscja.android.KEY_DOWN"
    const val KEY_UP_ACTION = "com.rscja.android.KEY_UP"
    const val ACTION_SCAN_START = "android.intent.action.BARCODESTARTSCAN"
    const val ACTION_SCAN_STOP = "android.intent.action.BARCODESTOPSCAN"
    /** Long idle window so warehouse passes don't drop UHF mid-aisle. */
    const val SCAN_TIMEOUT_MS = 120_000L
  }
}
