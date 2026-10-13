package com.shopcarbon.gradingai.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import com.shopcarbon.gradingai.App
import com.shopcarbon.gradingai.measure.AiState
import com.shopcarbon.gradingai.measure.MLine
import com.shopcarbon.gradingai.measure.MeasureSession
import com.shopcarbon.gradingai.measure.Pt
import com.shopcarbon.gradingai.measure.Units
import com.shopcarbon.gradingai.sync.ScanStore
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.roundToInt

fun sourceColor(l: MLine?): Color = when {
    l == null -> Palette.muted
    l.moved || l.source == "manual" -> Palette.manual
    l.source == "ai" -> Palette.ai
    else -> Palette.accent
}

/** Result: Size AI's lines on the squared-up photo, every end draggable, then Save. */
@Composable
fun ResultScreen(nav: Nav, s: MeasureSession) {
    val ctx = LocalContext.current
    val app = App.get(ctx)
    val scope = rememberCoroutineScope()
    var units by remember { mutableStateOf(app.prefs.units) }
    var selected by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    var err by remember { mutableStateOf<String?>(null) }
    var tick by remember { mutableLongStateOf(0L) }
    val limit = app.config?.capture?.pairLimitCm ?: 1f
    LaunchedEffect(s.ai) { while (s.ai is AiState.Running) { tick = System.currentTimeMillis(); delay(500) } }
    val cm = s.cm()

    fun save() {
        saving = true; err = null
        scope.launch {
            try {
                val res = ScanStore.save(ctx, s.scan.id, s.meta(app))
                nav.replace(Screen.Saved(s, res, res == null))
            } catch (e: Exception) {
                err = e.message ?: "Could not save"
            } finally { saving = false }
        }
    }

    Page(
        "${s.target.lookup.name} · ${s.target.sizeLabel}",
        onBack = { s.cancelAi(); ScanStore.discard(ctx, s.scan.id); nav.back() },
        bottom = {
            Row(Modifier.fillMaxWidth().background(Palette.surface).navigationBarsPadding().padding(12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Secondary("Undo", Modifier.width(90.dp), enabled = s.canUndo) { s.undo() }
                Secondary("Retake", Modifier.width(100.dp)) { s.cancelAi(); ScanStore.discard(ctx, s.scan.id); nav.replace(Screen.Capture(s.target)) }
                Primary(if (saving) "Saving…" else "Save to WMS", Modifier.weight(1f), enabled = !saving && cm.isNotEmpty()) { save() }
            }
        },
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Muted(s.profile.label + " · ${s.scan.depth.distanceCm.roundToInt()} cm · ${s.scan.depth.tiltDeg.roundToInt()}° · ${if (s.scan.depth.tof) "depth sensor" else "TEST MODE"}")
        }
        when (val a = s.ai) {
            is AiState.Running -> Notice("AI is placing the seam points… ${((tick - a.startedAt) / 1000).coerceAtLeast(0)} s. You can lay out the next garment meanwhile.", Palette.ai)
            is AiState.Done -> Muted("AI placed ${a.placed} points in ${a.ms / 1000} s.${if (a.remarks.isNotBlank()) " " + a.remarks else ""}")
            is AiState.Failed -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Notice("AI assist failed: ${a.message}. Drag the seam points onto the seams by hand, or try again.", Palette.warn)
                Secondary("Try the AI again") { s.startAi(app) }
            }
            is AiState.Off -> Muted(a.why)
            AiState.Idle -> {}
        }
        PhotoEditor(s, selected, onSelect = { selected = it })
        Legend()
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for ((k, label) in listOf("cm" to "CM", "in" to "INCH", "both" to "BOTH")) Pill(label, if (units == k) Palette.accent else Palette.muted, filled = units == k) { units = k; app.prefs.units = k }
        }
        // Points, L/R pairs on one row.
        val shown = mutableSetOf<String>()
        for (p in s.profile.points) {
            if (p.key in shown) continue
            val pair = p.pairOf?.let { plain -> s.profile.points.filter { it.pairOf == plain } } ?: listOf(p)
            pair.forEach { shown += it.key }
            val vals = pair.map { cm[it.key] }
            val mismatch = vals.size == 2 && vals.all { it != null } && abs(vals[0]!! - vals[1]!!) > limit
            val isSel = pair.any { it.key == selected }
            Row(
                Modifier.fillMaxWidth().background(if (isSel) Palette.raised else Palette.surface, RoundedCornerShape(10.dp))
                    .clickable { selected = pair.first().key }.padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Box(Modifier.size(26.dp).background(sourceColor(s.lines[p.key]).copy(alpha = 0.25f), CircleShape), contentAlignment = Alignment.Center) {
                    Text(p.letter, style = MaterialTheme.typography.labelMedium, color = Palette.text)
                }
                Column(Modifier.weight(1f)) {
                    Text(if (pair.size == 2) p.label.removeSuffix(" L") + " L / R" else p.label, style = MaterialTheme.typography.bodyMedium, color = Palette.text)
                    val tags = pair.mapNotNull { s.lines[it.key] }.map { if (it.moved) "moved" else if (it.source == "ai") "AI" else "" }.filter { it.isNotEmpty() }.distinct()
                    if (tags.isNotEmpty() || mismatch) Text((tags + if (mismatch) listOf("L/R differ") else emptyList()).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = if (mismatch) Palette.warn else Palette.ai)
                }
                Text(
                    vals.joinToString(" / ") { v -> v?.let { Units.show(it, units) } ?: "—" },
                    style = MaterialTheme.typography.titleMedium, color = if (vals.any { it == null }) Palette.muted else Palette.text, fontWeight = FontWeight.SemiBold,
                )
            }
        }
        val warn = s.flags(app)
        if (warn.isNotEmpty()) Card { Label("Will be flagged for review"); warn.forEach { Text("• $it", style = MaterialTheme.typography.bodySmall, color = Palette.warn) } }
        err?.let { Notice(it, Palette.bad) }
    }
}

