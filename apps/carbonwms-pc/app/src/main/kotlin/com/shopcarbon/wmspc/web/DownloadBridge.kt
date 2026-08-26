package com.shopcarbon.wmspc.web

import android.app.Activity
import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Environment
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.URLUtil
import android.widget.Toast
import androidx.core.content.ContextCompat
import com.shopcarbon.wmspc.R
import com.shopcarbon.wmspc.util.Diag

/**
 * Server downloads (Content-Disposition: attachment — CSV/XLSX exports, APK) → DownloadManager,
 * forwarding the WMS session cookie so cookie-gated routes work. APKs from the WMS open the installer.
 * blob:/data: URLs are handled by the injected JS shim (JsShims) instead.
 */
class DownloadBridge(private val a: Activity) : DownloadListener {

    override fun onDownloadStart(url: String, userAgent: String?, contentDisposition: String?, mimetype: String?, contentLength: Long) {
        if (url.startsWith("blob:") || url.startsWith("data:")) {
            Diag.log("download: $url left to the JS shim")
            return
        }
        enqueue(a, url, URLUtil.guessFileName(url, contentDisposition, mimetype), mimetype, userAgent)
    }

    companion object {
        const val APK_MIME = "application/vnd.android.package-archive"
        private val apkIds = mutableSetOf<Long>()
        private var receiverRegistered = false

        fun enqueue(ctx: Context, url: String, fileName: String?, mime: String?, userAgent: String? = null): Long? {
            val name = fileName?.takeIf { it.isNotBlank() } ?: URLUtil.guessFileName(url, null, mime)
            return runCatching {
                val req = DownloadManager.Request(Uri.parse(url))
                    .setTitle(name)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
                mime?.let { req.setMimeType(it) }
                CookieManager.getInstance().getCookie(url)?.let { req.addRequestHeader("Cookie", it) }
                userAgent?.let { req.addRequestHeader("User-Agent", it) }
                val dm = ctx.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
                val id = dm.enqueue(req)
                if (mime == APK_MIME || name.endsWith(".apk", ignoreCase = true)) apkIds += id
                Diag.log("download #$id $name ($mime) ← $url")
                Toast.makeText(ctx, ctx.getString(R.string.download_started, name), Toast.LENGTH_SHORT).show()
                id
            }.onFailure { Diag.log("download failed: $it") }.getOrNull()
        }

        /** Opens the package installer when a tracked APK download completes (OTA self-update). */
        fun registerApkInstaller(ctx: Context) {
            if (receiverRegistered) return
            receiverRegistered = true
            val receiver = object : BroadcastReceiver() {
                override fun onReceive(c: Context, intent: Intent) {
                    val id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1)
                    if (id < 0 || !apkIds.remove(id)) return
                    val dm = c.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
                    val uri = dm.getUriForDownloadedFile(id) ?: return
                    runCatching {
                        c.startActivity(
                            Intent(Intent.ACTION_VIEW)
                                .setDataAndType(uri, APK_MIME)
                                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                    }.onFailure { Diag.log("apk install intent failed: $it") }
                }
            }
            ContextCompat.registerReceiver(
                ctx.applicationContext,
                receiver,
                IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),
                ContextCompat.RECEIVER_EXPORTED,
            )
        }
    }
}
