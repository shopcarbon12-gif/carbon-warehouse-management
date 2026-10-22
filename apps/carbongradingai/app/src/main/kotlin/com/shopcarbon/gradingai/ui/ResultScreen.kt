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
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.material.icons.filled.CameraAlt
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
import com.shopcarbon.gradingai.measure.Photo
import com.shopcarbon.gradingai.measure.Pt
import com.shopcarbon.gradingai.measure.Units
import com.shopcarbon.gradingai.sync.ScanStore
import java.io.File
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.roundToInt

fun sourceColor(l: MLine?): Color = when {
    l == null -> Palette.muted
    l.moved || l.source == "manual" -> Palette.manual
    l.source == "ai" -> Palette.ai
    else -> Palette.outline
}

/** A value against the size guide: green within 1 cm, orange within 2.5 cm, red beyond. */
fun guideColor(delta: Double): Color = when {
    abs(delta) <= 1.0 -> Palette.ok
    abs(delta) <= 2.5 -> Palette.warn
    else -> Palette.bad
}

fun signed(d: Double): String = (if (d >= 0) "+" else "−") + Units.cm(abs(d))

/** Result: Size AI's lines on the squared-up photo, every end draggable, then Save. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ResultScreen(nav: Nav, s: MeasureSession) {
    val ctx = LocalContext.current
    val app = App.get(ctx)
    val scope = rememberCoroutineScope()
    var units by remember { mutableStateOf(app.prefs.units) }
    var selected by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    /* Save pressed while the AI is still placing points: it waits and saves by
       itself when the AI answers (owner, 2026-10-21: sizes 32, 33 and 36 were
       saved before the crotch came back and kept the outline's guess). */
    var saveWhenReady by remember { mutableStateOf(false) }
    var err by remember { mutableStateOf<String?>(null) }
    var tick by remember { mutableLongStateOf(0L) }
    var picking by remember { mutableStateOf(false) }
    val limit = app.config?.capture?.pairLimitCm ?: 1f
    val crotch = s.crotch
    LaunchedEffect(s.ai, crotch?.ai) { while (s.ai is AiState.Running || crotch?.ai is AiState.Running) { tick = System.currentTimeMillis(); delay(500) } }
    val aiBusy = s.ai is AiState.Running || crotch?.ai is AiState.Running
    val cm = s.cm()
    // Every point's value, removed ones included, for the rows and the photo labels.
    val allCm = s.allCm()

    fun discardAll() { ScanStore.discard(ctx, s.scan.id); crotch?.let { ScanStore.discard(ctx, it.scan.id) } }
    fun save() {
        saving = true; err = null
        scope.launch {
            try {
                // The crotch photo travels in the scan's own folder, so an offline save keeps both.
                crotch?.let { c -> c.scan.photoFile.copyTo(File(s.scan.photoFile.parentFile, "crotch.jpg"), overwrite = true) }
                val res = ScanStore.save(ctx, s.scan.id, s.meta(app))
                crotch?.let { ScanStore.discard(ctx, it.scan.id) }
                nav.replace(Screen.Saved(s, res, res == null))
            } catch (e: Exception) {
                err = e.message ?: "Could not save"
            } finally { saving = false }
        }
    }
    fun switchTo(id: String) {
        val p = app.config?.profile(id) ?: return
        picking = false
        nav.replace(Screen.Result(s.switchTo(app, p)))
    }

    LaunchedEffect(saveWhenReady, aiBusy) { if (saveWhenReady && !aiBusy && !saving) { saveWhenReady = false; save() } }

    val guide = s.target.lookup.guideFor(s.target.sizeLabel)
    Page(
        "Check lines",
        onBack = { s.cancelAi(); discardAll(); nav.back() },
        largeTitle = false,
        actions = { GlassCircle(androidx.compose.material.icons.Icons.Filled.CameraAlt, "Retake", { s.cancelAi(); discardAll(); nav.replace(Screen.Capture(s.target)) }) },
        bottom = {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Secondary("Undo", Modifier.width(96.dp), enabled = s.canUndo) { s.undo() }
                Primary(
                    when { saving -> "Saving…"; saveWhenReady && aiBusy -> "Waiting for AI… saves itself"; else -> "Save to CarbonWMS" },
                    Modifier.weight(1f), enabled = !saving && !saveWhenReady && cm.isNotEmpty(),
                ) { if (aiBusy) saveWhenReady = true else save() }
            }
        },
    ) {
        Text("${s.target.lookup.name} · ${s.target.sizeLabel}", style = MaterialTheme.typography.headlineSmall, color = Palette.text)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(s.profile.label, style = MaterialTheme.typography.bodyMedium, color = Palette.text, modifier = Modifier.weight(1f))
            Pill(if (picking) "Close" else "Change type") { picking = !picking }
        }
        Muted("${s.scan.depth.distanceCm.roundToInt()} cm · ${s.scan.depth.tiltDeg.roundToInt()}° · ${if (s.scan.depth.tof) "depth sensor" else "TEST MODE"}")
        if (picking) Card {
            Muted("Measure this same photo as another type — no new photo needed.")
            for ((group, list) in app.config?.groupedProfiles().orEmpty()) {
                Text(group, style = MaterialTheme.typography.bodySmall, color = Palette.muted)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (p in list) Pill(p.label, filled = p.id == s.profile.id) { if (p.id != s.profile.id) switchTo(p.id) }
                }
            }
        }
        // Sleeved type but the photo shows no sleeves: offer the sleeveless one.
        val alt = s.profile.sleeveless?.let { app.config?.profile(it) }
        val sleeveKeys = s.profile.points.filter { it.key.startsWith("sleeve") || it.key.startsWith("cuff") }.map { it.key }
        if (alt != null && sleeveKeys.isNotEmpty() && sleeveKeys.all { it in s.scan.unsure }) {
            Card {
                Text("No sleeves found on this photo.", style = MaterialTheme.typography.bodyMedium, color = Palette.warn)
                Secondary("Measure as ${alt.label}") { switchTo(alt.id) }
            }
        }
        when (val a = s.ai) {
            is AiState.Running -> Notice("AI is placing the seam points… ${((tick - a.startedAt) / 1000).coerceAtLeast(0)} s. You can lay out the next garment meanwhile.", Palette.ai)
            is AiState.Done -> Muted("AI placed ${a.placed} points in ${a.ms / 1000} s.${if (a.remarks.isNotBlank()) " " + a.remarks else ""}")
            else -> {}
        }
        // The AI answered (or never ran) without some of photo 1's seam points: say so, and offer it again.
        s.missingAi().takeIf { it.isNotEmpty() && s.ai !is AiState.Failed }?.let { miss ->
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Notice("The AI did not place: ${miss.joinToString { k -> s.profile.points.firstOrNull { it.key == k }?.label ?: k }}. These are the outline's guess — try the AI again or move them by hand.", Palette.warn)
                Secondary("Try the AI again") { s.startAi(app) }
            }
        }
        when (val a = s.ai) {
            is AiState.Done, is AiState.Running -> {}
            is AiState.Failed -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Notice("AI assist failed: ${a.message}. Drag the seam points onto the seams by hand, or try again.", Palette.warn)
                Secondary("Try the AI again") { s.startAi(app) }
            }
            is AiState.Off -> Muted(a.why)
            AiState.Idle -> {}
        }
        PhotoEditor(s, Photo.MAIN, selected, units, allCm, onSelect = { selected = it })
        if (crotch != null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Photo 2 (${s.profile.secondTitle}) — " + s.crotchKeys.map { k -> s.profile.points.firstOrNull { it.key == k }?.label?.removeSuffix(" L")?.removeSuffix(" R") ?: k }.distinct().joinToString(), style = MaterialTheme.typography.bodyMedium, color = Palette.text, modifier = Modifier.weight(1f))
                Pill("Retake", Palette.muted) { crotch.job?.cancel(); ScanStore.discard(ctx, crotch.scan.id); nav.replace(Screen.Capture(s.target, s)) }
            }
            when (val a = crotch.ai) {
                is AiState.Running -> Notice("AI is placing the ${s.profile.secondTitle} points (twice, to check itself)… ${((tick - a.startedAt) / 1000).coerceAtLeast(0)} s.", Palette.ai)
                is AiState.Done -> Muted("AI placed photo 2 in ${a.ms / 1000} s." + (crotch.spreadCm.values.maxOrNull()?.let { " Its two placements agree within ${Units.cm(it)} cm." } ?: ""))
                is AiState.Failed -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Notice("AI assist failed on photo 2: ${a.message}.", Palette.warn)
                    Secondary("Try the AI again") { s.startCrotchAi(app) }
                }
                is AiState.Off -> Muted(a.why)
                AiState.Idle -> {}
            }
            PhotoEditor(s, Photo.CROTCH, selected, units, allCm, onSelect = { selected = it })
        } else if (s.crotchKeys.isNotEmpty()) {
            Secondary("Take photo 2 (${s.profile.secondTitle})") { s.cancelAi(); nav.replace(Screen.Capture(s.target, s)) }
        }
        Legend()
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for ((k, label) in listOf("cm" to "CM", "in" to "INCH", "both" to "BOTH")) Pill(label, filled = units == k) { units = k; app.prefs.units = k }
        }
        Muted("✕ leaves a measurement out of this save (remembered for this product's other sizes)." + if (guide.isNotEmpty()) " The chips compare with the size guide." else "")
        // Points, L/R pairs on one row.
        val shown = mutableSetOf<String>()
        for (p in s.profile.points) {
            if (p.key in shown) continue
            val pair = p.pairOf?.let { plain -> s.profile.points.filter { it.pairOf == plain } } ?: listOf(p)
            pair.forEach { shown += it.key }
            val keys = pair.map { it.key }
            val off = keys.all { it in s.removed }
            val vals = pair.map { allCm[it.key] }
            val mismatch = !off && vals.size == 2 && vals.all { it != null } && abs(vals[0]!! - vals[1]!!) > limit
            val isSel = pair.any { it.key == selected }
            Row(
                Modifier.fillMaxWidth().background(if (isSel) Palette.accentSoft else Palette.surface, RoundedCornerShape(14.dp))
                    .clickable { if (off) s.toggleRemoved(app, keys) else selected = pair.first().key }.padding(start = 12.dp, top = 8.dp, bottom = 8.dp, end = 4.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Box(Modifier.size(26.dp).background((if (off) Palette.muted else sourceColor(s.lines[p.key] ?: crotch?.lines?.get(p.key))).copy(alpha = 0.25f), CircleShape), contentAlignment = Alignment.Center) {
                    Text(p.letter, style = MaterialTheme.typography.labelMedium, color = if (off) Palette.muted else Palette.text)
                }
                Column(Modifier.weight(1f)) {
                    Text(if (pair.size == 2) p.label.removeSuffix(" L") + " L / R" else p.label, style = MaterialTheme.typography.bodyMedium, color = if (off) Palette.muted else Palette.text)
                    if (off) Text("left out — tap to bring it back", style = MaterialTheme.typography.bodySmall, color = Palette.muted)
                    else {
                        val tags = pair.mapNotNull { s.lines[it.key] ?: crotch?.lines?.get(it.key) }.map { if (it.moved) "Edited" else if (it.source == "ai") "AI" else "" }.filter { it.isNotEmpty() }.distinct()
                        if (tags.isNotEmpty() || mismatch) Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            tags.forEach { t -> Badge(t, if (t == "AI") Palette.ai else Palette.manual) }
                            if (mismatch) Badge("L/R differ", Palette.warn)
                        }
                    }
                }
                // Against the size guide: the pair's average (or the single value) minus the guide's number.
                val gv = guide[p.pairOf ?: p.key] ?: guide[p.key]
                val mine = vals.filterNotNull().takeIf { it.isNotEmpty() }?.average()
                if (!off && gv != null && mine != null) Badge(signed(mine - gv), guideColor(mine - gv))
                if (!off) Text(
                    vals.joinToString(" / ") { v -> v?.let { Units.show(it, units) } ?: "—" },
                    style = MaterialTheme.typography.titleMedium, color = if (vals.any { it == null }) Palette.muted else Palette.text, fontWeight = FontWeight.SemiBold,
                )
                Text(
                    if (off) "↺" else "✕",
                    style = MaterialTheme.typography.titleMedium, color = Palette.muted,
                    modifier = Modifier.clickable { s.toggleRemoved(app, keys) }.padding(horizontal = 10.dp, vertical = 4.dp),
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
    for ((c, t) in listOf(Palette.outline to "outline", Palette.ai to "AI", Palette.manual to "edited by you")) Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(10.dp).background(c, CircleShape)); Text(" $t", style = MaterialTheme.typography.bodySmall, color = Palette.muted)
    }
}

