package com.shopcarbon.wms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.util.Log
import io.flutter.plugin.common.EventChannel

/**
 * Emits handheld trigger key events to Flutter.
 * Used by non-barcode modules (e.g. Count Inventory) that need trigger-based start/stop.
 */
class CarbonHardwareTriggerRelay(
  private val context: Context,
) : EventChannel.StreamHandler {
  private var sink: EventChannel.EventSink? = null
  private var receiver: BroadcastReceiver? = null

  override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
    sink = events
    register()
  }

  override fun onCancel(arguments: Any?) {
    unregister()
    sink = null
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
          when (intent?.action) {
            KEY_DOWN_ACTION -> sink?.success("down")
            KEY_UP_ACTION -> sink?.success("up")
          }
        }
      }
    val filter = IntentFilter().apply {
      addAction(KEY_DOWN_ACTION)
      addAction(KEY_UP_ACTION)
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

  private companion object {
    const val TAG = "CarbonHardwareTrigger"
    const val KEY_DOWN_ACTION = "com.rscja.android.KEY_DOWN"
    const val KEY_UP_ACTION = "com.rscja.android.KEY_UP"
  }
}
