package com.shopcarbon.gradingai.ui

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import androidx.core.content.ContextCompat
import com.google.android.gms.common.moduleinstall.ModuleInstall
import com.google.android.gms.common.moduleinstall.ModuleInstallRequest
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import org.json.JSONObject
import android.net.Uri
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.shopcarbon.gradingai.App
import com.shopcarbon.gradingai.BuildConfig

/**
 * Carbon Studio and the SEO writer: the WMS's own screens, inside the app,
 * on the WMS session. Whatever changes on the desktop is here at once.
 *
 * The WebView must be told to fill its space (MATCH_PARENT): with Android's
 * default WRAP_CONTENT the page's viewport height is 0, so anything sized in
 * dvh — the WMS's product window on phones — collapses to one pixel and the
 * screen just looks dimmed (seen on the S25, 2026-10-13).
 */
@Composable
fun WebScreen(nav: Nav, title: String, path: String) {
    var view by remember { mutableStateOf<WebView?>(null) }
    BackHandler { val v = view; if (v != null && v.canGoBack()) v.goBack() else nav.back() }
    Column(Modifier.fillMaxSize().background(Palette.ground)) {
        Row(Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 4.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { nav.back() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = Palette.text) }
            Text(title, style = MaterialTheme.typography.titleLarge, color = Palette.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Spacer(Modifier.width(8.dp))
        }
        WmsWebView(path, Modifier.weight(1f).fillMaxWidth().navigationBarsPadding()) { view = it }
    }
}

/**
 * Bulk Studio tab (owner, 2026-10-22): CarbonWMS's own Bulk Studio — the same
 * settings, models and prompts as the desktop, and it only ever sends to the
 * OpenAI batch. CarbonWMS shows it without its menus inside the app (it sees
 * "CarbonGradingAI" in the user agent); the app's tab bar stays docked below.
 */
@Composable
fun BulkStudioScreen(nav: Nav) {
    var view by remember { mutableStateOf<WebView?>(null) }
    BackHandler { val v = view; if (v != null && v.canGoBack()) v.goBack() else nav.home() }
    Column(Modifier.fillMaxSize().background(Palette.ground)) {
        // The page carries its own "Bulk Studio" heading.
        WmsWebView("/inventory/bulk-studio", Modifier.weight(1f).fillMaxWidth().statusBarsPadding()) { view = it }
        Box(Modifier.fillMaxWidth().background(Palette.ground).navigationBarsPadding().padding(horizontal = 16.dp, vertical = 8.dp)) {
            BottomTabs(Tab.Studio) { onTab(nav, it) }
        }
    }
}

/**
 * A CarbonWMS page on the app's session. The WebView must fill its space
 * (MATCH_PARENT): with Android's default WRAP_CONTENT the page's viewport
 * height is 0, so anything sized in dvh collapses (seen on the S25, 2026-10-13).
 * File inputs (Studio's Upload) open the phone's picker.
 */
@SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
@Composable
fun WmsWebView(path: String, modifier: Modifier, onView: (WebView) -> Unit = {}) {
    val ctx = LocalContext.current
    val app = App.get(ctx)
    var progress by remember { mutableIntStateOf(0) }
    var pending by remember { mutableStateOf<ValueCallback<Array<Uri>>?>(null) }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        pending?.onReceiveValue(uris.toTypedArray())
        pending = null
    }
    /* The page's own camera (Studio's phone camera, the browser barcode reader):
       granted for CarbonWMS pages once the app holds the camera permission. */
    var camAsk by remember { mutableStateOf<PermissionRequest?>(null) }
    val askCamera = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        camAsk?.let { if (ok) it.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) else it.deny() }
        camAsk = null
    }
    val scanner = remember {
        GmsBarcodeScanning.getClient(ctx, GmsBarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_CODE_93, Barcode.FORMAT_CODE_128, Barcode.FORMAT_CODE_39, Barcode.FORMAT_UPC_A, Barcode.FORMAT_EAN_13, Barcode.FORMAT_QR_CODE)
            .enableAutoZoom().build())
    }
    Column(modifier) {
        if (progress in 1..99) LinearProgressIndicator(progress = { progress / 100f }, modifier = Modifier.fillMaxWidth())
        Box(Modifier.weight(1f).fillMaxWidth()) {
            AndroidView({ ctx ->
                app.api.syncWebCookie()
                WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
                WebView(ctx).apply {
                    layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    settings.mediaPlaybackRequiresUserGesture = true
                    settings.userAgentString = settings.userAgentString + " CarbonGradingAI"
                    val web = this
                    // window.CarbonWMSPC — the same bridge CarbonWMS-PC gives the page: the hang-tag scan button
                    // uses Google's native scanner here (fast focus, reads a creased tag).
                    addJavascriptInterface(object {
                        @JavascriptInterface fun version(): String = BuildConfig.VERSION_NAME
                        @JavascriptInterface fun device(): String = android.os.Build.MODEL
                        @JavascriptInterface fun setBusy(label: String, busy: Boolean) {}
                        @JavascriptInterface fun log(msg: String) {}
                        @JavascriptInterface fun scanBarcode(id: String) {
                            web.post {
                                fun reply(ok: Boolean, text: String) = web.evaluateJavascript(
                                    "window.__cwmsResolve && window.__cwmsResolve(${JSONObject.quote(id)}, $ok, ${JSONObject.quote(text)})", null,
                                )
                                fun start() = scanner.startScan()
                                    .addOnSuccessListener { b -> reply(true, b.rawValue?.trim().orEmpty()) }
                                    .addOnCanceledListener { reply(false, "") }
                                    .addOnFailureListener { reply(false, it.message ?: "Scanner unavailable") }
                                // Google's scanner is a Play services module: fetch it first (once per phone), as Home does.
                                runCatching {
                                    ModuleInstall.getClient(ctx).installModules(ModuleInstallRequest.newBuilder().addApi(scanner).build())
                                        .addOnSuccessListener { start() }.addOnFailureListener { start() }
                                }.onFailure { start() }
                            }
                        }
                    }, "CarbonWMSPCNative")
                    webViewClient = object : WebViewClient() {
                        override fun onPageStarted(v: WebView?, url: String?, favicon: android.graphics.Bitmap?) { v?.evaluateJavascript(BRIDGE_SHIM, null) }
                        override fun onPageFinished(v: WebView?, url: String?) { v?.evaluateJavascript(BRIDGE_SHIM, null) }
                    }
                    webChromeClient = object : WebChromeClient() {
                        override fun onPermissionRequest(request: PermissionRequest) {
                            web.post {
                                val ours = request.origin?.host.equals(Uri.parse(app.prefs.origin).host, ignoreCase = true)
                                if (!ours || PermissionRequest.RESOURCE_VIDEO_CAPTURE !in request.resources) { request.deny(); return@post }
                                if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                                    request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                                } else { camAsk = request; askCamera.launch(Manifest.permission.CAMERA) }
                            }
                        }
                        override fun onProgressChanged(v: WebView?, p: Int) { progress = p }
                        override fun onShowFileChooser(v: WebView?, cb: ValueCallback<Array<Uri>>?, params: FileChooserParams?): Boolean {
                            pending?.onReceiveValue(null)
                            pending = cb
                            val type = params?.acceptTypes?.firstOrNull { it.isNotBlank() } ?: "image/*"
                            return try { pick.launch(type); true } catch (_: Exception) { pending = null; false }
                        }
                    }
                    loadUrl(app.prefs.origin + path)
                    onView(this)
                }
            }, Modifier.fillMaxSize())
        }
    }
}

/** window.CarbonWMSPC over the raw interface, with promises (the shape CarbonWMS-PC's shim gives the page). */
private const val BRIDGE_SHIM = """
(function () {
  if (window.__cgaiShim || !window.CarbonWMSPCNative) return;
  window.__cgaiShim = true;
  var N = window.CarbonWMSPCNative, pending = {}, seq = 0;
  window.__cwmsResolve = function (id, ok, msg) { var p = pending[id]; if (!p) return; delete pending[id]; p({ ok: !!ok, message: msg }); };
  window.CarbonWMSPC = {
    version: N.version(), device: N.device(),
    setBusy: function (label, busy) { try { N.setBusy(String(label || ''), !!busy); } catch (e) {} },
    log: function (m) { try { N.log(String(m)); } catch (e) {} },
    scanBarcode: function () { return new Promise(function (res) { var id = 's' + (++seq); pending[id] = res; N.scanBarcode(id); }); }
  };
})();
"""
