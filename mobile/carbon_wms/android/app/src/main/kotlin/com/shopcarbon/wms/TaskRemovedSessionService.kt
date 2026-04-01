package com.shopcarbon.wms

import android.app.Service
import android.content.Intent
import android.os.IBinder

/**
 * [stopWithTask]=false so the process notifies us when the user removes the app from recents.
 * Clears the WMS session token (same as a logout) while leaving biometric vault / email prefs intact.
 */
class TaskRemovedSessionService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

  override fun onTaskRemoved(rootIntent: Intent?) {
    SessionPrefsBridge.clearWmsSessionToken(applicationContext)
    stopSelf()
  }
}
