package com.shopcarbon.gradingai.ui

import android.os.Build
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.ui.graphics.Color
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
    @Composable
    fun Toggle(title: String, on: Boolean, divider: Boolean, enabled: Boolean = true, set: (Boolean) -> Unit) =
        ListRow(title, divider = divider, trailing = { Switch(on, set, enabled = enabled, colors = SwitchDefaults.colors(checkedTrackColor = Palette.ok, checkedThumbColor = Color.White)) })

    Page("Settings", onBack = { nav.back() }) {
        Group(header = "Account") {
            ListRow("Signed in as", trailing = { Text(app.vault.email() ?: "—", style = MaterialTheme.typography.bodyMedium, color = Palette.muted) })
            Toggle(if (canFinger) "Unlock with fingerprint" else "Fingerprint not set up on this phone", finger, divider = true, enabled = canFinger) { finger = it; app.prefs.biometricLock = it }
            ListRow("Sign out", divider = true, titleColor = Palette.bad) { app.vault.clear(); onSignOut() }
        }
        Group(header = "Camera", footer = "Test mode: phones without a depth sensor — ARCore's depth-from-motion; scans go to review only, never to the item.") {
            Toggle("Capture by itself when all green", auto, divider = false) { auto = it; app.prefs.autoCapture = it }
            ListRow("Depth sensor and accuracy check", divider = true, chevron = true) { nav.go(Screen.Probe) }
            Toggle("Test mode", testMode, divider = true) { testMode = it; app.prefs.testMode = it }
        }
        Group(header = "This phone") {
            ListRow("Model", trailing = { Text(Build.MODEL, style = MaterialTheme.typography.bodyMedium, color = Palette.muted) })
            ListRow("Depth sensor phone", divider = true, trailing = { Text(if (phoneSupported(app)) "Yes" else "No", style = MaterialTheme.typography.bodyMedium, color = Palette.muted) })
            val cal = app.prefs.calibration
            ListRow(
                "Scale correction", subtitle = if (app.prefs.calibratedAt > 0) "Calibrated ${DateFormat.getDateTimeInstance().format(Date(app.prefs.calibratedAt))}" else null, divider = true,
                trailing = { Text(if (cal == 1f) "None" else "×${"%.4f".format(cal)}", style = MaterialTheme.typography.bodyMedium, color = Palette.muted) },
            )
            if (cal != 1f) ListRow("Clear the scale correction", divider = true, titleColor = Palette.accent) { app.prefs.calibration = 1f; app.prefs.calibratedAt = 0; msg = "Scale correction cleared." }
        }
        Group(header = "CarbonWMS") {
            ListRow("AI assist", trailing = { Text(if (cfg?.aiEnabled == true) cfg.aiModel ?: "On" else "Off", style = MaterialTheme.typography.bodyMedium, color = Palette.muted) })
            ListRow("Scan photos", divider = true, trailing = { Text(if (cfg?.dropbox == true) "Dropbox" else "CarbonWMS only", style = MaterialTheme.typography.bodyMedium, color = Palette.muted) })
            ListRow("Waiting to send", divider = true, trailing = { Text("$pending", style = MaterialTheme.typography.bodyMedium, color = Palette.muted) })
            if (pending > 0) ListRow("Send now", divider = true, titleColor = Palette.accent) { ScanStore.schedule(ctx); msg = "Sending in the background." }
        }
        Card {
            OutlinedTextField(origin, { origin = it }, Modifier.fillMaxWidth(), label = { Text("Server") }, singleLine = true)
            if (origin != app.prefs.origin) Secondary("Use this server") { app.prefs.origin = origin; msg = "Server changed — sign in again if asked." }
        }
        Group(header = "App") {
            val rel = cfg?.app
            val newer = rel != null && Updater.newer(rel.latestVersion)
            ListRow(
                "Version ${BuildConfig.VERSION_NAME}",
                subtitle = if (newer) "Version ${rel!!.latestVersion} is ready.${rel.notes?.let { " $it" } ?: ""}" else "Up to date — new versions install by themselves.",
                trailing = if (newer) ({ Badge(if (progress != null) "Updating…" else "Update", Palette.accent, solid = true) }) else null,
                onClick = if (newer && progress == null) ({
                    progress = 0f
                    scope.launch { try { Updater.run(ctx, rel) { s -> msg = s } } finally { progress = null } }
                }) else null,
            )
        }
        msg?.let { Notice(it, Palette.accent) }
    }
}