@Composable
private fun Legend() = Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
    for ((c, t) in listOf(Palette.accent to "outline", Palette.ai to "AI", Palette.manual to "moved by you")) Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(10.dp).background(c, CircleShape)); Text(" $t", style = MaterialTheme.typography.bodySmall, color = Palette.muted)
    }
}

/**
 * The photo with every line. Tap a line to pick it; drag an end to move it.
 * While dragging, a magnifier at the top shows the spot under the finger at 3×.
 */
@Composable
fun PhotoEditor(s: MeasureSession, selected: String?, onSelect: (String?) -> Unit) {
    val bmp = remember(s.scan.photo) { s.scan.photo.asImageBitmap() }
    val density = LocalDensity.current
    var drag by remember { mutableStateOf<Pair<String, Int>?>(null) }
    var finger by remember { mutableStateOf<Pt?>(null) }
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val wPx = with(density) { maxWidth.toPx() }
        // At most ~60% of the screen tall, so the list below stays reachable on tall garments.
        val maxH = with(density) { (LocalConfiguration.current.screenHeightDp * 0.6f).dp.toPx() }
        val scale = minOf(wPx / bmp.width, maxH / bmp.height)
        val hDp = with(density) { (bmp.height * scale).toDp() }
        val wDp = with(density) { (bmp.width * scale).toDp() }
        fun toPhoto(o: Offset) = Pt(o.x / scale, o.y / scale)
        fun nearestEnd(o: Offset, only: String?): Pair<String, Int>? {
            var best: Pair<String, Int>? = null; var bd = with(density) { 34.dp.toPx() }
            for ((k, l) in s.lines) {
                if (only != null && k != only) continue
                l.pts.forEachIndexed { i, p -> val d = hypot(p.x * scale - o.x, p.y * scale - o.y); if (d < bd) { bd = d; best = k to i } }
            }
            return best
        }
        fun nearestLine(o: Offset): String? {
            var best: String? = null; var bd = with(density) { 26.dp.toPx() }
            for ((k, l) in s.lines) for ((a, b) in l.pts.zipWithNext()) {
                val ax = a.x * scale; val ay = a.y * scale; val bx = b.x * scale; val by = b.y * scale
                val dx = bx - ax; val dy = by - ay
                val t = (((o.x - ax) * dx + (o.y - ay) * dy) / (dx * dx + dy * dy).coerceAtLeast(1f)).coerceIn(0f, 1f)
                val d = hypot(ax + t * dx - o.x, ay + t * dy - o.y)
                if (d < bd) { bd = d; best = k }
            }
            return best
        }
        Canvas(
            Modifier.align(Alignment.TopCenter).width(wDp).height(hDp)
                .pointerInput(s) { detectTapGestures { o -> onSelect(nearestLine(o)) } }
                .pointerInput(s, selected) {
                    detectDragGestures(
                        onDragStart = { o ->
                            val h = nearestEnd(o, selected) ?: nearestEnd(o, null)
                            if (h != null) { s.beginEdit(); drag = h; onSelect(h.first); finger = toPhoto(o) }
                        },
                        onDrag = { change, _ ->
                            val h = drag ?: return@detectDragGestures
                            change.consume()
                            val p = toPhoto(change.position)
                            val clamped = Pt(p.x.coerceIn(0f, bmp.width.toFloat()), p.y.coerceIn(0f, bmp.height.toFloat()))
                            s.moveEnd(h.first, h.second, clamped)
                            finger = clamped
                        },
                        onDragEnd = { drag = null; finger = null },
                        onDragCancel = { drag = null; finger = null },
                    )
                },
        ) {
            drawImage(bmp, dstSize = IntSize(size.width.roundToInt(), size.height.roundToInt()))
            val letters = s.profile.points.associate { it.key to (it.letter + (it.side ?: "")) }
            for ((k, l) in s.lines) {
                val c = sourceColor(l)
                val sel = k == selected
                val path = Path().apply { l.pts.forEachIndexed { i, p -> if (i == 0) moveTo(p.x * scale, p.y * scale) else lineTo(p.x * scale, p.y * scale) } }
                drawPath(path, Color.Black.copy(alpha = 0.55f), style = Stroke(width = if (sel) 9f else 6f, cap = StrokeCap.Round))
                drawPath(path, c, style = Stroke(width = if (sel) 5f else 3f, cap = StrokeCap.Round))
                for (p in l.pts) {
                    drawCircle(Color.Black.copy(alpha = 0.6f), radius = if (sel) 15f else 8f, center = Offset(p.x * scale, p.y * scale))
                    drawCircle(c, radius = if (sel) 11f else 5f, center = Offset(p.x * scale, p.y * scale), style = if (sel) Stroke(4f) else androidx.compose.ui.graphics.drawscope.Fill)
                }
                val mid = l.pts[l.pts.size / 2].let { if (l.pts.size == 2) Pt((l.pts[0].x + l.pts[1].x) / 2, (l.pts[0].y + l.pts[1].y) / 2) else it }
                drawCircle(Color.Black.copy(alpha = 0.7f), radius = 17f, center = Offset(mid.x * scale, mid.y * scale))
                drawContext.canvas.nativeCanvas.drawText(
                    letters[k] ?: k, mid.x * scale, mid.y * scale + 8f,
                    android.graphics.Paint().apply { color = android.graphics.Color.WHITE; textSize = 22f; textAlign = android.graphics.Paint.Align.CENTER; isFakeBoldText = true; isAntiAlias = true },
                )
            }
        }
        // Magnifier.
        val f = finger
        if (f != null) {
            Canvas(Modifier.padding(8.dp).size(140.dp).border(2.dp, Palette.text, CircleShape).background(Color.Black, CircleShape)) {
                val zoom = 3f
                val r = size.minDimension / 2
                val srcHalf = (r / (scale * zoom)).roundToInt().coerceAtLeast(4)
                val clip = Path().apply { addOval(androidx.compose.ui.geometry.Rect(0f, 0f, size.width, size.height)) }
                clipPath(clip) {
                    val sx = (f.x.roundToInt() - srcHalf).coerceIn(0, (bmp.width - 2 * srcHalf).coerceAtLeast(0))
                    val sy = (f.y.roundToInt() - srcHalf).coerceIn(0, (bmp.height - 2 * srcHalf).coerceAtLeast(0))
                    drawImage(bmp, srcOffset = IntOffset(sx, sy), srcSize = IntSize(2 * srcHalf, 2 * srcHalf), dstSize = IntSize(size.width.roundToInt(), size.height.roundToInt()))
                    val k = size.width / (2f * srcHalf)
                    val cx = (f.x - sx) * k; val cy = (f.y - sy) * k
                    drawLine(Palette.manual, Offset(cx - 18, cy), Offset(cx + 18, cy), 2f)
                    drawLine(Palette.manual, Offset(cx, cy - 18), Offset(cx, cy + 18), 2f)
                }
            }
        }
    }
}
