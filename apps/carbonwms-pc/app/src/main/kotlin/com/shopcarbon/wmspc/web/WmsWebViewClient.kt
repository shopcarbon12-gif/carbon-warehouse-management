package com.shopcarbon.wmspc.web

import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import com.shopcarbon.wmspc.MainActivity
import com.shopcarbon.wmspc.util.Diag

/**
 * URL policy + error handling.
 *  - same-origin navigations stay in the WebView (main view or pop-up sheet)
 *  - anything else (Shopify, Lightspeed, Senitron, rewards admin, mailto:, tel:) goes to the system browser
 *  - main-frame network errors show the native offline page; TLS errors are never bypassed
 */
class WmsWebViewClient(private val a: MainActivity, private val isPopup: Boolean) : WebViewClient() {

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val u = request.url
        val scheme = u.scheme?.lowercase()
        if ((scheme == "http" || scheme == "https") && u.host.equals(a.originHost, ignoreCase = true)) {
            return false
        }
        Diag.log("external → $u")
        a.openExternal(u)
        if (isPopup) a.popup.close()
        return true
    }

    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
        if (!isPopup) a.hideOffline()
        if (Uri.parse(url).path == "/login") Diag.log("session: at /login")
    }

    override fun onPageFinished(view: WebView, url: String) {
        view.evaluateJavascript(JsShims.SOURCE, null)
        if (isPopup) a.popup.onTitle(view.title, url)
    }

    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
        if (!request.isForMainFrame) return
        Diag.log("main-frame error ${error.errorCode} ${error.description} ${request.url}")
        if (!isPopup) a.showOffline(MainActivity.OfflineKind.fromWebError(a, error.errorCode))
    }

    override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
        handler.cancel()
        Diag.log("TLS error ${error.primaryError} for ${error.url}")
        if (!isPopup) a.showOffline(MainActivity.OfflineKind.TLS)
    }

    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        Diag.log("renderer gone (crash=${detail.didCrash()}) popup=$isPopup")
        if (isPopup) a.popup.close() else a.recreate()
        return true
    }
}
