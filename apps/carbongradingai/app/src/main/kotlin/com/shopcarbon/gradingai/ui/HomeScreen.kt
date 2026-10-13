package com.shopcarbon.gradingai.ui

import android.os.Build
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.shopcarbon.gradingai.App
import com.shopcarbon.gradingai.model.Queue
import com.shopcarbon.gradingai.sync.ScanStore
import kotlinx.coroutines.launch

/** True when this phone is one of the depth-sensor Samsungs the app measures on. */
fun phoneSupported(app: App): Boolean {
    val list = app.config?.supportedModels ?: listOf("SM-N975", "SM-N976", "SM-G986", "SM-G988")
    return list.any { Build.MODEL.uppercase().startsWith(it) }
}

@Composable
fun HomeScreen(nav: Nav) {
    val app = App.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    var queue by remember { mutableStateOf<Queue?>(null) }
    var err by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf<String?>(null) }
    var typed by remember { mutableStateOf("") }
    val pending = remember { ScanStore.pending(app).size }

    LaunchedEffect(Unit) {
        runCatching { app.config = app.api.config() }
        runCatching { queue = app.api.queue() }.onFailure { err = it.message }
    }
    fun open(code: String) {
        busy = "Finding $code…"; err = null
        scope.launch {
            try { nav.go(Screen.Item(app.api.lookupCode(code))) } catch (e: Exception) { err = e.message } finally { busy = null }
        }
    }
    val scanner = remember {
        GmsBarcodeScanning.getClient(app, GmsBarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_CODE_93, Barcode.FORMAT_CODE_128, Barcode.FORMAT_CODE_39, Barcode.FORMAT_UPC_A, Barcode.FORMAT_EAN_13, Barcode.FORMAT_QR_CODE)
            .enableAutoZoom().build())
    }

    Page(
        "CarbonGradingAI",
        actions = { IconButton(onClick = { nav.go(Screen.Settings) }) { Icon(Icons.Filled.Settings, "Settings", tint = Palette.muted) } },
        bottom = { BottomTabs(Tab.Measure) { onTab(nav, it, app) } },
    ) {
        if (!phoneSupported(app)) {
            Notice(
                if (app.prefs.testMode) "Test mode: this ${Build.MODEL} has no time-of-flight depth sensor. Scans are saved for review only, never written to the item."
                else "This phone (${Build.MODEL}) has no depth sensor the app can measure with. Use a Galaxy Note10+, Note10+ 5G, S20+ or S20 Ultra — or turn on test mode in Settings to try the app.",
            )
        }
        Card {
            Label("Catalogue progress")
            val q = queue
            if (q == null) Muted(if (err != null) "Offline — ${err}" else "Loading…") else {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.Bottom) {
                    Text("Sizes measured", style = MaterialTheme.typography.bodyMedium, color = Palette.muted)
                    Text("${q.measured} / ${q.total}", style = MaterialTheme.typography.titleLarge, color = Palette.text)
                }
                LinearProgressIndicator(
                    progress = { if (q.total > 0) q.measured.toFloat() / q.total else 0f },
                    modifier = Modifier.fillMaxWidth().height(8.dp).clip(RoundedCornerShape(4.dp)),
                    color = Palette.accent, trackColor = Palette.raised,
                )
                Muted("One garment per cut and size covers every colour and print in that cut.")
            }
            if (pending > 0) Muted("$pending saved on the phone, waiting to upload.")
        }
        Primary(busy ?: "Scan hang tag", enabled = busy == null) {
            scanner.startScan().addOnSuccessListener { b -> b.rawValue?.let { open(it) } }.addOnFailureListener { err = it.message }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(typed, { typed = it }, Modifier.weight(1f), label = { Text("Type SKU or UPC") }, singleLine = true)
            Secondary("Find", Modifier.height(56.dp), enabled = typed.isNotBlank() && busy == null) { open(typed.trim()) }
        }
        err?.let { if (queue != null) Notice(it, Palette.bad) }
        queue?.let { q ->
            if (q.entries.isNotEmpty()) {
                Label("Measure next")
                for (e in q.entries.take(4)) Card(Modifier.clickable { openEntry(nav, app, scope, e.matrixId, e.size) { m -> err = m } }) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("${e.name} · ${e.size}", style = MaterialTheme.typography.titleMedium, color = Palette.text, modifier = Modifier.weight(1f))
                        Text(if (e.kind == "cut") "${e.products} products" else "1 product", style = MaterialTheme.typography.bodySmall, color = Palette.muted)
                    }
                    if (e.kind == "cut") Muted("Cut group — pick any product of the cut in ${e.size}")
                }
            }
            if (q.needsCheck.isNotEmpty()) {
                Label("Needs your check")
                for (n in q.needsCheck.take(3)) Card {
                    Text("${n.name ?: "Item"} · ${n.size ?: ""}", style = MaterialTheme.typography.titleMedium, color = Palette.text, fontWeight = FontWeight.Medium)
                    Muted(n.flags.joinToString(" · "))
                }
                Secondary("Open the review screen (WMS)") { nav.go(Screen.Web("Scan review", app.config?.reviewLink ?: "/inventory/size-grading/review")) }
            }
        }
    }
}

