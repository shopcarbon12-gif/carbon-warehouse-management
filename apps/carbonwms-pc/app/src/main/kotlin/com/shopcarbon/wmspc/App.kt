package com.shopcarbon.wmspc

import android.app.Application
import android.webkit.CookieManager
import android.webkit.WebView
import com.shopcarbon.wmspc.util.Diag
import com.shopcarbon.wmspc.util.Prefs

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Diag.init(this)
        Prefs.init(this)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        // Owner decision D3: the operator logs in again every time the app is completely closed.
        // A fresh process start means the app was closed (swiped away, back-exited or killed),
        // so the WMS session cookie is dropped here. localStorage (theme, font scale) is kept.
        runCatching {
            CookieManager.getInstance().removeAllCookies(null)
            CookieManager.getInstance().flush()
        }
        Diag.log("App start v${BuildConfig.VERSION_NAME} (${BuildConfig.APPLICATION_ID}); session cookies cleared")
    }
}
