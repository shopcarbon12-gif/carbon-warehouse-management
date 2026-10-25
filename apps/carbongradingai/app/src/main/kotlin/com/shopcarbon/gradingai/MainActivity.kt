package com.shopcarbon.gradingai

import android.os.Bundle
import android.os.SystemClock
import android.view.WindowManager
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.lifecycleScope
import com.shopcarbon.gradingai.auth.Biometric
import com.shopcarbon.gradingai.ui.AppLogo
import com.shopcarbon.gradingai.ui.BulkStudioScreen
import com.shopcarbon.gradingai.ui.CaptureScreen
import com.shopcarbon.gradingai.ui.CatalogScreen
import com.shopcarbon.gradingai.ui.CompareDoneScreen
import com.shopcarbon.gradingai.ui.CompareScreen
import com.shopcarbon.gradingai.ui.EditSavedScreen
import com.shopcarbon.gradingai.ui.ProductScreen
import com.shopcarbon.gradingai.ui.ToCheckScreen
import com.shopcarbon.gradingai.ui.GradingTheme
import com.shopcarbon.gradingai.ui.GuideScreen
import com.shopcarbon.gradingai.ui.SocialEditScreen
import com.shopcarbon.gradingai.ui.SocialPostScreen
import com.shopcarbon.gradingai.ui.SocialScreen
import com.shopcarbon.gradingai.ui.WmsCatalogScreen
import com.shopcarbon.gradingai.ui.WmsProductScreen
import com.shopcarbon.gradingai.ui.ZoomHost
import com.shopcarbon.gradingai.ui.HomeScreen
import com.shopcarbon.gradingai.ui.ItemScreen
import com.shopcarbon.gradingai.ui.LoginScreen
import com.shopcarbon.gradingai.ui.Muted
import com.shopcarbon.gradingai.ui.Nav
import com.shopcarbon.gradingai.ui.Palette
import com.shopcarbon.gradingai.ui.Primary
import com.shopcarbon.gradingai.ui.ProbeScreen
import com.shopcarbon.gradingai.ui.QueueScreen
import com.shopcarbon.gradingai.ui.ResultScreen
import com.shopcarbon.gradingai.ui.SavedScreen
import com.shopcarbon.gradingai.ui.Screen
import com.shopcarbon.gradingai.ui.SettingsScreen
import com.shopcarbon.gradingai.ui.WebScreen
import com.shopcarbon.gradingai.update.Updater
import kotlinx.coroutines.launch

