package com.shopcarbon.wms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
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

  override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
    sink = events
    register()
  }

  override fun onCancel(arguments: Any?) {
    sink = null
  }

  fun activateTriggerRelay() {
    register()
  }

  fun dispose() {
    unregister()
    sink = null
  }

  private fun register() {
    if (receiver != null) return
    receiver =
      object : BroadcastReceiver() {
        override fun onReceive(ctx: Context?, intent: Intent?) {
          if (intent == null) return
          when (intent.action) {
            KEY_DOWN_ACTION -> {
              startHardwareScan()
              return
            }
            KEY_UP_ACTION -> {
              stopHardwareScan()
              return
            }
          }
          val s = extractBarcode(intent) ?: return
          val t = s.trim()
          if (t.isEmpty()) return
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
      intent.getStringExtra(key)?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
    }
    for (key in BYTE_EXTRA_KEYS) {
      val bytes = intent.getByteArrayExtra(key) ?: continue
      utf8String(bytes)?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
    }
    intent.extras?.let { b ->
      for (key in b.keySet()) {
        val v = b.get(key) ?: continue
        when (v) {
          is String -> v.trim().takeIf { it.isNotEmpty() }?.let { return it }
          is ByteArray -> utf8String(v)?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
          is CharArray -> String(v).trim().takeIf { it.isNotEmpty() }?.let { return it }
        }
      }
    }
    intent.dataString?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
    return null
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
    runCatching { context.sendBroadcast(Intent(ACTION_SCAN_START)) }
    // Some firmware variants use this as a one-shot trigger.
    runCatching { context.sendBroadcast(Intent(ACTION_SCAN_PULSE)) }
  }

  fun stopHardwareScan() {
    runCatching { context.sendBroadcast(Intent(ACTION_SCAN_STOP)) }
  }

  private companion object {
    const val TAG = "CarbonHardwareBarcode"

    /** Actions seen on Chainway / Mediatek / ScanManager-style stacks. */
    val SCAN_ACTIONS =
      arrayOf(
        KEY_DOWN_ACTION,
        KEY_UP_ACTION,
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
        "barcode",
        "BARCODE",
        "barcodeBytes",
        "decode_data",
      )

    const val KEY_DOWN_ACTION = "com.rscja.android.KEY_DOWN"
    const val KEY_UP_ACTION = "com.rscja.android.KEY_UP"
    const val ACTION_SCAN_START = "android.intent.action.BARCODESTARTSCAN"
    const val ACTION_SCAN_STOP = "android.intent.action.BARCODESTOPSCAN"
    const val ACTION_SCAN_PULSE = "android.intent.action.BARCODESCAN"
  }
}
