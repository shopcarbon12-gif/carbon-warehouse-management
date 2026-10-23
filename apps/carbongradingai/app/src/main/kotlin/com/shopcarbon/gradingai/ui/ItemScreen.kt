package com.shopcarbon.gradingai.ui

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import com.shopcarbon.gradingai.App
import com.shopcarbon.gradingai.measure.LabelCheck
import com.shopcarbon.gradingai.measure.MeasureTarget
import com.shopcarbon.gradingai.measure.Units
import com.shopcarbon.gradingai.model.Lookup
import com.shopcarbon.gradingai.model.SizeStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import java.io.File

/**
 * The scanned item: which size is in hand and how it is measured. Fabric and
 * care come from the WMS; only when the WMS has none does the app offer to
 * read the care label — and what it reads is saved into the WMS (owner,
 * 2026-10-13).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ItemScreen(nav: Nav, item: Lookup, preSize: String?) {
    val ctx = LocalContext.current
    val app = App.get(ctx)
    val cfg = app.config
    val scope = rememberCoroutineScope()
    val labels = item.sizeLabels()
    val fromCode = (listOfNotNull(item.picked) + item.candidates)
        .mapNotNull { id -> item.sizes.firstOrNull { it.customSkuId == id }?.size?.trim()?.uppercase() }.distinct()
    var size by remember { mutableStateOf(preSize?.uppercase()?.takeIf { it in labels } ?: fromCode.singleOrNull() ?: labels.singleOrNull()) }
    var profileId by remember { mutableStateOf(item.profileId ?: cfg?.profiles?.firstOrNull()?.id) }
    // What the WMS holds now (updated after a label is saved).
    var fabric by remember { mutableStateOf(item.fabric) }
    var care by remember { mutableStateOf(item.care) }
    var labelNote by remember { mutableStateOf<String?>(null) }
    var readFabric by remember { mutableStateOf<String?>(null) }
    var readCare by remember { mutableStateOf<String?>(null) }
    var labelBusy by remember { mutableStateOf(false) }
    val labelFile = remember { File(ctx.cacheDir, "label/label.jpg").apply { parentFile?.mkdirs() } }
    val labelUri: Uri = remember { FileProvider.getUriForFile(ctx, "${ctx.packageName}.files", labelFile) }
    val takeLabel = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        if (!ok) return@rememberLauncherForActivityResult
        labelBusy = true
        scope.launch {
            try {
                val bmp = withContext(Dispatchers.IO) { BitmapFactory.decodeFile(labelFile.path, BitmapFactory.Options().apply { inSampleSize = 2 }) }
                val text = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS).process(InputImage.fromBitmap(bmp, 0)).await().text
                val fibres = LabelCheck.fibres(text)
                readFabric = if (fibres.isNotEmpty() && fibres.values.sum() in 95..105) LabelCheck.fabricText(fibres) else null
                readCare = LabelCheck.careText(text)
                labelNote = when {
                    readFabric == null && readCare == null -> "Nothing readable on that photo — hold the label flat and fill the frame."
                    readFabric == null -> "No fabric percentages found; care text read."
                    else -> null
                }
            } catch (e: Exception) {
                labelNote = "Could not read the label: ${e.message}"
            } finally { labelBusy = false }
        }
    }
    /* The phone's camera app refuses an app that declares the camera
       permission without holding it (crash on the S25, 2026-10-13): ask first. */
    fun openLabelCamera() {
        try { takeLabel.launch(labelUri) } catch (e: Exception) { labelNote = "The camera could not open: ${e.message}" }
    }
    val askCamera = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (ok) openLabelCamera() else labelNote = "Allow the camera to photograph the care label."
    }
    fun checkLabel() {
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) openLabelCamera()
        else askCamera.launch(Manifest.permission.CAMERA)
    }
    val profile = cfg?.profile(profileId)
    // The photo of the colour in hand, live from Shopify; the product's main photo otherwise.
    val photo = size?.let { s -> item.skusOfSize(s).firstNotNullOfOrNull { it.image } } ?: item.image

    var picking by remember { mutableStateOf(size == null || profile == null || fromCode.size > 1) }
    var fabricOpen by remember { mutableStateOf(false) }
    var err by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf<String?>(null) }
    // "Keep it": the next garment's tag, straight from here.
    val scanNext = rememberTagScanner({ err = it }) { code -> nav.home(); openCode(nav, app, scope, code, { busy = it }) { err = it } }
    val measured = size?.let { item.statusOf(it) }?.takeIf { it != SizeStatus.NotMeasured }
    Page(
        item.name, onBack = { nav.back() }, largeTitle = false,
        bottom = {
            Primary(if (measured != null) "Re-measure size $size" else "Start measuring", enabled = size != null && profile != null) {
                val s = size!!
                val sku = item.skusOfSize(s).firstOrNull { it.customSkuId == item.picked } ?: item.skusOfSize(s).first()
                nav.go(Screen.Capture(MeasureTarget(item, s, sku, profile!!)))
            }
        },
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
            NetImage(photo, Modifier.width(92.dp), maxPx = 600, corner = 16.dp, fitAspect = 0.75f)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(item.name, style = MaterialTheme.typography.headlineSmall, color = Palette.text)
                Muted(listOfNotNull(size?.let { "Size $it" }, profile?.label, "${item.colours().size} colour${if (item.colours().size == 1) "" else "s"}").joinToString(" · "))
            }
        }
        if (!item.measurable && item.profileId == null) Notice(item.profileWhy, Palette.bad)
        /* The size in hand already has numbers (owner, 2026-10-23): say so, where
           they came from, and let the operator re-measure or move on. A re-measure
           does not retire the old scan — the newest reading wins on the item and
           the old one stays in the history. */
        if (measured != null && size != null) AlreadyMeasured(app, item, size!!, profile, measured, onKeep = { scanNext() }, onHome = { nav.home() })
        busy?.let { Muted(it) }
        err?.let { Notice(it, Palette.bad) }
        Steps(listOf("Lay flat", "Photo", "Check"), 0)

        /* After a tag scan the size and the type are usually known: show them on
           one line and keep the pickers closed (owner, 2026-10-20). */
        if (!picking && size != null && profile != null) {
            Group {
                ListRow(
                    "Size $size · ${profile.label}",
                    subtitle = "${item.skusOfSize(size!!).size} SKU(s): ${item.skusOfSize(size!!).mapNotNull { it.color }.distinct().joinToString()}" + if (profile.crotchKeys.isNotEmpty()) " · 2 photos" else "",
                    trailing = { Text("Change", style = MaterialTheme.typography.bodyMedium, color = Palette.accent) },
                    onClick = { picking = true },
                )
            }
        } else {
            Card {
                Label("Size in hand")
                if (fromCode.size > 1) Muted("This hang tag is shared by several sizes — pick the one in your hand.")
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (l in labels) {
                        val measured = item.skusOfSize(l).any { it.lastMeasuredAt != null }
                        Pill(if (measured) "$l ✓" else l, filled = l == size) { size = l }
                    }
                }
                size?.let { s -> Muted("One reading covers ${item.skusOfSize(s).size} SKU(s): ${item.skusOfSize(s).mapNotNull { it.color }.distinct().joinToString()}") }
                Label("Measure as")
                for ((group, list) in cfg?.groupedProfiles().orEmpty()) {
                    Text(group, style = MaterialTheme.typography.bodySmall, color = Palette.muted)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (p in list) Pill(p.label, filled = p.id == profileId) { profileId = p.id }
                    }
                }
                if (item.profileId != null) Muted("Suggested — ${item.profileWhy}.")
                if (size != null && profile != null) Secondary("Done") { picking = false }
            }
        }

        // How to lay it: the guide picture with its lines, and the laying text.
        profile?.let { p ->
            Card(padding = 12.dp) {
                GuidePicture(p)
                Text(p.lay, style = MaterialTheme.typography.bodyMedium, color = Palette.text)
                if (p.crotchKeys.isNotEmpty()) Muted("Photo 2: ${p.crotchLay.ifBlank { "lay it as shown for the ${p.secondTitle}." }}")
                Text("Full guide", style = MaterialTheme.typography.bodyMedium, color = Palette.accent, modifier = Modifier.clickable { nav.go(Screen.Guide(profileId)) })
            }
        }

        Group {
            ListRow(
                "Fabric & care",
                trailing = { Badge(if (fabric != null) "On file" else "Missing", if (fabric != null) Palette.ok else Palette.warn) },
                chevron = true,
                onClick = { fabricOpen = !fabricOpen },
            )
            item.cutGroup?.let { ListRow("Cut group", divider = true, trailing = { Text("${it.name} (${it.products})", style = MaterialTheme.typography.bodyMedium, color = Palette.muted) }) }
        }
        if (fabricOpen) Card {
            if (fabric != null) {
                KeyValue("Fabric (CarbonWMS)", fabric!!)
                care?.let { KeyValue("Care (CarbonWMS)", it) }
            } else {
                Muted("No fabric in CarbonWMS for this product. Photograph the care label to add it.")
                labelNote?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = Palette.warn) }
                readFabric?.let { KeyValue("Fabric on label", it, Palette.ok) }
                readCare?.let { if (care == null) KeyValue("Care on label", it, Palette.ok) }
                if (readFabric != null || (readCare != null && care == null)) {
                    Primary("Save to CarbonWMS") {
                        scope.launch {
                            try {
                                val r = app.api.saveLabel(item.matrixId, readFabric, if (care == null) readCare else null)
                                fabric = r.optString("fabric").takeIf { it.isNotBlank() && it != "null" }
                                care = r.optString("care").takeIf { it.isNotBlank() && it != "null" }
                                labelNote = "Saved to CarbonWMS — it reaches Shopify with the next product-details sync."
                                readFabric = null; readCare = null
                            } catch (e: Exception) { labelNote = "Could not save: ${e.message}" }
                        }
                    }
                }
                Secondary(if (labelBusy) "Reading…" else "Photograph care label", enabled = !labelBusy) { checkLabel() }
            }
        }
    }
}

