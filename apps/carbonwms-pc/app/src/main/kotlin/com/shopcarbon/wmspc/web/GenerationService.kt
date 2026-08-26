package com.shopcarbon.wmspc.web

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import com.shopcarbon.wmspc.MainActivity
import com.shopcarbon.wmspc.R
import com.shopcarbon.wmspc.util.Diag

/**
 * Keeps the app running while Carbon Studio renders panels.
 *
 * A panel takes OpenAI 60–90 s. Android freezes a backgrounded process within
 * seconds, which stops the page's JavaScript — so switching apps mid-run used to
 * mean the operator came back to nothing. With this foreground service the
 * WebView keeps working while they are in another app, and the finished crops
 * are simply there when they return. (The server also parks every render, so
 * even a killed app recovers — this is what makes it seamless instead.)
 */
class GenerationService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val label = intent?.getStringExtra(EXTRA_LABEL) ?: DEFAULT_LABEL
        startForeground(NOTIFICATION_ID, buildNotification(label), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        return START_NOT_STICKY
    }

    private fun buildNotification(label: String): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, getString(R.string.gen_channel_name), NotificationManager.IMPORTANCE_LOW).apply {
                description = getString(R.string.gen_channel_desc)
                setShowBadge(false)
            },
        )
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_generating)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(label)
            .setOngoing(true)
            .setContentIntent(open)
            .setProgress(0, 0, true)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "carbonwms_generation"
        private const val NOTIFICATION_ID = 4201
        private const val EXTRA_LABEL = "label"
        private const val DEFAULT_LABEL = "Working…"
        /** Safety net: never hold the service if the page forgets to clear its busy flag. */
        private const val MAX_RUN_MS = 15 * 60_000L

        private var active = 0
        private val handler = Handler(Looper.getMainLooper())
        private var watchdog: Runnable? = null

        /** Called from the page through the JS bridge: `CarbonWMSPC.setBusy(label, true/false)`. */
        fun setBusy(ctx: Context, label: String, busy: Boolean) {
            if (busy) {
                active++
                if (active == 1) start(ctx, label)
            } else {
                active = (active - 1).coerceAtLeast(0)
                if (active == 0) stop(ctx)
            }
            Diag.log("generation busy=$busy active=$active ($label)")
        }

        private fun start(ctx: Context, label: String) {
            runCatching {
                ctx.startForegroundService(Intent(ctx, GenerationService::class.java).putExtra(EXTRA_LABEL, label))
                watchdog?.let(handler::removeCallbacks)
                watchdog = Runnable {
                    Diag.log("generation watchdog fired — releasing service")
                    active = 0
                    stop(ctx)
                }.also { handler.postDelayed(it, MAX_RUN_MS) }
            }.onFailure { Diag.log("generation service start failed: $it") }
        }

        private fun stop(ctx: Context) {
            watchdog?.let(handler::removeCallbacks)
            watchdog = null
            runCatching { ctx.stopService(Intent(ctx, GenerationService::class.java)) }
                .onFailure { Diag.log("generation service stop failed: $it") }
        }

        /** Activity going away for good — never leave the notification behind. */
        fun forceStop(ctx: Context) {
            if (active == 0 && watchdog == null) return
            active = 0
            stop(ctx)
        }
    }
}
