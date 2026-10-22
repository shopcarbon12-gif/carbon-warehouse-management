package com.shopcarbon.gradingai.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.automirrored.filled.CompareArrows
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material3.Icon
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.shape.RoundedCornerShape
import com.shopcarbon.gradingai.App
import com.shopcarbon.gradingai.measure.MeasureSession
import com.shopcarbon.gradingai.measure.MeasureTarget
import com.shopcarbon.gradingai.measure.Units
import com.shopcarbon.gradingai.model.SaveResult
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/**
 * After a save (owner-approved design, 2026-10-22): Next size goes straight to
 * the camera — same product, no tag scan; or scan a new tag, edit the points of
 * what was just saved, re-scan this size (the new scan replaces it), or go home.
 */
@Composable
fun SavedScreen(nav: Nav, s: MeasureSession, r: SaveResult?, offline: Boolean) {
    val app = App.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    var err by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf<String?>(null) }
    val item = s.target.lookup
    val size = r?.size?.trim()?.uppercase() ?: s.target.sizeLabel
    val next = item.nextSize(s.target.sizeLabel)
    val scan = rememberTagScanner({ err = it }) { code -> nav.home(); openCode(nav, app, scope, code, { busy = it }) { err = it } }

    Page("Saved", onBack = { nav.home() }, largeTitle = false) {
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(Icons.Filled.CheckCircle, null, tint = if (offline) Palette.warn else Palette.ok, modifier = Modifier.size(72.dp))
            Text(if (offline) "Saved on the phone" else "Saved to CarbonWMS", style = MaterialTheme.typography.headlineSmall, color = Palette.text)
            val colours = r?.colors?.distinct()?.size ?: 0
            Text(
                "${item.name} · size $size" + if (colours > 0) " · $colours colour${if (colours == 1) "" else "s"} updated" else "",
                style = MaterialTheme.typography.bodyMedium, color = Palette.muted, textAlign = TextAlign.Center,
            )
        }
        if (offline) Notice("It sends to CarbonWMS by itself when the phone is back online.", Palette.warn)
        Card {
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                ScanThumb(s, Modifier.width(110.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    val cm = s.cm()
                    val shown = s.profile.points.filter { it.pairOf == null || it.key.endsWith("L") }.mapNotNull { p ->
                        val v = cm[p.pairOf ?: p.key] ?: cm[p.key] ?: return@mapNotNull null
                        (if (p.pairOf != null) p.label.replace(Regex("""[,\s]*(leg |sleeve )?\b[LR]$"""), "") else p.label) to v
                    }
                    shown.take(3).forEach { (l, v) -> KeyValue(l, Units.show(v, app.prefs.units)) }
                    if (shown.size > 3) Muted("+ ${shown.size - 3} more")
                }
            }
            if (r != null) {
                val flagged = r.sizeCheck.filter { it.flag }
                val neighbours = r.sizeCheck.flatMap { listOf(it.fromSize, it.toSize) }.filter { !it.equals(size, true) }.distinct()
                if (flagged.isEmpty()) {
                    if (r.sizeCheck.isNotEmpty()) Text(
                        "Size check: in line with ${neighbours.joinToString(" and ")}", style = MaterialTheme.typography.bodyMedium, color = Palette.ok,
                    )
                } else for (c in flagged.distinctBy { it.key + it.fromSize + it.toSize }.take(4)) {
                    Text("Check ${c.label}: ${c.fromSize} → ${c.toSize} ${signed(c.deltaCm)} cm", style = MaterialTheme.typography.bodyMedium, color = Palette.warn)
                }
                if (r.status == "flagged") Muted("Flagged — it waits under Scans to check.")
                r.cutGroupName?.let { Muted("Cut group $it: ${r.cutGroupProducts} products · ${r.total} SKUs updated") }
                if (r.total == 0 && !s.scan.depth.tof) Muted("Test mode: kept for review, not written to the item.")
            }
        }
        busy?.let { Muted(it) }
        err?.let { Notice(it, Palette.bad) }
        if (next != null) {
            Primary("Next size $next", caption = "Same item — no tag needed") {
                val sku = item.skusOfSize(next).first()
                nav.home(); nav.go(Screen.Capture(MeasureTarget(item, next, sku, s.profile)))
            }
        } else {
            Primary("Next in the queue") {
                scope.launch {
                    try {
                        val q = app.api.queue()
                        val n = q.entries.firstOrNull { !(it.matrixId == item.matrixId && it.size.equals(size, true)) }
                        if (n == null) { err = "Nothing left in the queue."; return@launch }
                        nav.home(); nav.go(Screen.Item(app.api.lookupMatrix(n.matrixId), n.size))
                    } catch (e: Exception) { err = e.message }
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Tile(Icons.Filled.QrCodeScanner, "Scan new tag", Modifier.weight(1f)) { scan() }
            // Compare this garment with another product, and copy its grading (owner, 2026-10-22).
            Tile(Icons.AutoMirrored.Filled.CompareArrows, "Compare", Modifier.weight(1f)) { nav.go(Screen.Compare(item, s.target.sizeLabel)) }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Tile(Icons.Filled.Edit, "Edit points", Modifier.weight(1f), enabled = r != null) { r?.let { nav.go(Screen.EditSaved(it.scanId)) } }
            Tile(Icons.Filled.CameraAlt, "Re-scan $size", Modifier.weight(1f)) {
                nav.replace(Screen.Capture(s.target.copy(replaces = r?.scanId)))
            }
        }
        if (r != null && r.flags.isNotEmpty()) Group(header = "Flags") {
            r.flags.forEachIndexed { i, f -> ListRow(f, divider = i > 0) }
        }
    }
}

/** The squared-up photo, small, with the saved lines on it. */
@Composable
fun ScanThumb(s: MeasureSession, modifier: Modifier) {
    val bmp = remember(s.scan.photo) { s.scan.photo.asImageBitmap() }
    Box(modifier.aspectRatio(bmp.width.toFloat() / bmp.height).clip(RoundedCornerShape(12.dp))) {
        Canvas(Modifier.fillMaxWidth().aspectRatio(bmp.width.toFloat() / bmp.height)) {
            val k = size.width / bmp.width
            drawImage(bmp, dstSize = IntSize(size.width.roundToInt(), size.height.roundToInt()))
            for ((_, l) in s.kept()) {
                val path = Path().apply { l.pts.forEachIndexed { i, p -> if (i == 0) moveTo(p.x * k, p.y * k) else lineTo(p.x * k, p.y * k) } }
                drawPath(path, sourceColor(l), style = Stroke(width = 3f, cap = StrokeCap.Round))
                l.pts.forEach { drawCircle(sourceColor(l), 3.5f, Offset(it.x * k, it.y * k)) }
            }
        }
    }
}
