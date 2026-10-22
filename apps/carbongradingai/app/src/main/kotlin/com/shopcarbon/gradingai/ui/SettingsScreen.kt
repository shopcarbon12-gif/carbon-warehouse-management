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
        AiSwitch(app) { msg = it }
        Group(header = "Camera", footer ="Test mode: phones without a depth sensor — ARCore's depth-from-motion; scans go to review only, never to the item.") {
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

/** One area of the AI switch, as CarbonWMS reports it. */
private data class AiArea(val id: String, val label: String, val on: Boolean, val usd: Double?, val calls: Int, val estimate: Boolean, val model: String?)

/**
 * The AI switch (owner, 2026-10-22): on/off and which areas the AI places, with
 * what each area costs per size. Kept on CarbonWMS, so every phone follows it;
 * areas that are off are measured from the outline and can be fixed later on
 * the saved photo.
 */
@Composable
private fun AiSwitch(app: App, say: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    var enabled by remember { mutableStateOf<Boolean?>(null) }
    var model by remember { mutableStateOf<String?>(null) }
    var areas by remember { mutableStateOf<List<AiArea>>(emptyList()) }
    var busy by remember { mutableStateOf(false) }
    fun read(j: org.json.JSONObject) {
        enabled = j.optJSONObject("settings")?.optBoolean("enabled", true) ?: true
        model = j.optString("model").takeIf { it.isNotBlank() && it != "null" }
        val arr = j.optJSONArray("areas") ?: org.json.JSONArray()
        areas = (0 until arr.length()).map { i ->
            val a = arr.getJSONObject(i)
            AiArea(a.getString("id"), a.optString("label"), a.optBoolean("on"), if (a.isNull("usd")) null else a.optDouble("usd"), a.optInt("calls"), a.optBoolean("estimate"), a.optString("model").takeIf { it.isNotBlank() && it != "null" })
        }
    }
    androidx.compose.runtime.LaunchedEffect(Unit) {
        runCatching { read(app.api.aiSettings()) }.onFailure { say("Could not read the AI switch: ${it.message}") }
    }
    fun save(on: Boolean, next: List<AiArea>) {
        val before = enabled to areas
        enabled = on; areas = next; busy = true
        scope.launch {
            try {
                read(app.api.saveAiSettings(on, next.associate { it.id to it.on }))
                // The scan screens read the switch from the config.
                runCatching { app.config = app.api.config() }
            } catch (e: Exception) {
                enabled = before.first; areas = before.second
                say(e.message ?: "Could not save the AI switch")
            } finally { busy = false }
        }
    }
    fun cents(usd: Double?) = usd?.let { if (it * 100 < 0.95) "%.1f¢".format(it * 100) else "${(it * 100).roundToIntSafe()}¢" }
    val on = enabled
    val perSize = { ids: List<String> -> areas.filter { it.on && it.id in ids }.mapNotNull { it.usd }.sum() }
    Group(
        header = "AI",
        footer = if (on == null) null else buildString {
            append("Cost per size${model?.let { " with $it" } ?: ""}, from the last 30 days of scans; ≈ is an estimate until scans come in. ")
            if (on) append("With these areas: a T-shirt size ≈ ${cents(perSize(listOf("sleeves", "chest", "other")))}, a jeans size ≈ ${cents(perSize(listOf("crotch", "other")))}. ")
            append("Areas that are off are measured from the outline — fix them on the scan or later on CarbonWMS.")
        },
    ) {
        if (on == null) { ListRow("Loading…"); return@Group }
        ListRow("AI assist", subtitle = if (on) "Places the points you choose below" else "Off — no AI cost", trailing = {
            Switch(on, { save(it, areas) }, enabled = !busy, colors = SwitchDefaults.colors(checkedTrackColor = Palette.ok, checkedThumbColor = Color.White))
        })
        for (a in areas) {
            val cost = (cents(a.usd)?.let { c -> if (a.estimate || a.calls == 0) "≈ $c a size" else "$c a size · ${a.calls} scan${if (a.calls == 1) "" else "s"}" } ?: "no price yet") +
                (a.model?.takeIf { it != model }?.let { " · $it" } ?: "")
            ListRow(a.label, subtitle = cost, divider = true, trailing = {
                Switch(a.on, { v -> save(on, areas.map { if (it.id == a.id) it.copy(on = v) else it }) }, enabled = on && !busy,
                    colors = SwitchDefaults.colors(checkedTrackColor = Palette.ok, checkedThumbColor = Color.White))
            })
        }
    }
}

private fun Double.roundToIntSafe(): Int = kotlin.math.round(this).toInt()
