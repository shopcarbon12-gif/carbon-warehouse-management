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
  // Defaults to false so the 2D laser never fires on trigger pull until a
  // 2D-only screen (Bin Assign / Fast Putaway) explicitly opts in via
  // [activateTriggerRelay]. RFID screens (Count, Re-encode) should never
  // see this flip — leaving it false closes the race where a trigger pull
  // arriving before the screen's postFrameCallback would otherwise fire
  // BARCODESTARTSCAN and light the laser inside an RFID flow.
  @Volatile private var triggerRelayEnabled = false

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

  /**
   * External-source barcode push (used by [CarbonZebraRfidController] when the RFD8500
   * is in BARCODE_MODE and the imager decode arrives via the Zebra Scanner Control
   * SDK rather than a Chainway-style broadcast). Same downstream path as the normal
   * receiver: trim, drop empties, post to the active EventChannel sink.
   */
  fun emitExternal(raw: String) {
    val s = raw.trim()
    if (s.isEmpty()) return
    if (s.equals("barcodeCode", ignoreCase = true) ||
        s.equals("scannerdata", ignoreCase = true) ||
        s.equals("scan_data", ignoreCase = true)) {
      return
    }
    Log.d(TAG, "emitExternal data=$s")
    val target = sink ?: run {
      // Kept as a warning (no [DIAG] tag) because a null sink means decodes are
      // being silently dropped — useful signal if Bin Assign ever fails to
      // subscribe in a future regression.
      Log.w(TAG, "emitExternal: no Dart subscriber on EventChannel; data='$s' dropped")
      return
    }
    mainHandler.post { target.success(s) }
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
              // Two trigger modes share this relay:
              //   - 2D mode (Bin Assign / Fast Putaway): triggerRelayEnabled=true,
              //     so each trigger pull toggles the 2D laser. First pull turns
              //     it on (stays lit until SCAN_TIMEOUT_MS or a barcode decodes —
              //     the Dart side calls scanner.stop2d after a successful decode);
              //     a second pull during that dwell turns it off so the operator
              //     can abort without waiting out the full window.
              //   - RFID mode (Count): triggerRelayEnabled=false; the trigger is
              //     consumed by Count's hardware_trigger handler, which toggles
              //     UHF inventory directly. Sending BARCODESTARTSCAN here would
              //     kill the active UHF session, so we skip it.
              if (triggerRelayEnabled) {
                if (scanActive) {
                  stopHardwareScan()
                } else {
                  startHardwareScan()
                }
              }
              return
            }
            KEY_UP_ACTION -> {
              // Intentional: trigger is one-shot (no hold-to-keep-on). The 2D
              // laser stays lit for SCAN_TIMEOUT_MS or until a decode arrives.
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
          if (sink == null) {
            Log.w(TAG, "barcode broadcast: no Dart subscriber on EventChannel; data='$t' dropped")
          }
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
    // Send to all receivers AND directly to com.rscja.scanner with the
    // stopped-package flag so the broadcast wakes the scanner service even if
    // it was force-stopped (the UART acquire path kills it once at startup).
    runCatching {
      context.sendBroadcast(
        Intent(ACTION_SCAN_START).addFlags(Intent.FLAG_INCLUDE_STOPPED_PACKAGES),
      )
    }
    runCatching {
      context.sendBroadcast(
        Intent(ACTION_SCAN_START)
          .setPackage(SCANNER_PACKAGE)
          .addFlags(Intent.FLAG_INCLUDE_STOPPED_PACKAGES),
      )
    }
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
    runCatching {
      context.sendBroadcast(
        Intent(ACTION_SCAN_STOP).addFlags(Intent.FLAG_INCLUDE_STOPPED_PACKAGES),
      )
    }
    runCatching {
      context.sendBroadcast(
        Intent(ACTION_SCAN_STOP)
          .setPackage(SCANNER_PACKAGE)
          .addFlags(Intent.FLAG_INCLUDE_STOPPED_PACKAGES),
      )
    }
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
    const val SCANNER_PACKAGE = "com.rscja.scanner"
    /**
     * One-shot 2D laser dwell for Bin Assign / Fast Putaway. Trigger pull fires
     * the laser; if no barcode is decoded inside this window the laser stops on
     * its own and the next trigger pull starts a fresh one-shot. UHF continuous
     * inventory does not flow through this timeout (scanActive stays false on
     * the Count screen), so the value is purely the 2D dwell budget.
     */
    const val SCAN_TIMEOUT_MS = 15_000L
  }
}
