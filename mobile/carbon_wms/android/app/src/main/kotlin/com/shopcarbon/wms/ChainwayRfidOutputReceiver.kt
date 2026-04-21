package com.shopcarbon.wms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Static manifest receiver for com.rscja.scanner UHF output broadcasts.
 * On Android 8+ dynamic receivers may not receive implicit broadcasts from system services;
 * a static receiver always fires. Forwards raw EPC data to [CarbonChainwayRfidController].
 */
class ChainwayRfidOutputReceiver : BroadcastReceiver() {
  override fun onReceive(ctx: Context?, intent: Intent?) {
    if (intent == null) return
    Log.d("CarbonChainway", "static recv: action=${intent.action}")
    val extras = intent.extras
    if (extras != null) {
      for (key in extras.keySet()) {
        Log.d("CarbonChainway", "  static extra '$key'='${extras.get(key)}'")
      }
    }
    // No-op: EPC delivery is now via direct UART (UHFGetReceived_EX2), not broadcasts.
  }
}
