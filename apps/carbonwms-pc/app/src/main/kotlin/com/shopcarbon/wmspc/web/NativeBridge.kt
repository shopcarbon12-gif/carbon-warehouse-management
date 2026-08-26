package com.shopcarbon.wmspc.web

import android.os.Build
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.Toast
import com.shopcarbon.wmspc.BuildConfig
import com.shopcarbon.wmspc.MainActivity
import com.shopcarbon.wmspc.R
import com.shopcarbon.wmspc.util.Diag
import org.json.JSONObject
import kotlin.concurrent.thread

/**
 * Raw JS interface (window.CarbonWMSPCNative). JsShims wraps it as window.CarbonWMSPC with promises.
 * Methods run on a WebView background thread — UI work is posted to the main thread.
 */
class NativeBridge(private val a: MainActivity, private val webProvider: () -> WebView) {

    companion object {
        const val NAME = "CarbonWMSPCNative"
    }

    @JavascriptInterface
    fun version(): String = BuildConfig.VERSION_NAME

    @JavascriptInterface
    fun device(): String = "${Build.MANUFACTURER} ${Build.MODEL} / Android ${Build.VERSION.RELEASE}"

    /** window.print() replacement → Android print dialog for the calling WebView. */
    @JavascriptInterface
    fun print() {
        a.runOnUiThread { PrintBridge.print(a, webProvider()) }
    }

    /** blob: download from the page → Downloads/<name>. */
    @JavascriptInterface
    fun saveBlob(name: String, mime: String, base64: String): Boolean {
        val bytes = runCatching { Base64.decode(base64, Base64.DEFAULT) }.getOrNull() ?: return false
        val ok = Downloads.saveBytes(a, name, mime.ifBlank { "application/octet-stream" }, bytes)
        a.runOnUiThread {
            Toast.makeText(a, if (ok) a.getString(R.string.saved_to_downloads, name) else "Download failed: $name", Toast.LENGTH_SHORT).show()
        }
        return ok
    }

    /** <a download href="https://…"> → DownloadManager (cookies forwarded for the WMS origin). */
    @JavascriptInterface
    fun downloadUrl(url: String, name: String) {
        a.runOnUiThread { DownloadBridge.enqueue(a, url, name.ifBlank { null }, null, webProvider().settings.userAgentString) }
    }

    /**
     * Raw ZPL over TCP 9100 (the transport that works with the ZD500R where HTTP /pstprnt does not).
     * Dormant until the web app calls window.CarbonWMSPC.printZpl(host, port, zpl) — see report §7.5.
     */
    @JavascriptInterface
    fun printZpl(requestId: String, host: String, port: Int, zpl: String) {
        thread(name = "zpl-print") {
            val (ok, msg) = ZplPrinter.send(host, if (port > 0) port else 9100, zpl)
            Diag.log("printZpl $host:$port ok=$ok $msg")
            a.runOnUiThread {
                val js = "window.__cwmsResolve && window.__cwmsResolve(${JSONObject.quote(requestId)}, $ok, ${JSONObject.quote(msg)})"
                webProvider().evaluateJavascript(js, null)
            }
        }
    }

    @JavascriptInterface
    fun log(msg: String) {
        Diag.log("page: $msg")
    }
}
