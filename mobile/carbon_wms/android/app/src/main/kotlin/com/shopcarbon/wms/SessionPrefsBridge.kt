package com.shopcarbon.wms

import android.content.Context

/** Clears Flutter [SharedPreferences] session key(s) used by [WmsApiClient] (`wms_session_token`). */
object SessionPrefsBridge {
  private const val FLUTTER_PREFS = "FlutterSharedPreferences"

  @JvmStatic
  fun clearWmsSessionToken(context: Context) {
    val sp = context.applicationContext.getSharedPreferences(FLUTTER_PREFS, Context.MODE_PRIVATE)
    val ed = sp.edit()
    for (k in sp.all.keys) {
      if (k.contains("wms_session_token")) {
        ed.remove(k)
      }
    }
    ed.apply()
  }
}