/**
 * The photo with every line and its value. Tap a line to pick it; drag an end
 * to move it. While dragging, a magnifier shows the spot under the finger at
 * 3×, on the side of the photo away from the finger.
 */
@Composable
fun PhotoEditor(s: MeasureSession, which: Photo, selected: String?, units: String, allCm: Map<String, Double>, maxHeightFraction: Float = 0.6f, onSelect: (String?) -> Unit) {
    val photo = if (which == Photo.CROTCH) s.crotch?.scan?.photo ?: return else s.scan.photo
    val bmp = remember(photo) { photo.asImageBitmap() }
    val density = LocalDensity.current
    var drag by remember { mutableStateOf<Pair<String, Int>?>(null) }
    val selectedNow = androidx.compose.runtime.rememberUpdatedState(selected)
    var finger by remember { mutableStateOf<Pt?>(null) }
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val wPx = with(density) { maxWidth.toPx() }
        // At most ~60% of the screen tall, so the list below stays reachable on tall garments.
        val maxH = with(density) { (LocalConfiguration.current.screenHeightDp * maxHeightFraction).dp.toPx() }
        val scale = minOf(wPx / bmp.width, maxH / bmp.height)
        val hDp = with(density) { (bmp.height * scale).toDp() }
        val wDp = with(density) { (bmp.width * scale).toDp() }
        val visible = if (which == Photo.CROTCH) s.keptCrotch() else s.kept()
        fun toPhoto(o: Offset) = Pt(o.x / scale, o.y / scale)
        fun nearestEnd(o: Offset, only: String?): Pair<String, Int>? {
            var best: Pair<String, Int>? = null; var bd = with(density) { 34.dp.toPx() }
            for ((k, l) in visible) {
                if (only != null && k != only) continue
                l.pts.forEachIndexed { i, p -> val d = hypot(p.x * scale - o.x, p.y * scale - o.y); if (d < bd) { bd = d; best = k to i } }
            }
            return best
        }
        fun nearestLine(o: Offset): String? {
            var best: String? = null; var bd = with(density) { 26.dp.toPx() }
            for ((k, l) in visible) for ((a, b) in l.pts.zipWithNext()) {
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
                .pointerInput(s, which) { detectTapGestures { o -> onSelect(nearestLine(o)) } }
                // Keyed without `selected`: picking the line while dragging must not restart the gesture
                // (a restart dropped the finger-up, so the magnifier stayed on screen); it is read live instead.
                .pointerInput(s, which) {
                    detectDragGestures(
                        onDragStart = { o ->
                            val h = nearestEnd(o, selectedNow.value) ?: nearestEnd(o, null)
                            if (h != null) { s.beginEdit(); drag = h; onSelect(h.first); finger = toPhoto(o) }
                        },
                        onDrag = { change, _ ->
                            val h = drag ?: return@detectDragGestures
                            change.consume()
                            val p = toPhoto(change.position)
                            val clamped = Pt(p.x.coerceIn(0f, bmp.width.toFloat()), p.y.coerceIn(0f, bmp.height.toFloat()))
                            s.moveEnd(which, h.first, h.second, clamped)
                            finger = clamped
                        },
                        onDragEnd = { drag = null; finger = null },
                        onDragCancel = { drag = null; finger = null },
                    )
                },
        ) {
            drawImage(bmp, dstSize = IntSize(size.width.roundToInt(), size.height.roundToInt()))
            val letters = s.profile.points.associate { it.key to (it.letter + (it.side ?: "")) }
            val textPaint = android.graphics.Paint().apply { color = android.graphics.Color.WHITE; textSize = 26f; isFakeBoldText = true; isAntiAlias = true }
            val boxPaint = android.graphics.Paint().apply { color = android.graphics.Color.argb(190, 0, 0, 0); isAntiAlias = true }
            for ((k, l) in visible) {
                val c = sourceColor(l)
                val sel = k == selected
                val path = Path().apply { l.pts.forEachIndexed { i, p -> if (i == 0) moveTo(p.x * scale, p.y * scale) else lineTo(p.x * scale, p.y * scale) } }
                drawPath(path, Color.Black.copy(alpha = 0.55f), style = Stroke(width = if (sel) 9f else 6f, cap = StrokeCap.Round))
                drawPath(path, c, style = Stroke(width = if (sel) 5f else 3f, cap = StrokeCap.Round))
                for (p in l.pts) {
                    drawCircle(Color.Black.copy(alpha = 0.6f), radius = if (sel) 15f else 8f, center = Offset(p.x * scale, p.y * scale))
                    drawCircle(c, radius = if (sel) 11f else 5f, center = Offset(p.x * scale, p.y * scale), style = if (sel) Stroke(4f) else androidx.compose.ui.graphics.drawscope.Fill)
                }
                // The value beside its line: letter + number, nudged off the line so it never hides an end.
                val a = l.pts.first(); val b = l.pts.last()
                val mx = (a.x + b.x) / 2 * scale; val my = (a.y + b.y) / 2 * scale
                val dx = (b.x - a.x); val dy = (b.y - a.y); val len = hypot(dx, dy).coerceAtLeast(1f)
                var nx = -dy / len; var ny = dx / len
                if (ny > 0) { nx = -nx; ny = -ny }
                val label = "${letters[k] ?: k}  ${allCm[k]?.let { Units.show(it, units) } ?: ""}"
                val tw = textPaint.measureText(label)
                val cx = (mx + nx * 22f).coerceIn(tw / 2 + 4, size.width - tw / 2 - 4)
                val cy = (my + ny * 22f).coerceIn(30f, size.height - 6f)
                drawContext.canvas.nativeCanvas.drawRoundRect(cx - tw / 2 - 8, cy - 24, cx + tw / 2 + 8, cy + 8, 10f, 10f, boxPaint)
                drawContext.canvas.nativeCanvas.drawText(label, cx - tw / 2, cy, textPaint)
            }
        }
        // Magnifier, on the side away from the finger.
        val f = finger
        if (f != null) {
            val leftHalf = f.x * scale < wPx / 2
            val topThird = f.y * scale < with(density) { hDp.toPx() } * 0.4f
            val where = when {
                leftHalf && !topThird -> Alignment.TopEnd
                leftHalf && topThird -> Alignment.BottomEnd
                !leftHalf && !topThird -> Alignment.TopStart
                else -> Alignment.BottomStart
            }
            Box(Modifier.align(Alignment.TopCenter).width(wDp).height(hDp)) {
                Canvas(Modifier.align(where).padding(8.dp).size(140.dp).border(2.dp, Palette.text, CircleShape).background(Color.Black, CircleShape)) {
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
}
