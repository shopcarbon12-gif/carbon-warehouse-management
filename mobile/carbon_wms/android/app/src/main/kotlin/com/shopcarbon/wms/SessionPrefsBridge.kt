package com.shopcarbon.wms

import android.content.Context

/** Clears Flutter [SharedPreferences] session key(s) used by [WmsApiClient] (`wms_session_token`). */
object SessionPrefsBridge {
  private const val FLUTTER_PREFS = "FlutterSharedPreferences"
  /** Flutter's shared_preferences prefix on Android (see shared_preferences_android). */
  private const val FLUTTER_SESSION_KEY = "flutter.wms_session_token"

  @JvmStatic
  fun clearWmsSessionToken(context: Context) {
    val sp = context.applicationContext.getSharedPreferences(FLUTTER_PREFS, Context.MODE_PRIVATE)
    val ed = sp.edit()
    ed.remove(FLUTTER_SESSION_KEY)
    for (k in sp.all.keys) {
      if (k.contains("wms_session_token", ignoreCase = true)) {
        ed.remove(k)
      }
    }
    // Synchronous: apply() may not finish before the process is killed after swipe-away / task remove.
    ed.commit()
  }
}