// FragmentActivity (not plain ComponentActivity): the fingerprint prompt needs it.
class MainActivity : FragmentActivity() {
    private var nav: Nav? = null
    private var locked = mutableStateOf(false)
    private var stoppedAt = 0L
    private var lastUpdateCheck = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Light screens: dark status-bar icons (the camera draws its own dark glass).
        enableEdgeToEdge(
            statusBarStyle = androidx.activity.SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
            navigationBarStyle = androidx.activity.SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
        )
        // Measuring is hands-busy work: the screen stays on while the app is open.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val app = App.get(this)
        /* Debug builds only: sign in with a session token handed in by adb, so the
           screens can be checked on the emulator. Never present in a release APK. */
        if (BuildConfig.DEBUG) intent.getStringExtra("debugToken")?.let { t ->
            app.vault.saveLogin(intent.getStringExtra("debugEmail") ?: "debug@local", "debug")
            app.vault.setToken(t)
            app.prefs.biometricLock = false
        }
        locked.value = app.prefs.biometricLock && app.vault.hasLogin()
        setContent {
            GradingTheme {
                val nav = remember {
                    Nav(if (app.vault.hasLogin()) Screen.Home else Screen.Login).also { n ->
                        this.nav = n
                        // Debug builds only: open a saved scan straight away (emulator checks).
                        if (BuildConfig.DEBUG) intent.getStringExtra("debugScan")?.let { n.go(Screen.EditSaved(it)) }
                        // Debug builds only: open Compare for "<matrixId>:<size>" (emulator checks).
                        if (BuildConfig.DEBUG) intent.getStringExtra("debugCompare")?.split(":")?.takeIf { it.size == 2 }?.let { (m, z) ->
                            lifecycleScope.launch { runCatching { n.go(Screen.Compare(app.api.lookupMatrix(m), z)) } }
                        }
                        // Debug builds only: open a hang-tag code as if it was scanned (emulator checks).
                        if (BuildConfig.DEBUG) intent.getStringExtra("debugCode")?.let { code ->
                            lifecycleScope.launch { runCatching { n.go(Screen.Item(app.api.lookupCode(code))) } }
                        }
                    }
                }
                if (locked.value) { LockScreen { locked.value = false }; return@GradingTheme }
                BackHandler(enabled = nav.stack.size > 1) { nav.back() }
                Box(Modifier.fillMaxSize().background(Palette.ground)) {
                    when (val s = nav.top) {
                        Screen.Login -> LoginScreen { nav.reset(Screen.Home) }
                        Screen.Home -> HomeScreen(nav)
                        is Screen.Catalog -> CatalogScreen(nav, s.focus)
                        Screen.WmsCatalog -> WmsCatalogScreen(nav)
                        is Screen.WmsProduct -> WmsProductScreen(nav, s.product)
                        Screen.Social -> SocialScreen(nav)
                        is Screen.SocialPost -> key(s) { SocialPostScreen(nav, s.post) }
                        is Screen.SocialEdit -> key(s) { SocialEditScreen(nav, s.post) }
                        Screen.Studio -> BulkStudioScreen(nav)
                        is Screen.Product -> ProductScreen(nav, s.lookup)
                        Screen.Queue -> QueueScreen(nav)
                        Screen.ToCheck -> ToCheckScreen(nav)
                        is Screen.EditSaved -> key(s) { EditSavedScreen(nav, s.scanId) }
                        is Screen.Compare -> key(s) { CompareScreen(nav, s.lookup, s.size) }
                        is Screen.CompareDone -> CompareDoneScreen(nav, s.mine, s.fromName, s.result)
                        is Screen.Guide -> GuideScreen(nav, s.profileId)
                        is Screen.Item -> ItemScreen(nav, s.lookup, s.preSize)
                        // Keyed by the screen itself: photo 1 → photo 2 replaces one Capture with another, and without
                        // a key the second kept the first's state (still "processing", already fired, camera wired to
                        // photo 1) so it never captured (owner, 2026-10-20).
                        is Screen.Capture -> key(s) { CaptureScreen(nav, s.target, s.crotchFor) }
                        is Screen.Result -> key(s) { ResultScreen(nav, s.session) }
                        is Screen.Saved -> SavedScreen(nav, s.session, s.result, s.queuedOffline)
                        is Screen.Web -> WebScreen(nav, s.title, s.path)
                        Screen.Settings -> SettingsScreen(nav) { nav.reset(Screen.Login) }
                        Screen.Probe -> ProbeScreen(nav)
                    }
                    ZoomHost()
                }
            }
        }
    }

    override fun onStop() {
        super.onStop()
        stoppedAt = SystemClock.elapsedRealtime()
    }

    override fun onStart() {
        super.onStart()
        val app = App.get(this)
        // Locked again after five minutes away.
        if (stoppedAt > 0 && SystemClock.elapsedRealtime() - stoppedAt > 5 * 60_000 && app.prefs.biometricLock && app.vault.hasLogin()) locked.value = true
    }

    override fun onResume() {
        super.onResume()
        checkForUpdate()
    }

    /** OTA: on start and on every return (at most every 10 minutes), never in the middle of a measurement. */
    private fun checkForUpdate() {
        val app = App.get(this)
        if (!app.vault.hasLogin()) return
        val now = SystemClock.elapsedRealtime()
        if (lastUpdateCheck != 0L && now - lastUpdateCheck < 10 * 60_000) return
        lastUpdateCheck = now
        lifecycleScope.launch {
            runCatching { app.config = app.api.config() }
            val idle = when (nav?.top) { Screen.Home, is Screen.Catalog, Screen.WmsCatalog, is Screen.WmsProduct, Screen.Social, is Screen.SocialPost, is Screen.SocialEdit, Screen.Studio, Screen.Queue, Screen.ToCheck, Screen.Settings, is Screen.Guide, is Screen.Product, Screen.Login, null -> true; else -> false }
            if (idle) Updater.run(this@MainActivity, app.config?.app)
        }
    }

    @androidx.compose.runtime.Composable
    private fun LockScreen(onUnlocked: () -> Unit) {
        var err by remember { mutableStateOf<String?>(null) }
        fun ask() = Biometric.prompt(this, onUnlocked) { err = it }
        LaunchedEffect(Unit) { ask() }
        Column(
            Modifier.fillMaxSize().background(Palette.ground).padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            AppLogo(Modifier.size(96.dp))
            Text("CarbonTools", style = MaterialTheme.typography.headlineSmall, color = Palette.text)
            Muted("Locked — use your fingerprint to open it.")
            err?.let { Muted(it) }
            Primary("Unlock") { ask() }
        }
    }
}
