package com.shopcarbon.wms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.IntentFilter
import android.os.Build

class ZebraContextWrapper(base: Context) : ContextWrapper(base) {
    override fun registerReceiver(receiver: BroadcastReceiver?, filter: IntentFilter?): Intent? {
        return if (Build.VERSION.SDK_INT >= 33) {
            super.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            super.registerReceiver(receiver, filter)
        }
    }

    override fun registerReceiver(
        receiver: BroadcastReceiver?,
        filter: IntentFilter?,
        broadcastPermission: String?,
        scheduler: android.os.Handler?
    ): Intent? {
        return if (Build.VERSION.SDK_INT >= 33) {
            super.registerReceiver(receiver, filter, broadcastPermission, scheduler, Context.RECEIVER_NOT_EXPORTED)
        } else {
            super.registerReceiver(receiver, filter, broadcastPermission, scheduler)
        }
    }
}
