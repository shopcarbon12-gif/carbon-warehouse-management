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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.lifecycleScope
import com.shopcarbon.gradingai.auth.Biometric
import com.shopcarbon.gradingai.ui.CaptureScreen
import com.shopcarbon.gradingai.ui.GradingTheme
import com.shopcarbon.gradingai.ui.GuideScreen
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
        enableEdgeToEdge()
        // Measuring is hands-busy work: the screen stays on while the app is open.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val app = App.get(this)
        locked.value = app.prefs.biometricLock && app.vault.hasLogin()
        setContent {
            GradingTheme {
                val nav = remember { Nav(if (app.vault.hasLogin()) Screen.Home else Screen.Login).also { this.nav = it } }
                if (locked.value) { LockScreen { locked.value = false }; return@GradingTheme }
                BackHandler(enabled = nav.stack.size > 1) { nav.back() }
                Box(Modifier.fillMaxSize().background(Palette.ground)) {
                    when (val s = nav.top) {
                        Screen.Login -> LoginScreen { nav.reset(Screen.Home) }
                        Screen.Home -> HomeScreen(nav)
                        Screen.Queue -> QueueScreen(nav)
                        is Screen.Guide -> GuideScreen(nav, s.profileId)
                        is Screen.Item -> ItemScreen(nav, s.lookup, s.preSize)
                        is Screen.Capture -> CaptureScreen(nav, s.target, s.crotchFor)
                        is Screen.Result -> ResultScreen(nav, s.session)
                        is Screen.Saved -> SavedScreen(nav, s.session, s.result, s.queuedOffline)
                        is Screen.Web -> WebScreen(nav, s.title, s.path)
                        Screen.Settings -> SettingsScreen(nav) { nav.reset(Screen.Login) }
                        Screen.Probe -> ProbeScreen(nav)
                    }
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
            val idle = when (nav?.top) { Screen.Home, Screen.Queue, Screen.Settings, is Screen.Guide, Screen.Login, null -> true; else -> false }
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
            Text("CarbonGradingAI", style = MaterialTheme.typography.headlineSmall, color = Palette.text)
            Muted("Locked — use your fingerprint to open it.")
            err?.let { Muted(it) }
            Primary("Unlock") { ask() }
        }
    }
}
