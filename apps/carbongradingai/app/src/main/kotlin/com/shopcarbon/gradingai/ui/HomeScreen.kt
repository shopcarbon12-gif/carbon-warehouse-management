package com.shopcarbon.gradingai.ui

import android.os.Build
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.google.android.gms.common.moduleinstall.ModuleInstall
import com.google.android.gms.common.moduleinstall.ModuleInstallRequest
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.shopcarbon.gradingai.App
import com.shopcarbon.gradingai.model.Queue
import com.shopcarbon.gradingai.model.QueueEntry
import com.shopcarbon.gradingai.sync.ScanStore
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/** True when this phone is one of the depth-sensor Samsungs the app measures on. */
fun phoneSupported(app: App): Boolean {
    val list = app.config?.supportedModels ?: listOf("SM-N975", "SM-N976", "SM-G986", "SM-G988")
    return list.any { Build.MODEL.uppercase().startsWith(it) }
}

/**
 * The hang-tag scanner (Play services' code scanner): returns a function that
 * opens it; a read code goes to `onCode`. Used on Home, Catalog and after a save.
 */
@Composable
fun rememberTagScanner(onError: (String) -> Unit, onCode: (String) -> Unit): () -> Unit {
    val activity = LocalContext.current
    val scanner = remember {
        GmsBarcodeScanning.getClient(activity, GmsBarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_CODE_93, Barcode.FORMAT_CODE_128, Barcode.FORMAT_CODE_39, Barcode.FORMAT_UPC_A, Barcode.FORMAT_EAN_13, Barcode.FORMAT_QR_CODE)
            .enableAutoZoom().build())
    }
    return {
        fun start() = scanner.startScan()
            .addOnSuccessListener { b -> b.rawValue?.trim()?.takeIf { it.isNotEmpty() }?.let(onCode) }
            .addOnFailureListener { onError("Scanner unavailable: ${it.message}") }
        // The scanner lives in Play services; ask for its module first (as CarbonWMS-PC does).
        runCatching {
            ModuleInstall.getClient(activity).installModules(ModuleInstallRequest.newBuilder().addApi(scanner).build())
                .addOnSuccessListener { start() }.addOnFailureListener { start() }
        }.onFailure { start() }
    }
}

/** A scanned or typed code → the item screen. */
fun openCode(nav: Nav, app: App, scope: kotlinx.coroutines.CoroutineScope, code: String, busy: (String?) -> Unit, onError: (String) -> Unit) {
    busy("Finding $code…")
    scope.launch {
        try { nav.go(Screen.Item(app.api.lookupCode(code))) } catch (e: Exception) { onError(e.message ?: "Not found") } finally { busy(null) }
    }
}

