package com.shopcarbon.gradingai.ui

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.google.ar.core.ArCoreApk
import com.shopcarbon.gradingai.App
import com.shopcarbon.gradingai.ar.ArCamera
import com.shopcarbon.gradingai.ar.CaptureBundle
import com.shopcarbon.gradingai.ar.LiveStatus
import com.shopcarbon.gradingai.measure.MeasureSession
import com.shopcarbon.gradingai.measure.MeasureTarget
import com.shopcarbon.gradingai.measure.Pipeline
import com.shopcarbon.gradingai.vision.Segmenter
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

private data class Check(val label: String, val ok: Boolean?, val value: String)

/**
 * Size AI's capture, on the depth sensor: the table is found, the distance,
 * level and coverage are checked live, and the photo is taken by itself once
 * everything has been green and the phone still for a moment.
 *
 * Bottoms take two photos (owner, 2026-10-20): the normal one, then — with
 * `crotchFor` set — the legs pulled apart so the crotch lies flat, for the
 * rise and inseams only.
 */
@Composable
fun CaptureScreen(nav: Nav, target: MeasureTarget, crotchFor: MeasureSession? = null) {
    val ctx = LocalContext.current
    val activity = ctx as Activity
    val app = App.get(ctx)
    val cap = app.config?.capture
    val scope = rememberCoroutineScope()
    val supported = phoneSupported(app)
    val testPhone = !supported
    var granted by remember { mutableStateOf(ContextCompat.checkSelfPermission(ctx, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted = it }
    var problem by remember { mutableStateOf<String?>(null) }
    var live by remember { mutableStateOf<LiveStatus?>(null) }
    var processing by remember { mutableStateOf<String?>(null) }
    var auto by remember { mutableStateOf(app.prefs.autoCapture) }
    var readySince by remember { mutableLongStateOf(0L) }
    var fired by remember { mutableStateOf(false) }
    var installRequested by remember { mutableStateOf(false) }
    /** The camera picture's place on screen (px): the frame box is drawn exactly there. */
    var preview by remember { mutableStateOf<IntArray?>(null) }

    // Only ask for the camera where the app can measure (a supported phone, or test mode).
    LaunchedEffect(Unit) { if (!granted && (supported || app.prefs.testMode)) ask.launch(Manifest.permission.CAMERA) }
    if (!supported && !app.prefs.testMode) {
        Page("Capture", onBack = { nav.back() }) {
            Notice("This phone has no time-of-flight depth sensor, so it cannot set the scale. CarbonGradingAI measures on the Galaxy Note10+, Note10+ 5G, S20+ and S20 Ultra. Test mode (Settings) lets you try the app here without writing to the item.")
        }
        return
    }
    if (!granted) {
        Page("Capture", onBack = { nav.back() }) { Notice("The camera permission is needed to measure."); Primary("Allow camera") { ask.launch(Manifest.permission.CAMERA) } }
        return
    }

    val cues = remember { Cues(ctx) }
    DisposableEffect(Unit) { onDispose { cues.release() } }

    fun onCaptured(b: CaptureBundle) {
        cues.captured()
        processing = "Squaring up the photo…"
        scope.launch {
            try {
                processing = "Finding the garment…"
                val scan = Pipeline.process(ctx, b, target.profile, app.prefs.calibration)
                if (crotchFor != null) {
                    crotchFor.attachCrotch(app, scan)
                    nav.replace(Screen.Result(crotchFor))
                    return@launch
                }
                val twoPhotos = target.profile.crotchKeys.isNotEmpty()
                val session = MeasureSession(target, scan, testPhone, app.prefs.skippedFor(target.lookup.matrixId), crotchPlanned = twoPhotos)
                session.startAi(app)
                nav.replace(if (twoPhotos) Screen.Capture(target, session) else Screen.Result(session))
            } catch (e: Exception) {
                problem = e.message ?: "Could not measure that photo."
                processing = null; fired = false; readySince = 0L
            }
        }
    }

    val camera = remember {
        ArCamera(
            activity, requireTof = !testPhone,
            coverage = { Segmenter.coverage(it) },
            onLive = { live = it },
            onCaptured = { onCaptured(it) },
            onFailure = { problem = it },
            // No fresh depth for the photo: say so and let auto-capture try again.
            onDepthTimeout = { problem = it; fired = false; readySince = 0L; cues.lost() },
            onPreview = { preview = it },
        )
    }
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner) {
        fun start() {
            try {
                when (ArCoreApk.getInstance().requestInstall(activity, !installRequested)) {
                    ArCoreApk.InstallStatus.INSTALL_REQUESTED -> { installRequested = true; return }
                    else -> {}
                }
            } catch (e: Exception) {
                problem = "Google Play Services for AR is needed: ${e.message}"
                return
            }
            camera.resume()?.let { problem = it }
        }
        val obs = LifecycleEventObserver { _, e ->
            when (e) {
                Lifecycle.Event.ON_RESUME -> start()
                Lifecycle.Event.ON_PAUSE -> camera.pause()
                else -> {}
            }
        }
        owner.lifecycle.addObserver(obs)
        if (owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) start()
        onDispose { owner.lifecycle.removeObserver(obs); camera.pause(); camera.close() }
    }

    val st = live
    val plane = st?.plane?.takeIf { st.depthAgeMs < 1500 }
    val dist = plane?.axisDistanceM?.times(100)
    val range = cap?.distanceCm ?: 45f..120f
    val ideal = cap?.idealDistanceCm ?: 70f..110f
    val maxTilt = cap?.maxTiltDeg ?: 8f
    /* The crotch photo needs only the waistband, the crotch and the inner hems:
       with the legs spread the outer sides often run past the frame, and that is
       fine for the rise and inseams (owner, 2026-10-20: "it says the item is cut"). */
    val sidesOk = if (crotchFor != null) target.profile.secondSidesOk else emptySet()
    val checks = listOf(
        Check("Surface", plane?.let { it.inlierFrac >= 0.45 }, plane?.let { "${(it.inlierFrac * 100).roundToInt()}%" } ?: "—"),
        Check("Distance", dist?.let { it.toFloat() in range }, dist?.let { "${it.roundToInt()} cm" } ?: "—"),
        Check("Level", plane?.let { it.tiltDeg <= maxTilt }, plane?.let { "${it.tiltDeg.roundToInt()}°" } ?: "—"),
        Check("Coverage", st?.cutOff?.let { cut -> cut.none { it !in sidesOk } }, when { st?.cutOff == null -> "—"; st.cutOff.isEmpty() -> "100%"; st.cutOff.none { it !in sidesOk } -> "sides cut — OK"; else -> "cut off" }),
    )
    val allGreen = checks.all { it.ok == true } && st?.tracking == true
    val ready = allGreen && st.still
    val now = System.currentTimeMillis()
    // Sound + vibration: the phone is held too high to read (see Cues).
    var wasGreen by remember { mutableStateOf(false) }
    LaunchedEffect(allGreen, processing) {
        if (processing != null || fired) return@LaunchedEffect
        if (allGreen && !wasGreen) cues.ready()
        if (!allGreen && wasGreen) cues.lost()
        wasGreen = allGreen
    }
    // `fired` is a key so a depth timeout (fired → false) re-arms the hold while it stays green.
    LaunchedEffect(ready, auto, processing, fired) {
        if (!ready || !auto || processing != null) { readySince = 0L; return@LaunchedEffect }
        readySince = System.currentTimeMillis()
        kotlinx.coroutines.delay(cap?.holdStillMs ?: 800)
        if (!fired) { fired = true; problem = null; camera.requestCapture() }
    }
    val hint = when {
        processing != null -> processing!!
        st == null || !st.tracking -> "Point at the garment and move the phone slowly for a second"
        plane == null -> if (st.tof) "Looking for the table…" else "Move the phone slowly — depth from motion needs a moment"
        dist != null && dist < range.start -> "Move the phone up (${dist.roundToInt()} cm — aim for ${ideal.start.roundToInt()}–${ideal.endInclusive.roundToInt()})"
        dist != null && dist > range.endInclusive -> "Move the phone down (${dist.roundToInt()} cm)"
        plane.tiltDeg > maxTilt -> "Hold the phone level over the garment"
        st.cutOff == null -> "Looking for the garment…"
        st.cutOff.any { it !in sidesOk } -> "The garment is cut off at the ${st.cutOff.joinToString(" and ")} — move up or centre it"
        !st.still -> "Hold still…"
        auto -> "Hold still… capturing"
        else -> "Ready — tap the shutter"
    }

    val surfaceOk = checks[0].ok
    val distOk = checks[1].ok
    val chips = listOf(
        Check(dist?.let { "${it.roundToInt()} cm" } ?: "Distance", if (surfaceOk == false) false else distOk, ""),
        Check("Level", checks[2].ok, ""),
        Check(if (checks[3].ok == false) "Not all in frame" else "All in frame", checks[3].ok, ""),
        Check(if (st?.still == false) "Moving" else "Still", st?.still, ""),
    )
    val holdMs = (cap?.holdStillMs ?: 800).toFloat()
    val countdown = if (ready && auto && readySince > 0) ((now - readySince) / holdMs).coerceIn(0f, 1f) else 0f
    // Re-draw the countdown ring while it runs.
    var frame by remember { mutableLongStateOf(0L) }
    LaunchedEffect(ready, auto, readySince) { while (ready && auto && readySince > 0 && !fired) { frame = System.currentTimeMillis(); kotlinx.coroutines.delay(50) } }
    @Suppress("UNUSED_EXPRESSION") frame

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView({ camera.view }, Modifier.fillMaxSize())
        val two = crotchFor != null || target.profile.crotchKeys.isNotEmpty()
        /* Slim top (owner, 2026-10-22: "I need to hold the phone really high"): two short rows, so
           the camera picture — and the photo area's corners — are not hidden behind the bars. */
        Column(Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 10.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                GlassCircle(Icons.Filled.Close, "Close", { crotchFor?.cancelAi(); nav.back() }, dark = true)
                Text(
                    "${target.lookup.name} · ${target.sizeLabel}" +
                        (if (crotchFor != null) " · Photo 2 of 2" else if (two) " · Photo 1 of 2" else "") + if (testPhone) " · TEST" else "",
                    style = MaterialTheme.typography.labelMedium, color = Color.White, maxLines = 1,
                    modifier = Modifier.weight(1f).background(if (crotchFor != null) Palette.accent.copy(alpha = 0.85f) else Palette.glassDark, RoundedCornerShape(50)).padding(horizontal = 12.dp, vertical = 8.dp),
                )
                Text(
                    if (auto) "Auto" else "Manual", style = MaterialTheme.typography.labelMedium, color = if (auto) Color.White else Palette.warn,
                    modifier = Modifier.background(Palette.glassDark, RoundedCornerShape(50)).clickable { auto = !auto; app.prefs.autoCapture = auto }.padding(horizontal = 12.dp, vertical = 8.dp),
                )
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                for (c in chips) {
                    val col = when (c.ok) { true -> Palette.ok; false -> Palette.warn; null -> Color.White.copy(alpha = 0.5f) }
                    Row(
                        Modifier.weight(1f).background(Palette.glassDark, RoundedCornerShape(50)).padding(horizontal = 6.dp, vertical = 5.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center,
                    ) {
                        Box(Modifier.size(7.dp).background(col, CircleShape))
                        Text(" ${c.label}", style = MaterialTheme.typography.labelSmall, color = Color.White, maxLines = 1)
                    }
                }
            }
            // Only photo 2's short instruction stays on the camera; how to lay photo 1 is on the item screen.
            if (crotchFor != null) Text(
                target.profile.crotchLay.ifBlank { "Lay it as shown for the ${target.profile.secondTitle}." },
                style = MaterialTheme.typography.labelSmall, color = Color.White, maxLines = 2,
                modifier = Modifier.background(Palette.glassDark, RoundedCornerShape(10.dp)).padding(horizontal = 10.dp, vertical = 5.dp),
            )
        }
        Column(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth().navigationBarsPadding().padding(horizontal = 16.dp, vertical = 8.dp),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            problem?.let {
                Text(it, color = Color.White, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center,
                    modifier = Modifier.background(Palette.bad.copy(alpha = 0.85f), RoundedCornerShape(14.dp)).padding(horizontal = 14.dp, vertical = 8.dp))
            }
            if (processing != null) ProcessingCard(processing!!)
            else {
                val arrow = when {
                    hint.startsWith("Move the phone up") || hint.contains("cut off") -> Icons.Filled.ArrowUpward
                    hint.startsWith("Move the phone down") -> Icons.Filled.ArrowDownward
                    else -> null
                }
                Row(
                    Modifier.background(if (ready) Palette.ok.copy(alpha = 0.9f) else Palette.glassDark, RoundedCornerShape(50)).padding(horizontal = 16.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    arrow?.let { Icon(it, null, tint = Color.White, modifier = Modifier.size(20.dp)) }
                    Text(hint, color = Color.White, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center)
                }
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    Shutter(enabled = st?.tracking == true, green = allGreen, countdown = countdown, label = if (auto) "Auto" else "Tap") { problem = null; fired = true; camera.requestCapture() }
                    // The second photo can be skipped: its points are then placed on the first photo.
                    if (crotchFor != null && crotchFor.crotch == null) Text(
                        "Skip", color = Color.White, style = MaterialTheme.typography.labelLarge,
                        modifier = Modifier.align(Alignment.CenterEnd).background(Palette.glassDark, RoundedCornerShape(50))
                            .clickable { crotchFor.skipCrotch(app); nav.replace(Screen.Result(crotchFor)) }.padding(horizontal = 18.dp, vertical = 10.dp),
                    )
                }
            }
        }
        // Drawn last, over the bars: the photo area's corners always show (owner, 2026-10-22).
        val density = LocalDensity.current
        preview?.let { r ->
            with(density) {
                CornerBrackets(Modifier.offset(r[0].toDp(), r[1].toDp()).size(r[2].toDp(), r[3].toDp()), if (ready) Palette.ok else Color.White)
            }
        }
        // Readable from a metre away: the whole screen edge turns green when every check passes.
        if (allGreen && processing == null) Box(Modifier.fillMaxSize().border(12.dp, Palette.ok))
    }
}