/** The size in hand already has numbers: where they came from, the main ones, and the choice. */
@Composable
private fun AlreadyMeasured(
    app: App, item: Lookup, size: String, profile: com.shopcarbon.gradingai.model.Profile?, status: SizeStatus,
    onKeep: () -> Unit, onHome: () -> Unit,
) {
    val o = item.origins[size]
    val newest = item.skusOfSize(size).mapNotNull { it.lastMeasuredAt }.maxOrNull()
    val day = (o?.measuredAt ?: newest)?.let { runCatching {
        java.time.OffsetDateTime.parse(it).atZoneSameInstant(java.time.ZoneId.systemDefault())
            .format(java.time.format.DateTimeFormatter.ofPattern("MMM d"))
    }.getOrNull() }
    val from = when {
        status == SizeStatus.Guide -> "from the Shopify size guide"
        o?.source == "copied" -> "copied from ${o.scanProduct ?: "another product"}${o.scanSize?.let { " · $it" } ?: ""}"
        o?.source == "web" -> "entered on CarbonWMS"
        o?.scanProduct != null && o.scanProduct != item.name -> "scanned on ${o.scanProduct}${o.scanSize?.let { " · $it" } ?: ""} (same cut)"
        else -> "scanned with the app"
    }
    // The main numbers, by the garment's own point names (a pair shows its average).
    val shown = o?.pointsCm.orEmpty().let { cm ->
        listOf("chest", "waist", "length", "shoulder", "sleeve", "rise", "inseam", "thigh", "outseam").mapNotNull { k ->
            val v = cm[k] ?: return@mapNotNull null
            val label = profile?.points?.firstOrNull { it.key == k }?.label
                ?: profile?.points?.firstOrNull { it.pairOf == k }?.label?.replace(Regex(" [LR]$"), "")
                ?: k.replaceFirstChar { it.uppercase() }
            label to v
        }.take(4)
    }
    Card {
        Text("Size $size is already measured", style = MaterialTheme.typography.titleMedium, color = Palette.text)
        Muted(listOfNotNull(from.replaceFirstChar { it.uppercase() }, day).joinToString(" · "))
        for ((l, v) in shown) KeyValue(l, Units.show(v, app.prefs.units))
        Muted("Re-measure to replace these numbers on the item (the old scan stays in the history), or keep them and scan the next tag.")
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Secondary("Keep it — scan next tag", Modifier.weight(1f)) { onKeep() }
            Secondary("Home", Modifier.width(96.dp)) { onHome() }
        }
    }
}

/** The measuring steps, the current one in blue. */
@Composable
fun Steps(names: List<String>, current: Int) {
    Row(
        Modifier.fillMaxWidth().background(Palette.surface, RoundedCornerShape(14.dp)).padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        names.forEachIndexed { i, n ->
            if (i > 0) Box(Modifier.weight(1f).height(1.dp).background(Palette.line))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Dot(if (i <= current) Palette.accent else Palette.line, size = 8.dp)
                Text(n, style = MaterialTheme.typography.labelMedium, color = if (i == current) Palette.accent else if (i < current) Palette.text else Palette.muted)
            }
        }
    }
}
