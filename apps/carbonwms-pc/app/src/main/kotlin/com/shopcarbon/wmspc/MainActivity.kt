package com.shopcarbon.wmspc

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.provider.MediaStore
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.SystemBarStyle
import androidx.activity.addCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isVisible
import com.shopcarbon.wmspc.auth.LoginSheet
import com.shopcarbon.wmspc.settings.DiagnosticsActivity
import com.shopcarbon.wmspc.update.UpdateChecker
import com.shopcarbon.wmspc.util.Diag
import com.shopcarbon.wmspc.util.Prefs
import com.shopcarbon.wmspc.web.DownloadBridge
import com.shopcarbon.wmspc.web.EngineGate
import com.shopcarbon.wmspc.web.GenerationService
import com.shopcarbon.wmspc.web.NativeBridge
import com.shopcarbon.wmspc.web.PopupSheet
import com.shopcarbon.wmspc.web.WebViewConfig
import com.shopcarbon.wmspc.web.WmsChromeClient
import com.shopcarbon.wmspc.web.WmsWebViewClient
import java.io.File

/**
 * Single-activity shell around https://wms.shopcarbon.com. The web app is the UI; this class
 * provides what a browser normally does: session persistence, file chooser + camera, downloads,
 * pop-ups, dialogs, print, offline page, back navigation, keep-screen-on, insets.
 */
class MainActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_RELOAD = "reload"
        private const val BACK_EXIT_WINDOW_MS = 2000L
    }

    enum class OfflineKind(val detailRes: Int) {
        NETWORK(R.string.offline_network),
        SERVER(R.string.offline_server),
        TLS(R.string.offline_tls);

        companion object {
            fun fromWebError(ctx: Context, errorCode: Int): OfflineKind {
                if (errorCode == WebViewClient.ERROR_FAILED_SSL_HANDSHAKE) return TLS
                val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
                return if (cm.activeNetwork == null) NETWORK else SERVER
            }
        }
    }

    lateinit var web: WebView
        private set
    lateinit var popup: PopupSheet
        private set
    lateinit var loginSheet: LoginSheet
        private set

    val origin: String get() = Prefs.origin
    val originHost: String? get() = Prefs.originHost()

    private lateinit var root: FrameLayout
    private lateinit var offline: View
    private lateinit var customViewContainer: FrameLayout
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null
    private var lastBackAt = 0L
    private var gateOpen = false
    private var clearHistoryOnNextLoad = false

    // ---- file chooser ------------------------------------------------------------------------
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var cameraUri: Uri? = null
    private val fileChooserLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
        val cb = fileCallback ?: return@registerForActivityResult
        fileCallback = null
        val uris = mutableListOf<Uri>()
        if (res.resultCode == RESULT_OK) {
            val data = res.data
            val clip = data?.clipData
            when {
                clip != null -> for (i in 0 until clip.itemCount) uris += clip.getItemAt(i).uri
                data?.data != null -> uris += data.data!!
                cameraUri != null -> uris += cameraUri!!
            }
        }
        Diag.log("file chooser → ${uris.size} file(s)")
        cb.onReceiveValue(uris.toTypedArray())
        cameraUri = null
    }

    // ---- camera permission -------------------------------------------------------------------
    private var pendingPermission: ((Boolean) -> Unit)? = null
    private val cameraPermissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        Diag.log("camera permission granted=$granted")
        pendingPermission?.invoke(granted)
        pendingPermission = null
    }

    /** Notifications carry the "still generating" foreground service and the update banner. */
    private val notificationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            Diag.log("notification permission granted=$granted")
        }

    private val connectivity by lazy { getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager }
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            runOnUiThread {
                if (::offline.isInitialized && offline.isVisible) {
                    Diag.log("network back → reload")
                    hideOffline()
                    reloadOrStart()
                }
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT))
        setContentView(R.layout.activity_main)

        root = findViewById(R.id.root)
        web = findViewById(R.id.web)
        offline = findViewById(R.id.offline)
        customViewContainer = findViewById(R.id.custom_view_container)

        // Edge-to-edge (targetSdk 35): pad natively — Android WebView does not populate env(safe-area-inset-*).
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, ins ->
            val b = ins.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
            v.setPadding(b.left, b.top, b.right, b.bottom)
            WindowInsetsCompat.CONSUMED
        }

        if (!EngineGate.check(this)) {
            gateOpen = true
            return
        }

        WebViewConfig.apply(web, this)
        web.addJavascriptInterface(NativeBridge(this) { web }, NativeBridge.NAME)
        web.webViewClient = WmsWebViewClient(this, isPopup = false)
        web.webChromeClient = WmsChromeClient(this, isPopup = false)
        web.setDownloadListener(DownloadBridge(this))
        DownloadBridge.registerApkInstaller(this)

        popup = PopupSheet(this, findViewById(R.id.popup_container))
        loginSheet = LoginSheet(this, findViewById(R.id.login_container))

        offline.findViewById<Button>(R.id.offline_retry).setOnClickListener { hideOffline(); reloadOrStart() }
        offline.findViewById<Button>(R.id.offline_diagnostics).setOnClickListener {
            startActivity(Intent(this, DiagnosticsActivity::class.java))
        }

        onBackPressedDispatcher.addCallback(this) { handleBack() }

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        val url = startUrl(intent)
        Diag.log("load $url")
        web.loadUrl(url)
        UpdateChecker.check(this)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (gateOpen) return
        when {
            intent.getBooleanExtra(EXTRA_RELOAD, false) -> web.loadUrl("$origin/dashboard")
            intent.data?.host.equals(originHost, ignoreCase = true) -> web.loadUrl(intent.data.toString())
        }
    }

    override fun onStart() {
        super.onStart()
        runCatching { connectivity.registerDefaultNetworkCallback(networkCallback) }
    }

    override fun onResume() {
        super.onResume()
        applyScreenPolicy()
    }

    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush()
    }

    override fun onStop() {
        super.onStop()
        runCatching { connectivity.unregisterNetworkCallback(networkCallback) }
    }

    override fun onDestroy() {
        if (isFinishing) {
            GenerationService.forceStop(this)
            // Owner decision D3: leaving the app (back-exit / swipe away) ends the WMS session.
            runCatching {
                CookieManager.getInstance().removeAllCookies(null)
                CookieManager.getInstance().flush()
            }
            Diag.log("finishing → session cookies cleared")
        }
        if (::popup.isInitialized) popup.close()
        if (::web.isInitialized && !gateOpen) {
            (web.parent as? ViewGroup)?.removeView(web)
            web.destroy()
        }
        super.onDestroy()
    }

    // ---- navigation --------------------------------------------------------------------------

    private fun startUrl(intent: Intent?): String {
        val d = intent?.data
        return if (d != null && d.host.equals(originHost, ignoreCase = true)) d.toString() else "$origin/dashboard"
    }

    private fun reloadOrStart() {
        val current = web.url
        if (current.isNullOrBlank() || current == "about:blank") web.loadUrl(startUrl(intent)) else web.reload()
    }

    /** The main WebView reached /login → native sign-in sheet (biometric when a login is saved). */
    fun onWebLoginPage(next: String?) {
        if (::loginSheet.isInitialized) loginSheet.onLoginPage(next)
    }

    /** Native sign-in succeeded: the cookie is set, continue to `next` and drop /login from history. */
    fun onLoggedIn(next: String?) {
        val path = next?.takeIf { it.startsWith("/") && !it.startsWith("//") } ?: "/dashboard"
        clearHistoryOnNextLoad = true
        Diag.log("logged in → $path")
        web.loadUrl("$origin$path")
    }

    fun onPageLoaded() {
        if (clearHistoryOnNextLoad) {
            clearHistoryOnNextLoad = false
            web.clearHistory()
        }
    }

    private fun handleBack() {
        when {
            customViewCallback != null -> hideCustomView()
            popup.isOpen -> popup.close()
            loginSheet.isVisible -> confirmExit()
            offline.isVisible -> confirmExit()
            web.canGoBack() -> web.goBack()
            else -> confirmExit()
        }
    }

    private fun confirmExit() {
        val now = SystemClock.elapsedRealtime()
        if (now - lastBackAt < BACK_EXIT_WINDOW_MS) {
            finish()
        } else {
            lastBackAt = now
            Toast.makeText(this, R.string.back_again, Toast.LENGTH_SHORT).show()
        }
    }

    fun openExternal(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, R.string.no_app_for_link, Toast.LENGTH_SHORT).show()
        }
    }

    // ---- screen policy -----------------------------------------------------------------------

    private fun applyScreenPolicy() {
        if (Prefs.keepScreenOn) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    // ---- offline page ------------------------------------------------------------------------

    fun showOffline(kind: OfflineKind) {
        offline.findViewById<TextView>(R.id.offline_detail).setText(kind.detailRes)
        offline.isVisible = true
    }

    fun hideOffline() {
        if (::offline.isInitialized) offline.isVisible = false
    }

    // ---- fullscreen (video) ------------------------------------------------------------------

    fun showCustomView(view: View, callback: WebChromeClient.CustomViewCallback) {
        hideCustomView()
        customViewCallback = callback
        customViewContainer.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        customViewContainer.isVisible = true
    }

    fun hideCustomView() {
        val cb = customViewCallback ?: return
        customViewCallback = null
        customViewContainer.removeAllViews()
        customViewContainer.isVisible = false
        cb.onCustomViewHidden()
    }

    // ---- camera permission -------------------------------------------------------------------

    fun withCameraPermission(callback: (Boolean) -> Unit) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            callback(true)
            return
        }
        pendingPermission?.invoke(false)
        pendingPermission = callback
        cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
    }

    // ---- file chooser ------------------------------------------------------------------------

    /**
     * One sheet for every <input type=file>: Files (+ mime filter) with Photo Picker and Camera as
     * extra entries whenever images are acceptable — including the empty `accept` the Studio tab
     * uses on coarse pointers to escape the Photo-Picker-only path.
     */
    fun launchFileChooser(params: WebChromeClient.FileChooserParams, callback: ValueCallback<Array<Uri>>) {
        fileCallback?.onReceiveValue(emptyArray())
        fileCallback = callback
        val accept = params.acceptTypes.filter { it.isNotBlank() }
        val wantsImage = accept.isEmpty() || accept.any { it.startsWith("image", ignoreCase = true) }
        val multiple = params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE
        Diag.log("file chooser accept=$accept multiple=$multiple")
        if (wantsImage) {
            withCameraPermission { granted -> launchChooser(accept, wantsImage = true, withCamera = granted, multiple = multiple) }
        } else {
            launchChooser(accept, wantsImage = false, withCamera = false, multiple = multiple)
        }
    }

    private fun launchChooser(accept: List<String>, wantsImage: Boolean, withCamera: Boolean, multiple: Boolean) {
        val files = Intent(Intent.ACTION_GET_CONTENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            val mimes = mimeTypes(accept)
            if (mimes.isNotEmpty()) putExtra(Intent.EXTRA_MIME_TYPES, mimes.toTypedArray())
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple)
        }
        val extras = mutableListOf<Intent>()
        if (wantsImage) {
            extras += Intent(MediaStore.ACTION_PICK_IMAGES).apply {
                type = "image/*"
                if (multiple) putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, MediaStore.getPickImagesMaxLimit())
            }
            if (withCamera) {
                val uri = newCameraUri()
                cameraUri = uri
                extras += Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
                    putExtra(MediaStore.EXTRA_OUTPUT, uri)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                }
            }
        }
        val chooser = Intent.createChooser(files, getString(R.string.chooser_title)).apply {
            if (extras.isNotEmpty()) putExtra(Intent.EXTRA_INITIAL_INTENTS, extras.toTypedArray())
        }
        try {
            fileChooserLauncher.launch(chooser)
        } catch (e: ActivityNotFoundException) {
            Diag.log("file chooser unavailable: $e")
            fileCallback?.onReceiveValue(emptyArray())
            fileCallback = null
        }
    }

    private fun newCameraUri(): Uri {
        val dir = File(cacheDir, "camera").apply { mkdirs() }
        val file = File(dir, "capture-${System.currentTimeMillis()}.jpg")
        return FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
    }

    private fun mimeTypes(accept: List<String>): List<String> {
        val out = linkedSetOf<String>()
        for (raw in accept) {
            val a = raw.trim().lowercase()
            when {
                a.contains('/') -> out += a
                a == ".csv" -> out += listOf("text/csv", "text/comma-separated-values", "text/plain", "application/octet-stream")
                a == ".xlsx" -> out += "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                a == ".xls" -> out += "application/vnd.ms-excel"
                a == ".xlsm" -> out += "application/vnd.ms-excel.sheet.macroenabled.12"
                a == ".apk" -> out += DownloadBridge.APK_MIME
                a == ".png" -> out += "image/png"
                a == ".jpg" || a == ".jpeg" -> out += "image/jpeg"
                a == ".pdf" -> out += "application/pdf"
                else -> return emptyList() // unknown extension → don't filter at all
            }
        }
        return out.toList()
    }
}