/** Four rounded corner brackets marking exactly what the photo will hold. */
@Composable
private fun CornerBrackets(modifier: Modifier, color: Color) {
    androidx.compose.foundation.Canvas(modifier) {
        val l = minOf(size.width, size.height) * 0.12f
        val w = 5.dp.toPx()
        val c = androidx.compose.ui.graphics.StrokeCap.Round
        fun seg(x1: Float, y1: Float, x2: Float, y2: Float) = drawLine(color, androidx.compose.ui.geometry.Offset(x1, y1), androidx.compose.ui.geometry.Offset(x2, y2), w, c)
        val r = size.width; val b = size.height
        seg(0f, 0f, l, 0f); seg(0f, 0f, 0f, l)
        seg(r, 0f, r - l, 0f); seg(r, 0f, r, l)
        seg(0f, b, l, b); seg(0f, b, 0f, b - l)
        seg(r, b, r - l, b); seg(r, b, r, b - l)
    }
}

/** The iPhone-camera-style shutter: white disc, a blue ring filling up while it holds still. */
@Composable
private fun Shutter(enabled: Boolean, green: Boolean, countdown: Float, label: String, onClick: () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Box(Modifier.size(70.dp).clickableNoRipple(enabled, onClick), contentAlignment = Alignment.Center) {
            androidx.compose.foundation.Canvas(Modifier.fillMaxSize()) {
                val w = 5.dp.toPx()
                drawCircle(Color.White.copy(alpha = 0.9f), radius = size.minDimension / 2 - w / 2, style = androidx.compose.ui.graphics.drawscope.Stroke(w))
                if (countdown > 0f) drawArc(
                    Palette.accent, -90f, 360f * countdown, false,
                    topLeft = androidx.compose.ui.geometry.Offset(w / 2, w / 2), size = androidx.compose.ui.geometry.Size(size.width - w, size.height - w),
                    style = androidx.compose.ui.graphics.drawscope.Stroke(w, cap = androidx.compose.ui.graphics.StrokeCap.Round),
                )
                drawCircle(if (green) Color.White else Color.White.copy(alpha = 0.55f), radius = size.minDimension / 2 - w * 2.4f)
            }
        }
        Text(label, color = if (green) Palette.accent else Color.White, style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.background(Palette.glassDark, RoundedCornerShape(50)).padding(horizontal = 10.dp, vertical = 2.dp))
    }
}

/** After the shutter: the steps the phone works through, ticked off. */
@Composable
private fun ProcessingCard(now: String) {
    val steps = listOf("Squaring up the photo", "Finding the garment", "Placing the points")
    val at = when {
        now.startsWith("Squaring") -> 0
        now.startsWith("Finding") -> 1
        else -> 2
    }
    Column(
        Modifier.fillMaxWidth().background(Color.White.copy(alpha = 0.95f), RoundedCornerShape(20.dp)).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        steps.forEachIndexed { i, t ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                when {
                    i < at -> Icon(Icons.Filled.CheckCircle, null, tint = Palette.ok, modifier = Modifier.size(22.dp))
                    i == at -> CircularProgressIndicator(Modifier.size(20.dp), color = Palette.accent, strokeWidth = 2.5.dp)
                    else -> Box(Modifier.size(22.dp))
                }
                Text(t, style = MaterialTheme.typography.bodyLarge, color = if (i <= at) Palette.text else Palette.muted)
            }
        }
    }
}

private fun Modifier.clickableNoRipple(enabled: Boolean, onClick: () -> Unit): Modifier =
    this.clickable(enabled = enabled, onClick = onClick)
