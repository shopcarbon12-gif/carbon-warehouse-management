package com.shopcarbon.gradingai.ui

import android.graphics.BitmapFactory
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.shopcarbon.gradingai.App
import com.shopcarbon.gradingai.measure.AiState
import com.shopcarbon.gradingai.measure.DepthFacts
import com.shopcarbon.gradingai.measure.MLine
import com.shopcarbon.gradingai.measure.MeasureSession
import com.shopcarbon.gradingai.measure.MeasureTarget
import com.shopcarbon.gradingai.measure.Photo
import com.shopcarbon.gradingai.measure.Pt
import com.shopcarbon.gradingai.measure.Scan
import com.shopcarbon.gradingai.measure.Units
import com.shopcarbon.gradingai.vision.Mask
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import kotlin.math.abs

private class Loaded(val session: MeasureSession, val savedCm: Map<String, Double>, val savedAt: String?, val status: String)

/**
 * Edit a scan that is already in CarbonWMS (owner, 2026-10-22: "open the
 * picture with the scan points with manual edit mode"): its photo and lines,
 * the same editor as after a capture; Save sends the moved lines back and
 * CarbonWMS works the numbers out again on every item the scan wrote.
 */
@Composable
fun EditSavedScreen(nav: Nav, scanId: String) {
    val ctx = LocalContext.current
    val app = App.get(ctx)
    val scope = rememberCoroutineScope()
    var loaded by remember { mutableStateOf<Loaded?>(null) }
    var err by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    var done by remember { mutableStateOf<String?>(null) }
    var selected by remember { mutableStateOf<String?>(null) }
    var units by remember { mutableStateOf(app.prefs.units) }

    LaunchedEffect(scanId) {
        try {
            val j = app.api.scan(scanId)
            val lookup = app.api.lookupMatrix(j.getString("matrix_id"))
            val profile = app.config?.profile(j.optString("profile")) ?: throw IllegalStateException("Unknown garment type \"${j.optString("profile")}\" — open the app once online.")
            val skuRow = lookup.sizes.firstOrNull { it.customSkuId == j.optString("custom_sku_id") } ?: lookup.sizes.first()
            val label = (j.optString("size").ifBlank { skuRow.size ?: "" }).trim().uppercase()
            val dir = File(ctx.cacheDir, "edit/$scanId").apply { mkdirs() }
            suspend fun scanOf(which: String?, lines: JSONObject, pxPerCm: Double): Scan {
                val f = downloadToFile(app, "/api/grading-app/scans/$scanId/photo" + (which?.let { "?which=$it" } ?: ""), File(dir, "${which ?: "photo"}.jpg"))
                val bmp = withContext(Dispatchers.IO) { BitmapFactory.decodeFile(f.path) } ?: throw IllegalStateException("The saved photo could not be read.")
                return Scan(
                    id = "$scanId-${which ?: "main"}", photo = bmp, photoFile = f, mask = Mask(1, 1), pxPerCm = pxPerCm,
                    outline = parseLines(lines), unsure = emptySet(),
                    depth = DepthFacts(0.0, 0.0, 0.0, 0.0, 0.0, true, 1f, pxPerCm, 0, "saved scan"),
                    warnings = emptyList(), capturedAt = System.currentTimeMillis(),
                )
            }
            val main = scanOf(null, j.optJSONObject("lines") ?: JSONObject(), j.getDouble("px_per_cm"))
            val session = MeasureSession(MeasureTarget(lookup, label, skuRow, profile), main, testPhone = false)
            j.optJSONObject("crotch")?.let { c ->
                if (!j.isNull("crotch_photo_key")) session.restoreCrotch(scanOf("crotch", c.optJSONObject("lines") ?: JSONObject(), c.getDouble("pxPerCm")))
            }
            val pc = j.optJSONObject("points_cm") ?: JSONObject()
            loaded = Loaded(session, pc.keys().asSequence().associateWith { pc.optDouble(it) }, j.optString("created_at"), j.optString("status"))
        } catch (e: Exception) {
            err = e.message ?: "Could not open the scan"
        }
    }

    val l = loaded
    Page(
        "Edit points", onBack = { nav.back() }, largeTitle = false,
        bottom = if (l == null) null else ({
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Secondary("Undo", Modifier.padding(end = 0.dp).weight(0.35f), enabled = l.session.canUndo) { l.session.undo() }
                Primary(if (saving) "Saving…" else "Save changes to CarbonWMS", Modifier.weight(1f), enabled = !saving && l.status != "redo") {
                    saving = true; err = null
                    scope.launch {
                        try {
                            val s = l.session
                            fun json(m: Map<String, MLine>) = JSONObject().apply { m.forEach { (k, v) -> put(k, v.toJson()) } }
                            val res = app.api.adjustScan(scanId, json(s.lines.toMap()), s.crotch?.let { json(it.lines.toMap()) })
                            done = "Saved — ${res.optInt("updated")} item rows updated in CarbonWMS."
                        } catch (e: Exception) { err = e.message ?: "Could not save" } finally { saving = false }
                    }
                }
            }
        }),
    ) {
        err?.let { Notice(it, Palette.bad) }
        if (l == null) { if (err == null) Muted("Loading the saved scan…"); return@Page }
        val s = l.session
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("${s.target.lookup.name} · ${s.target.sizeLabel}", style = MaterialTheme.typography.headlineSmall, color = Palette.text)
            Text(
                "Saved ${ago(l.savedAt)}" + if (l.status == "redo") " · taken back (Redo) — measure it again instead" else "",
                style = MaterialTheme.typography.labelMedium, color = Palette.muted,
                modifier = Modifier.background(Palette.raised, RoundedCornerShape(50)).padding(horizontal = 10.dp, vertical = 4.dp),
            )
        }
        done?.let { Notice(it, Palette.ok) }
        when (val a = s.ai) {
            is AiState.Running -> Notice("AI is placing the points again…", Palette.ai)
            is AiState.Failed -> Notice("AI assist failed: ${a.message}", Palette.warn)
            else -> {}
        }
        val allCm = s.allCm()
        // Two photos on one screen: each kept short, so the page can be scrolled from beside them.
        val frac = if (s.crotch != null) 0.4f else 0.55f
        PhotoEditor(s, Photo.MAIN, selected, units, allCm, maxHeightFraction = frac, onSelect = { selected = it })
        if (s.crotch != null) {
            Muted("Photo 2 · ${s.profile.secondTitle}")
            PhotoEditor(s, Photo.CROTCH, selected, units, allCm, maxHeightFraction = frac, onSelect = { selected = it })
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Pill("Ask AI again") { s.startAi(app) }
            for ((k, label) in listOf("cm" to "CM", "in" to "INCH")) Pill(label, filled = units == k) { units = k; app.prefs.units = k }
        }
        Group {
            var i = 0
            for (p in s.profile.points) {
                val now = allCm[p.key] ?: continue
                val was = l.savedCm[p.key]
                val line = s.lines[p.key] ?: s.crotch?.lines?.get(p.key)
                val changed = was != null && abs(was - now) >= 0.05
                ListRow(
                    p.label, divider = i++ > 0,
                    trailing = {
                        Text(
                            if (changed) "${Units.show(was!!, units)} → ${Units.show(now, units)}" else Units.show(now, units),
                            style = MaterialTheme.typography.bodyLarge, color = Palette.text, fontWeight = FontWeight.SemiBold,
                        )
                        if (changed) Badge("Edited", Palette.accent, solid = true) else if (line?.source == "ai") Badge("AI", Palette.ai)
                    },
                    onClick = { selected = p.key },
                )
            }
        }
        Text("Moved lines are kept as yours; untouched ones keep where they came from.", style = MaterialTheme.typography.bodySmall, color = Palette.muted, modifier = Modifier.fillMaxWidth())
    }
}

private fun parseLines(o: JSONObject): Map<String, MLine> {
    val out = LinkedHashMap<String, MLine>()
    for (k in o.keys()) {
        val l = o.optJSONObject(k) ?: continue
        val pts = l.optJSONArray("pts") ?: continue
        val list = (0 until pts.length()).mapNotNull { i -> pts.optJSONArray(i)?.let { Pt(it.optDouble(0).toFloat(), it.optDouble(1).toFloat()) } }
        if (list.size >= 2) out[k] = MLine(list, l.optString("source", "outline"), l.optBoolean("moved"))
    }
    return out
}