@Composable
fun HomeScreen(nav: Nav) {
    val app = App.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    var queue by remember { mutableStateOf<Queue?>(null) }
    var err by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf<String?>(null) }
    val pending = remember { ScanStore.pending(app).size }

    LaunchedEffect(Unit) {
        runCatching { app.config = app.api.config() }
        runCatching { queue = app.api.queue() }.onFailure { err = it.message }
    }
    val scan = rememberTagScanner({ err = it }) { code -> openCode(nav, app, scope, code, { busy = it }) { err = it } }

    Page(
        "GradingAI",
        header = { BrandTitle() },
        actions = { GlassCircle(Icons.Filled.Settings, "Settings", { nav.go(Screen.Settings) }) },
        tabs = { BottomTabs(Tab.Home) { onTab(nav, it) } },
    ) {
        com.shopcarbon.gradingai.update.Updater.note.value?.let { Notice(it, Palette.accent) }
        if (!phoneSupported(app)) {
            Notice(
                if (app.prefs.testMode) "Test mode: this ${Build.MODEL} has no time-of-flight depth sensor. Scans are saved for review only, never written to the item."
                else "This phone (${Build.MODEL}) has no depth sensor the app can measure with. Use a Galaxy Note10+, Note10+ 5G, S20+ or S20 Ultra — or turn on test mode in Settings to try the app.",
            )
        }
        Card(padding = 20.dp) {
            val q = queue
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                val p = if (q != null && q.total > 0) q.measured.toFloat() / q.total else 0f
                ProgressRing(p, Modifier.size(132.dp)) {
                    Text(if (q == null) "—" else "${(p * 100).roundToInt()}%", style = MaterialTheme.typography.headlineSmall, color = Palette.text)
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (q == null) Muted(if (err != null) "Offline — $err" else "Loading…")
                    else {
                        Text("%,d".format(q.measured), style = MaterialTheme.typography.headlineSmall, color = Palette.text)
                        Text("of %,d sizes measured".format(q.total), style = MaterialTheme.typography.bodyMedium, color = Palette.muted)
                    }
                    if (pending > 0) Text("$pending waiting to send", style = MaterialTheme.typography.bodySmall, color = Palette.warn)
                }
            }
        }
        queue?.let { q ->
            if (q.entries.isNotEmpty()) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.weight(1f)) { Section("Measure next") }
                    Text("See all", style = MaterialTheme.typography.bodyMedium, color = Palette.accent, modifier = Modifier.clickable { nav.go(Screen.Queue) }.padding(6.dp))
                }
                // One card per product (its sizes follow on the Queue tab), with the product's photo from CarbonWMS.
                val cards = q.entries.distinctBy { it.matrixId }.take(10)
                LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    items(cards, key = { it.matrixId + it.size }) { e -> NextCard(e) { openEntry(nav, app, scope, e.matrixId, e.size) { m -> err = m } } }
                }
            }
        }
        // Scan tag sits under Measure next (owner, 2026-10-22).
        Primary(busy ?: "Scan tag", enabled = busy == null) { scan() }
        // GradingAI's catalog search, under Scan tag (owner, 2026-10-24): opens it with the keyboard up (name, UPC, custom SKU, vendor, colour).
        Row(
            Modifier.fillMaxWidth().height(48.dp).background(Palette.surface, RoundedCornerShape(14.dp)).clickable { nav.go(Screen.Catalog(focus = true)) }.padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(Icons.Filled.Search, null, tint = Palette.muted, modifier = Modifier.size(22.dp))
            Text("Search name, UPC, custom SKU…", style = MaterialTheme.typography.bodyLarge, color = Palette.muted, modifier = Modifier.weight(1f))
        }
        err?.let { if (queue != null) Notice(it, Palette.bad) }
        queue?.let { q ->
            Group {
                ListRow(
                    "Scans to check",
                    trailing = {
                        if (q.needsCheck.isEmpty()) Text("None", style = MaterialTheme.typography.bodyMedium, color = Palette.muted)
                        else Badge("${q.needsCheck.size}", Palette.warn, solid = true)
                    },
                    chevron = true,
                    onClick = { nav.go(Screen.ToCheck) },
                )
            }
        }
        // The measuring guide lives inside GradingAI (owner, 2026-10-24); the tab became Social.
        Group {
            ListRow("Guide", subtitle = "How to lay each garment, and where every point sits", chevron = true, onClick = { nav.go(Screen.Guide(null)) })
        }
    }
}

