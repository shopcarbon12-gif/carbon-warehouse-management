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
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import com.shopcarbon.gradingai.App
import com.shopcarbon.gradingai.measure.MeasureTarget
import com.shopcarbon.gradingai.model.Lookup
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import java.io.File

/** The scanned item: which size is in hand, how it is measured, and the optional care-label check. */
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
    var labelNote by remember { mutableStateOf<String?>(null) }
    var labelFlag by remember { mutableStateOf<String?>(null) }
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
                val r = LabelCheck.compare(text, labels, size, item.fabric)
                labelNote = r.summary
                labelFlag = r.flag
                r.sizeOnLabel?.let { s -> if (size == null) size = s }
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

    Page(item.name, onBack = { nav.back() }, bottom = { BottomTabs(null) { onTab(nav, it, app) } }) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            NetImage(item.image, Modifier.width(110.dp).aspectRatio(0.8f), crop = true, maxPx = 500)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(item.name, style = MaterialTheme.typography.titleMedium, color = Palette.text)
                Muted(listOfNotNull(item.upc?.let { "UPC $it" }, item.vendor, item.subcategory?.lowercase()).joinToString(" · "))
                item.cutGroup?.let { Pill("Cut: ${it.name} · ${it.products} products", Palette.accent) }
                Muted(if (item.fabric != null) "Fabric in WMS: ${item.fabric}" else "No fabric in the WMS yet")
            }
        }
        if (!item.measurable && item.profileId == null) Notice(item.profileWhy, Palette.bad)

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
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            for (p in cfg?.profiles.orEmpty()) Pill(p.label, if (p.id == profileId) Palette.accent else Palette.muted, filled = p.id == profileId) { profileId = p.id }
        }
        if (item.profileId != null) Muted("Suggested — ${item.profileWhy}.")
        profile?.let { p -> Muted("${p.points.size} points: ${p.points.joinToString { it.label }}") }

        Card {
            Label("Care label (optional)")
            Muted("Photograph the care label: the app reads the size and fabric and flags a wrong-size save.")
            labelNote?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = if (labelFlag != null) Palette.warn else Palette.accent) }
            Secondary(if (labelBusy) "Reading…" else "Check care label", enabled = !labelBusy) { checkLabel() }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Secondary("How to lay it", Modifier.weight(1f), enabled = profile != null) { nav.go(Screen.Guide(profileId)) }
            Primary("Measure →", Modifier.weight(1f), enabled = size != null && profile != null && labelFlag?.startsWith("care label says") != true) {
                val s = size!!
                val sku = item.skusOfSize(s).firstOrNull { it.customSkuId == item.picked } ?: item.skusOfSize(s).first()
                nav.go(Screen.Capture(MeasureTarget(item, s, sku, profile!!, labelFlag)))
            }
        }
        if (labelFlag?.startsWith("care label says") == true) Notice("The care label shows another size. Pick the size on the label — or check the label again.", Palette.warn)
    }
}

/** Reads a care label: the size printed on it, and fabric percentages against the WMS's fabric line. */
object LabelCheck {
    data class Result(val summary: String, val flag: String?, val sizeOnLabel: String?)

    fun compare(text: String, sizes: List<String>, chosen: String?, wmsFabric: String?): Result {
        val up = text.uppercase()
        val tokens = Regex("[A-Z0-9]+").findAll(up).map { it.value }.toSet()
        val onLabel = sizes.filter { it in tokens }.sortedByDescending { it.length }
        val notes = mutableListOf<String>()
        var flag: String? = null
        val labelSize = onLabel.firstOrNull()
        when {
            labelSize == null -> notes += "No size found on the label."
            chosen != null && labelSize != chosen -> { notes += "Label says $labelSize — you picked $chosen."; flag = "care label says $labelSize, measured as $chosen" }
            else -> notes += "Size $labelSize matches."
        }
        val pct = Regex("(\\d{1,3})\\s*%\\s*([A-Z]+)").findAll(up).map { it.groupValues[2] to it.groupValues[1].toInt() }.toMap()
        if (pct.isNotEmpty()) {
            val wms = Regex("(\\d{1,3})\\s*%\\s*([A-Za-z]+)").findAll(wmsFabric.orEmpty().uppercase()).map { it.groupValues[2] to it.groupValues[1].toInt() }.toMap()
            val read = pct.entries.joinToString { "${it.value}% ${it.key.lowercase()}" }
            if (wms.isEmpty()) notes += "Fabric on label: $read (none in the WMS)."
            else if (wms != pct) { notes += "Fabric on label ($read) differs from the WMS ($wmsFabric)."; flag = flag ?: "care label fabric differs from WMS: $read" }
            else notes += "Fabric matches the WMS."
        }
        return Result(notes.joinToString(" "), flag, labelSize)
    }
}
