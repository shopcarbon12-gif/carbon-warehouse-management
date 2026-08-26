package com.shopcarbon.wmspc.update

import android.webkit.CookieManager
import com.google.android.material.snackbar.Snackbar
import com.shopcarbon.wmspc.BuildConfig
import com.shopcarbon.wmspc.MainActivity
import com.shopcarbon.wmspc.R
import com.shopcarbon.wmspc.util.Diag
import com.shopcarbon.wmspc.util.Prefs
import com.shopcarbon.wmspc.web.DownloadBridge
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * OTA self-update through the WMS (same transport as the handheld app).
 * Dormant by design until the server gains a "pc" release channel (report §7.2): the banner only
 * appears when the status JSON explicitly says channel == "pc", so the handheld release can never
 * be offered to this app by mistake. Until then, distribute the APK by adb / Dropbox.
 */
object UpdateChecker {
    fun check(a: MainActivity) {
        thread(name = "update-check") {
            try {
                val origin = Prefs.origin
                val url = "$origin/api/mobile/status?channel=pc&androidId=${Prefs.installId}&version=${BuildConfig.VERSION_NAME}"
                val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 8000
                    readTimeout = 8000
                    setRequestProperty("Accept", "application/json")
                    CookieManager.getInstance().getCookie(origin)?.let { setRequestProperty("Cookie", it) }
                }
                val code = conn.responseCode
                val body = (if (code in 200..299) conn.inputStream else conn.errorStream)?.bufferedReader()?.readText().orEmpty()
                conn.disconnect()
                if (code !in 200..299) {
                    Diag.log("update check: HTTP $code")
                    return@thread
                }
                val json = JSONObject(body)
                val isPcChannel = json.optString("channel") == "pc"
                val latest = json.optString("latestVersion")
                val downloadUrl = json.optString("downloadUrl")
                Diag.log("update check: channel=${json.optString("channel", "-")} latest=$latest available=${json.optBoolean("updateAvailable")}")
                if (!isPcChannel || !json.optBoolean("updateAvailable") || downloadUrl.isBlank()) return@thread
                a.runOnUiThread {
                    Snackbar.make(a.findViewById(R.id.root), a.getString(R.string.update_available, latest), Snackbar.LENGTH_INDEFINITE)
                        .setAction(R.string.update_install) {
                            DownloadBridge.enqueue(a, downloadUrl, "CarbonWMS-PC V$latest.apk", DownloadBridge.APK_MIME)
                        }
                        .show()
                }
            } catch (e: Exception) {
                Diag.log("update check failed: $e")
            }
        }
    }
}
