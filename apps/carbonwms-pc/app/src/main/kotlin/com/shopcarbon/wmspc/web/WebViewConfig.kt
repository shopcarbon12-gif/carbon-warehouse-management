package com.shopcarbon.wmspc.web

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebSettings
import android.webkit.WebView
import com.shopcarbon.wmspc.BuildConfig
import com.shopcarbon.wmspc.R

/** Shared WebView settings for the main view and pop-up children. */
object WebViewConfig {
    @SuppressLint("SetJavaScriptEnabled")
    fun apply(web: WebView, ctx: Context) {
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            useWideViewPort = true
            loadWithOverviewMode = true
            // The site deliberately allows pinch-zoom (a11y) — keep it, hide the +/- buttons.
            builtInZoomControls = true
            displayZoomControls = false
            // The web app POSTs ZPL to http://<zebra>/pstprnt from the HTTPS page; cleartext is still
            // limited to the printer IPs by network_security_config.xml.
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            mediaPlaybackRequiresUserGesture = false
            javaScriptCanOpenWindowsAutomatically = true
            setSupportMultipleWindows(true)
            cacheMode = WebSettings.LOAD_DEFAULT
            allowFileAccess = false
            allowContentAccess = true
            userAgentString = userAgent(userAgentString)
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(web, false)
        }
        web.setBackgroundColor(ctx.getColor(R.color.wms_bg))
        web.overScrollMode = View.OVER_SCROLL_NEVER
    }

    fun userAgent(base: String): String =
        "$base CarbonWMS-PC/${BuildConfig.VERSION_NAME} (${Build.MANUFACTURER} ${Build.MODEL}; Android ${Build.VERSION.RELEASE})"
}
