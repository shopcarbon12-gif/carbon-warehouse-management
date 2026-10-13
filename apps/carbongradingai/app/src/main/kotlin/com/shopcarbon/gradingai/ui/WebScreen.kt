package com.shopcarbon.gradingai.ui

import android.annotation.SuppressLint
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import com.shopcarbon.gradingai.App

/**
 * Carbon Studio and the SEO writer: the WMS's own screens, inside the app,
 * on the WMS session. Whatever changes on the desktop is here at once.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun WebScreen(nav: Nav, title: String, path: String) {
    val app = App.get(LocalContext.current)
    var progress by remember { mutableIntStateOf(0) }
    var view by remember { mutableStateOf<WebView?>(null) }
    BackHandler { val v = view; if (v != null && v.canGoBack()) v.goBack() else nav.back() }
    Page(title, onBack = { nav.back() }, scroll = false) {
        if (progress in 1..99) LinearProgressIndicator(progress = { progress / 100f })
        Box(Modifier.fillMaxSize()) {
            AndroidView({ ctx ->
                app.api.syncWebCookie()
                WebView(ctx).apply {
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    settings.mediaPlaybackRequiresUserGesture = true
                    settings.userAgentString = settings.userAgentString + " CarbonGradingAI"
                    webViewClient = WebViewClient()
                    webChromeClient = object : WebChromeClient() { override fun onProgressChanged(v: WebView?, p: Int) { progress = p } }
                    loadUrl(app.prefs.origin + path)
                    view = this
                }
            }, Modifier.fillMaxSize())
        }
        if (view == null) Text("Loading…", style = MaterialTheme.typography.bodySmall, color = Palette.muted)
    }
}
