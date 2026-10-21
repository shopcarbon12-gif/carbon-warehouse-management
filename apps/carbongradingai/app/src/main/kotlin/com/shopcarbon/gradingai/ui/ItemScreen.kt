package com.shopcarbon.gradingai.ui

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
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
import com.shopcarbon.gradingai.model.Lookup
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

    Page(item.name, onBack = { nav.back() }, bottom = { BottomTabs(null) { onTab(nav, it, app) } }) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            NetImage(photo, Modifier.width(110.dp).aspectRatio(0.8f), crop = true, maxPx = 600)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(item.name, style = MaterialTheme.typography.titleMedium, color = Palette.text)
                Muted(listOfNotNull(item.upc?.let { "UPC $it" }, item.vendor, item.subcategory?.lowercase()).joinToString(" · "))
                item.cutGroup?.let { Pill("Cut: ${it.name} · ${it.products} products", Palette.accent) }
            }
        }
        if (!item.measurable && item.profileId == null) Notice(item.profileWhy, Palette.bad)

        /* After a tag scan the size and the type are usually known: show them on
           one line and keep the pickers closed (owner, 2026-10-20). */
        var picking by remember { mutableStateOf(size == null || profile == null || fromCode.size > 1) }
        if (!picking && size != null && profile != null) {
            Card {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Column(Modifier.weight(1f)) {
                        Text("Size $size · ${profile.label}", style = MaterialTheme.typography.titleMedium, color = Palette.text)
                        Muted("${item.skusOfSize(size!!).size} SKU(s): ${item.skusOfSize(size!!).mapNotNull { it.color }.distinct().joinToString()}" +
                            if (profile.crotchKeys.isNotEmpty()) " · 2 photos" else "")
                    }
                    Pill("Change", Palette.accent) { picking = true }
                }
            }
        } else {
            Label("Size in hand")
            if (fromCode.size > 1) Muted("This hang tag is shared by several sizes — pick the one in your hand.")
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                for (l in labels) {
                    val measured = item.skusOfSize(l).any { it.lastMeasuredAt != null }
                    Pill(if (measured) "$l ✓" else l, if (l == size) Palette.accent else Palette.muted, filled = l == size) { size = l }
                }
            }
            size?.let { s -> Muted("One reading covers ${item.skusOfSize(s).size} SKU(s): ${item.skusOfSize(s).mapNotNull { it.color }.distinct().joinToString()}") }

            Label("Measure as")
            for ((group, list) in cfg?.groupedProfiles().orEmpty()) {
                Text(group, style = MaterialTheme.typography.bodySmall, color = Palette.muted)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (p in list) Pill(p.label, if (p.id == profileId) Palette.accent else Palette.muted, filled = p.id == profileId) { profileId = p.id }
                }
            }
            if (item.profileId != null) Muted("Suggested — ${item.profileWhy}.")
            profile?.let { p -> Muted("${p.points.size} points: ${p.points.joinToString { it.label }}") }
            if (size != null && profile != null) Secondary("Done") { picking = false }
        }

        Card {
            Label("Fabric & care")
            if (fabric != null) {
                KeyValue("Fabric (WMS)", fabric!!)
                care?.let { KeyValue("Care (WMS)", it) }
            } else {
                Muted("No fabric in the WMS for this product. Photograph the care label to add it.")
                labelNote?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = Palette.warn) }
                readFabric?.let { KeyValue("Fabric on label", it, Palette.accent) }
                readCare?.let { if (care == null) KeyValue("Care on label", it, Palette.accent) }
                if (readFabric != null || (readCare != null && care == null)) {
                    Primary("Save to WMS") {
                        scope.launch {
                            try {
                                val r = app.api.saveLabel(item.matrixId, readFabric, if (care == null) readCare else null)
                                fabric = r.optString("fabric").takeIf { it.isNotBlank() && it != "null" }
                                care = r.optString("care").takeIf { it.isNotBlank() && it != "null" }
                                labelNote = "Saved to the WMS — it reaches Shopify with the next product-details sync."
                                readFabric = null; readCare = null
                            } catch (e: Exception) { labelNote = "Could not save: ${e.message}" }
                        }
                    }
                }
                Secondary(if (labelBusy) "Reading…" else "Photograph care label", enabled = !labelBusy) { checkLabel() }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Secondary("How to lay it", Modifier.weight(1f), enabled = profile != null) { nav.go(Screen.Guide(profileId)) }
            Primary("Measure →", Modifier.weight(1f), enabled = size != null && profile != null) {
                val s = size!!
                val sku = item.skusOfSize(s).firstOrNull { it.customSkuId == item.picked } ?: item.skusOfSize(s).first()
                nav.go(Screen.Capture(MeasureTarget(item, s, sku, profile!!)))
            }
        }
    }
}
