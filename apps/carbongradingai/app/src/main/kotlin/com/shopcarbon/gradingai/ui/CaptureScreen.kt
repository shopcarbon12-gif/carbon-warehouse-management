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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
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
 */
@Composable
fun CaptureScreen(nav: Nav, target: MeasureTarget) {
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

    fun onCaptured(b: CaptureBundle) {
        processing = "Squaring up the photo…"
        scope.launch {
            try {
                processing = "Finding the garment…"
                val scan = Pipeline.process(ctx, b, target.profile, app.prefs.calibration)
                val session = MeasureSession(target, scan, testPhone, app.prefs.skippedFor(target.lookup.matrixId))
                session.startAi(app)
                nav.replace(Screen.Result(session))
            } catch (e: Exception) {
                problem = e.message ?: "Could not measure that photo."
                processing = null; fired = false; readySince = 0L
            }
        }
    }

    val cues = remember { Cues(ctx) }
    DisposableEffect(Unit) { onDispose { cues.release() } }
    val camera = remember {
        ArCamera(
            activity, requireTof = !testPhone,
            coverage = { Segmenter.coverage(it) },
            onLive = { live = it },
            onCaptured = { onCaptured(it) },
            onFailure = { problem = it },
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
    val checks = listOf(
        Check("Surface", plane?.let { it.inlierFrac >= 0.45 }, plane?.let { "${(it.inlierFrac * 100).roundToInt()}%" } ?: "—"),
        Check("Distance", dist?.let { it.toFloat() in range }, dist?.let { "${it.roundToInt()} cm" } ?: "—"),
        Check("Level", plane?.let { it.tiltDeg <= maxTilt }, plane?.let { "${it.tiltDeg.roundToInt()}°" } ?: "—"),
        Check("Coverage", st?.cutOff?.isEmpty(), when { st?.cutOff == null -> "—"; st.cutOff.isEmpty() -> "100%"; else -> "cut off" }),
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
    LaunchedEffect(ready, auto, processing) {
        if (!ready || !auto || processing != null) { readySince = 0L; return@LaunchedEffect }
        readySince = System.currentTimeMillis()
        kotlinx.coroutines.delay(cap?.holdStillMs ?: 800)
        if (!fired) { fired = true; cues.captured(); camera.requestCapture() }
    }
    val hint = when {
        processing != null -> processing!!
        st == null || !st.tracking -> "Point at the garment and move the phone slowly for a second"
        plane == null -> if (st.tof) "Looking for the table…" else "Move the phone slowly — depth from motion needs a moment"
        dist != null && dist < range.start -> "Move the phone up (${dist.roundToInt()} cm — aim for ${ideal.start.roundToInt()}–${ideal.endInclusive.roundToInt()})"
        dist != null && dist > range.endInclusive -> "Move the phone down (${dist.roundToInt()} cm)"
        plane.tiltDeg > maxTilt -> "Hold the phone level over the garment"
        st.cutOff == null -> "Looking for the garment…"
        st.cutOff.isNotEmpty() -> "The garment is cut off at the ${st.cutOff.joinToString(" and ")} — move up or centre it"
        !st.still -> "Hold still…"
        auto -> "Hold still… capturing"
        else -> "Ready — tap the shutter"
    }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView({ camera.view }, Modifier.fillMaxSize())
        // Frame guide: where the garment should sit.
        Box(Modifier.fillMaxSize().padding(horizontal = 18.dp, vertical = 150.dp).border(2.dp, if (ready) Palette.accent else Color.White.copy(alpha = 0.5f), RoundedCornerShape(16.dp)))
        // Readable from a metre away: the whole screen edge turns green when every check passes.
        if (allGreen && processing == null) Box(Modifier.fillMaxSize().border(14.dp, Palette.accent))
        Column(Modifier.fillMaxWidth().statusBarsPadding().background(Color.Black.copy(alpha = 0.55f)).padding(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { nav.back() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = Color.White) }
                Column(Modifier.weight(1f)) {
                    Text("${target.lookup.name} · ${target.sizeLabel}", style = MaterialTheme.typography.titleMedium, color = Color.White)
                    Text(target.profile.label + if (testPhone) " · TEST MODE" else "", style = MaterialTheme.typography.bodySmall, color = if (testPhone) Palette.warn else Palette.muted)
                }
                Text("Auto", style = MaterialTheme.typography.bodySmall, color = Color.White)
                Switch(auto, { auto = it; app.prefs.autoCapture = it })
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for (c in checks) {
                    val col = when (c.ok) { true -> Palette.accent; false -> Palette.warn; null -> Palette.muted }
                    Column(Modifier.weight(1f).background(col.copy(alpha = 0.18f), RoundedCornerShape(8.dp)).padding(6.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(c.label + if (c.ok == true) " ✓" else "", style = MaterialTheme.typography.labelSmall, color = col)
                        Text(c.value, style = MaterialTheme.typography.labelMedium, color = Color.White)
                    }
                }
            }
            Text(target.profile.lay, style = MaterialTheme.typography.bodySmall, color = Color.White.copy(alpha = 0.85f))
        }
        Column(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(Color.Black.copy(alpha = 0.55f)).navigationBarsPadding().padding(12.dp),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            problem?.let { Text(it, color = Palette.bad, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center) }
            Text(hint, color = if (ready) Palette.accent else Color.White, style = MaterialTheme.typography.bodyLarge, textAlign = TextAlign.Center)
            if (processing != null) CircularProgressIndicator(color = Palette.accent)
            else Box(
                Modifier.size(74.dp).border(4.dp, Color.White, CircleShape).padding(7.dp)
                    .background(if (allGreen) Palette.accent else Color.White.copy(alpha = 0.35f), CircleShape)
                    .then(Modifier.clickableNoRipple(enabled = st?.tracking == true) { problem = null; fired = true; cues.captured(); camera.requestCapture() }),
            )
            if (ready && auto && readySince > 0) Text("${((cap?.holdStillMs ?: 800) - (now - readySince)).coerceAtLeast(0) / 100 / 10.0} s", color = Palette.muted, style = MaterialTheme.typography.bodySmall)
        }
    }
}

private fun Modifier.clickableNoRipple(enabled: Boolean, onClick: () -> Unit): Modifier =
    this.clickable(enabled = enabled, onClick = onClick)
