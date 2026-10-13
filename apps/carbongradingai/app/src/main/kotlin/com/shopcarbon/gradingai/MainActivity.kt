package com.shopcarbon.gradingai

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import com.shopcarbon.gradingai.ui.CaptureScreen
import com.shopcarbon.gradingai.ui.GradingTheme
import com.shopcarbon.gradingai.ui.GuideScreen
import com.shopcarbon.gradingai.ui.HomeScreen
import com.shopcarbon.gradingai.ui.ItemScreen
import com.shopcarbon.gradingai.ui.LoginScreen
import com.shopcarbon.gradingai.ui.Nav
import com.shopcarbon.gradingai.ui.Palette
import com.shopcarbon.gradingai.ui.ProbeScreen
import com.shopcarbon.gradingai.ui.QueueScreen
import com.shopcarbon.gradingai.ui.ResultScreen
import com.shopcarbon.gradingai.ui.SavedScreen
import com.shopcarbon.gradingai.ui.Screen
import com.shopcarbon.gradingai.ui.SettingsScreen
import com.shopcarbon.gradingai.ui.WebScreen

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // Measuring is hands-busy work: the screen stays on while the app is open.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val app = App.get(this)
        setContent {
            GradingTheme {
                val nav = remember { Nav(if (app.vault.hasLogin()) Screen.Home else Screen.Login) }
                BackHandler(enabled = nav.stack.size > 1) { nav.back() }
                Box(Modifier.fillMaxSize().background(Palette.ground)) {
                    when (val s = nav.top) {
                        Screen.Login -> LoginScreen { nav.reset(Screen.Home) }
                        Screen.Home -> HomeScreen(nav)
                        Screen.Queue -> QueueScreen(nav)
                        is Screen.Guide -> GuideScreen(nav, s.profileId)
                        is Screen.Item -> ItemScreen(nav, s.lookup, s.preSize)
                        is Screen.Capture -> CaptureScreen(nav, s.target)
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
}
