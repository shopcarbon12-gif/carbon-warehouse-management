package com.shopcarbon.gradingai.ui

import android.os.Build
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import com.shopcarbon.gradingai.App
import com.shopcarbon.gradingai.BuildConfig
import com.shopcarbon.gradingai.sync.ScanStore
import com.shopcarbon.gradingai.update.Updater
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

@Composable
fun SettingsScreen(nav: Nav, onSignOut: () -> Unit) {
    val ctx = LocalContext.current
    val app = App.get(ctx)
    val scope = rememberCoroutineScope()
    var origin by remember { mutableStateOf(app.prefs.origin) }
    var testMode by remember { mutableStateOf(app.prefs.testMode) }
    var auto by remember { mutableStateOf(app.prefs.autoCapture) }
    var finger by remember { mutableStateOf(app.prefs.biometricLock) }
    val canFinger = remember { (ctx as? androidx.fragment.app.FragmentActivity)?.let { com.shopcarbon.gradingai.auth.Biometric.available(it) } == true }
    var msg by remember { mutableStateOf<String?>(null) }
    var progress by remember { mutableStateOf<Float?>(null) }
    val pending = remember { ScanStore.pending(ctx).size }
    val cfg = app.config
    Page("Settings", onBack = { nav.back() }) {
        Card {
            Label("Account")
            KeyValue("Signed in as", app.vault.email() ?: "—")
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(if (canFinger) "Unlock with fingerprint" else "Fingerprint not set up on this phone", Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, color = Palette.text)
                Switch(finger, { finger = it; app.prefs.biometricLock = it }, enabled = canFinger)
            }
            Secondary("Sign out") { app.vault.clear(); onSignOut() }
        }
        Card {
            Label("This phone")
            KeyValue("Model", Build.MODEL)
            KeyValue("Depth sensor phone", if (phoneSupported(app)) "yes" else "no")
            val cal = app.prefs.calibration
            KeyValue("Scale correction", if (cal == 1f) "none" else "×${"%.4f".format(cal)}")
            if (app.prefs.calibratedAt > 0) Muted("Calibrated ${DateFormat.getDateTimeInstance().format(Date(app.prefs.calibratedAt))}")
            Secondary("Depth sensor and accuracy check") { nav.go(Screen.Probe) }
            if (cal != 1f) Secondary("Clear the scale correction") { app.prefs.calibration = 1f; app.prefs.calibratedAt = 0; msg = "Scale correction cleared." }
        }
        Card {
            Label("Capture")
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("Capture by itself when everything is green", Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, color = Palette.text)
                Switch(auto, { auto = it; app.prefs.autoCapture = it })
            }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("Test mode (phones without a depth sensor)", Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, color = Palette.text)
                Switch(testMode, { testMode = it; app.prefs.testMode = it })
            }
            Muted("Test mode uses ARCore's depth-from-motion. Scans are saved for review only and never written to the item.")
        }
        Card {
            Label("WMS")
            KeyValue("AI assist", if (cfg?.aiEnabled == true) cfg.aiModel ?: "on" else "off")
            KeyValue("Scan photos", if (cfg?.dropbox == true) "Dropbox › ${cfg.dropboxFolder}" else "WMS only")
            KeyValue("Waiting to upload", "$pending")
            if (pending > 0) Secondary("Upload now") { ScanStore.schedule(ctx); msg = "Uploading in the background." }
            OutlinedTextField(origin, { origin = it }, Modifier.fillMaxWidth(), label = { Text("Server") }, singleLine = true)
            if (origin != app.prefs.origin) Secondary("Use this server") { app.prefs.origin = origin; msg = "Server changed — sign in again if asked." }
        }
        Card {
            Label("App")
            KeyValue("Version", BuildConfig.VERSION_NAME)
            val rel = cfg?.app
            if (rel != null && Updater.newer(rel.latestVersion)) {
                Notice("Version ${rel.latestVersion} is ready.${rel.notes?.let { " $it" } ?: ""}", Palette.accent)
                Primary(progress?.let { "Updating…" } ?: "Update now", enabled = progress == null) {
                    progress = 0f
                    scope.launch {
                        try { Updater.run(ctx, rel) { s -> msg = s } } finally { progress = null }
                    }
                }
            } else Muted("Up to date. New versions install by themselves when you open the app.")
        }
        msg?.let { Notice(it, Palette.accent) }
    }
}
