package com.shopcarbon.wmspc.web

import android.content.Intent
import android.net.Uri
import androidx.webkit.WebViewCompat
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.shopcarbon.wmspc.BuildConfig
import com.shopcarbon.wmspc.MainActivity
import com.shopcarbon.wmspc.R
import com.shopcarbon.wmspc.util.Diag

/**
 * Safety net: the web app's bundle targets Chrome 111+. Any Play-updated phone is far above that;
 * if a device somehow is not, explain the fix instead of rendering a broken page.
 */
object EngineGate {
    fun check(a: MainActivity): Boolean {
        val pkg = WebViewCompat.getCurrentWebViewPackage(a)
        val version = pkg?.versionName ?: "unknown"
        val major = version.substringBefore('.').toIntOrNull()
        Diag.log("WebView provider ${pkg?.packageName} $version")
        if (pkg == null || major == null || major >= BuildConfig.MIN_WEBVIEW_MAJOR) return true

        MaterialAlertDialogBuilder(a)
            .setTitle(R.string.engine_title)
            .setMessage(a.getString(R.string.engine_message, version, BuildConfig.MIN_WEBVIEW_MAJOR))
            .setCancelable(false)
            .setPositiveButton(R.string.engine_update) { _, _ ->
                a.openExternal(Uri.parse("market://details?id=${pkg.packageName}"))
                a.finish()
            }
            .setNeutralButton(R.string.retry) { _, _ -> a.recreate() }
            .show()
        return false
    }
}