fun openEntry(nav: Nav, app: App, scope: kotlinx.coroutines.CoroutineScope, matrixId: String, size: String?, onError: (String) -> Unit) {
    scope.launch {
        try { nav.go(Screen.Item(app.api.lookupMatrix(matrixId), size)) } catch (e: Exception) { onError(e.message ?: "Could not open") }
    }
}

fun onTab(nav: Nav, t: Tab, app: App) {
    val item = nav.currentItem
    when (t) {
        Tab.Measure -> nav.home()
        Tab.Queue -> { nav.home(); nav.go(Screen.Queue) }
        Tab.Guide -> { nav.home(); nav.go(Screen.Guide(null)) }
        Tab.Studio -> nav.go(Screen.Web("Carbon Studio", item?.let { (app.config?.studioLink ?: "/inventory/catalog?matrix={matrixId}&mtab=studio").replace("{matrixId}", it.matrixId) } ?: "/inventory/catalog"))
        Tab.Seo -> nav.go(Screen.Web("SEO writer", item?.let { (app.config?.seoLink ?: "/inventory/catalog?matrix={matrixId}&mtab=seo").replace("{matrixId}", it.matrixId) } ?: "/inventory/catalog"))
    }
}

@Composable
fun QueueScreen(nav: Nav) {
    val app = App.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    var queue by remember { mutableStateOf<Queue?>(null) }
    var err by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { runCatching { queue = app.api.queue() }.onFailure { err = it.message } }
    Page("Measuring queue", onBack = { nav.back() }, bottom = { BottomTabs(Tab.Queue) { onTab(nav, it, app) } }) {
        err?.let { Notice(it, Palette.bad) }
        val q = queue ?: run { Muted("Loading…"); return@Page }
        Muted("${q.measured} of ${q.total} sizes measured · ${q.groups} cut groups. Cut groups come first: one garment covers every product in the cut.")
        if (q.groups == 0) Notice("No cut groups yet. Build them on the WMS (Size Grading › Cut groups) — until then each product is measured on its own.", Palette.muted)
        for (e in q.entries) Card(Modifier.clickable { openEntry(nav, app, scope, e.matrixId, e.size) { err = it } }) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text(e.name, style = MaterialTheme.typography.titleMedium, color = Palette.text, modifier = Modifier.weight(1f))
                Pill(e.size, Palette.accent)
            }
            Muted(if (e.kind == "cut") "Cut group · ${e.products} products" else "Not in a cut group${e.sampleSku?.let { " · $it" } ?: ""}")
        }
        if (q.entries.isEmpty()) Muted("Nothing left to measure.")
        Secondary("Edit cut groups (WMS)") { nav.go(Screen.Web("Cut groups", app.config?.cutGroupsLink ?: "/inventory/size-grading/cut-groups")) }
        androidx.compose.foundation.layout.Spacer(Modifier.padding(4.dp))
    }
}