@Composable
private fun NextCard(e: QueueEntry, onClick: () -> Unit) {
    Column(Modifier.width(150.dp).clickable(onClick = onClick), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        NetImage(e.image, Modifier.fillMaxWidth().aspectRatio(0.78f), crop = true, maxPx = 500, corner = 18.dp, background = Color.White)
        Text(e.name, style = MaterialTheme.typography.bodyMedium, color = Palette.text, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Text(if (e.kind == "cut") "${e.size} · cut of ${e.products}" else "Size ${e.size}", style = MaterialTheme.typography.bodySmall, color = Palette.muted)
    }
}

fun openEntry(nav: Nav, app: App, scope: kotlinx.coroutines.CoroutineScope, matrixId: String, size: String?, onError: (String) -> Unit) {
    scope.launch {
        try { nav.go(Screen.Item(app.api.lookupMatrix(matrixId), size)) } catch (e: Exception) { onError(e.message ?: "Could not open") }
    }
}

/** The four tabs: each opens from GradingAI (the first tab), so Back always leads there. */
fun onTab(nav: Nav, t: Tab) {
    when (t) {
        Tab.Home -> nav.home()
        Tab.Catalog -> { nav.home(); nav.go(Screen.WmsCatalog) }
        Tab.Studio -> { nav.home(); nav.go(Screen.Studio) }
        Tab.Social -> { nav.home(); nav.go(Screen.Social) }
    }
}

@Composable
fun QueueScreen(nav: Nav) {
    val app = App.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    var queue by remember { mutableStateOf<Queue?>(null) }
    var err by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { runCatching { queue = app.api.queue() }.onFailure { err = it.message } }
    Page("Queue", onBack = { nav.back() }) {
        Muted("Cut groups first — one garment covers the whole cut.")
        err?.let { Notice(it, Palette.bad) }
        val q = queue ?: run { Muted("Loading…"); return@Page }
        Muted("%,d of %,d sizes measured · %d cut groups".format(q.measured, q.total, q.groups))
        val cuts = q.entries.filter { it.kind == "cut" }
        val products = q.entries.filter { it.kind != "cut" }
        if (cuts.isNotEmpty()) Group(header = "Cut groups") {
            cuts.forEachIndexed { i, e ->
                ListRow("${e.name} · ${e.size}", divider = i > 0, trailing = { Badge("${e.products} products", Palette.muted) }, chevron = true) { openEntry(nav, app, scope, e.matrixId, e.size) { err = it } }
            }
        }
        if (products.isNotEmpty()) Group(header = "Products") {
            products.forEachIndexed { i, e ->
                ListRow(
                    "${e.name} · ${e.size}", subtitle = e.sampleSku?.let { "Take $it" }, divider = i > 0,
                    leading = { NetImage(e.image, Modifier.size(44.dp), crop = true, maxPx = 200, corner = 10.dp) },
                    chevron = true,
                ) { openEntry(nav, app, scope, e.matrixId, e.size) { err = it } }
            }
        }
        if (q.entries.isEmpty()) Muted("Nothing left to measure.")
        if (q.groups == 0) Muted("No cut groups yet — build them on CarbonWMS (Size Grading › Cut groups).")
        Secondary("Edit cut groups on CarbonWMS") { nav.go(Screen.Web("Cut groups", app.config?.cutGroupsLink ?: "/inventory/size-grading/cut-groups")) }
    }
}

/** Scans waiting for a look: tap one to fix its lines here, or open the review on CarbonWMS. */
@Composable
fun ToCheckScreen(nav: Nav) {
    val app = App.get(LocalContext.current)
    var queue by remember { mutableStateOf<Queue?>(null) }
    var err by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { runCatching { queue = app.api.queue() }.onFailure { err = it.message } }
    Page("To check", onBack = { nav.back() }) {
        err?.let { Notice(it, Palette.bad) }
        val q = queue ?: run { Muted("Loading…"); return@Page }
        if (q.needsCheck.isEmpty()) Muted("Nothing to check — every saved scan is fine.")
        else Group {
            q.needsCheck.forEachIndexed { i, n ->
                ListRow(
                    "${n.name ?: "Item"}${n.size?.let { " · $it" } ?: ""}",
                    subtitle = ago(n.createdAt),
                    divider = i > 0,
                    leading = { NetImage(n.photo, Modifier.size(52.dp), crop = true, maxPx = 300, corner = 10.dp) },
                    trailing = { n.flags.firstOrNull()?.let { Badge(it.take(28), Palette.warn) } },
                    chevron = true,
                ) { nav.go(Screen.EditSaved(n.scanId)) }
            }
        }
        Secondary("Open review on CarbonWMS") { nav.go(Screen.Web("Scan review", app.config?.reviewLink ?: "/inventory/size-grading/review")) }
    }
}

/** "2 h ago" from an ISO time. */
fun ago(iso: String?): String {
    if (iso.isNullOrBlank()) return ""
    val t = runCatching { java.time.Instant.parse(iso).toEpochMilli() }.getOrNull()
        ?: runCatching { java.time.OffsetDateTime.parse(iso).toInstant().toEpochMilli() }.getOrNull() ?: return ""
    val s = ((System.currentTimeMillis() - t) / 1000).coerceAtLeast(0)
    return when {
        s < 3600 -> "${(s / 60).coerceAtLeast(1)} min ago"
        s < 86400 -> "${s / 3600} h ago"
        s < 2 * 86400 -> "1 day ago"
        else -> "${s / 86400} days ago"
    }
}
