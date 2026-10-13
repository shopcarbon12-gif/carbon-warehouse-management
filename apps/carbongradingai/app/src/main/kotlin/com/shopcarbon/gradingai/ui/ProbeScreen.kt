package com.shopcarbon.gradingai.ui

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.google.ar.core.ArCoreApk
import com.shopcarbon.gradingai.App
import com.shopcarbon.gradingai.ar.ArCamera
import com.shopcarbon.gradingai.ar.LiveStatus
import com.shopcarbon.gradingai.measure.Flat
import com.shopcarbon.gradingai.measure.Pipeline
import kotlinx.coroutines.launch
import kotlin.math.hypot
import kotlin.math.roundToInt

/**
 * Phase 0: prove the depth sensor. Live: is it the time-of-flight sensor, the
 * distance to the table, its tilt and how flat the reading is. Then measure a
 * known length (a ruler, the 24 cm side of the printed target, a US Letter
 * sheet's 27.94 cm) and see the error; accept it as this phone's correction.
 */
@Composable
fun ProbeScreen(nav: Nav) {
    val ctx = LocalContext.current
    val activity = ctx as Activity
    val app = App.get(ctx)
    val scope = rememberCoroutineScope()
    var granted by remember { mutableStateOf(ContextCompat.checkSelfPermission(ctx, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted = it }
    LaunchedEffect(Unit) { if (!granted) ask.launch(Manifest.permission.CAMERA) }
    var live by remember { mutableStateOf<LiveStatus?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    var flat by remember { mutableStateOf<Flat?>(null) }
    var busy by remember { mutableStateOf(false) }
    val readings = remember { mutableStateListOf<Double>() }

    if (!granted) { Page("Depth sensor check", onBack = { nav.back() }) { Notice("The camera permission is needed.") }; return }
    val f = flat
    if (f != null) { KnownLength(nav, f, readings, onAgain = { flat = null }); return }

    val camera = remember {
        ArCamera(activity, requireTof = !app.prefs.testMode, coverage = { null }, onLive = { live = it },
            onCaptured = { b -> busy = true; scope.launch { try { flat = Pipeline.flatten(b) } catch (e: Exception) { problem = e.message } finally { busy = false } } },
            onFailure = { problem = it })
    }
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner) {
        fun start() {
            runCatching { if (ArCoreApk.getInstance().requestInstall(activity, true) == ArCoreApk.InstallStatus.INSTALL_REQUESTED) return }
            camera.resume()?.let { problem = it }
        }
        val obs = LifecycleEventObserver { _, e -> if (e == Lifecycle.Event.ON_RESUME) start() else if (e == Lifecycle.Event.ON_PAUSE) camera.pause() }
        owner.lifecycle.addObserver(obs)
        if (owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) start()
        onDispose { owner.lifecycle.removeObserver(obs); camera.pause(); camera.close() }
    }
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView({ camera.view }, Modifier.fillMaxSize())
        Column(Modifier.fillMaxWidth().background(Color.Black.copy(alpha = 0.6f)).padding(16.dp).padding(top = 24.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("Depth sensor check", style = MaterialTheme.typography.titleLarge, color = Color.White)
            val st = live; val p = st?.plane
            Text("Sensor: ${if (st?.tof == true) "time-of-flight (ToF) ✓" else if (st == null) "starting…" else "no ToF — depth from motion"}", color = Color.White)
            Text("Camera image: ${camera.imageSize.first}×${camera.imageSize.second}", color = Palette.muted)
            Text("Distance to table: ${p?.let { "${(it.axisDistanceM * 100).roundToInt()} cm" } ?: "—"}", color = Color.White)
            Text("Tilt: ${p?.let { "${"%.1f".format(it.tiltDeg)}°" } ?: "—"}   Flatness (noise): ${p?.let { "${"%.1f".format(it.rmsMm)} mm" } ?: "—"}   Surface: ${p?.let { "${(it.inlierFrac * 100).roundToInt()}%" } ?: "—"}", color = Color.White)
            Text("Lay a ruler (or the printed target, or a US Letter sheet) flat on the table, hold the phone 70–110 cm above it, level, and capture.", color = Palette.muted, style = MaterialTheme.typography.bodySmall)
            problem?.let { Text(it, color = Palette.bad) }
        }
        Column(Modifier.align(androidx.compose.ui.Alignment.BottomCenter).padding(24.dp)) {
            Primary(if (busy) "Squaring up…" else "Capture", enabled = !busy && live?.plane != null) { camera.requestCapture() }
            Secondary("Close") { nav.back() }
        }
    }
}

@Composable
private fun KnownLength(nav: Nav, f: Flat, readings: MutableList<Double>, onAgain: () -> Unit) {
    val app = App.get(LocalContext.current)
    val density = LocalDensity.current
    var a by remember { mutableStateOf(Offset(f.photo.width * 0.35f, f.photo.height * 0.5f)) }
    var b by remember { mutableStateOf(Offset(f.photo.width * 0.65f, f.photo.height * 0.5f)) }
    var truth by remember { mutableStateOf("") }
    var msg by remember { mutableStateOf<String?>(null) }
    val img = remember(f) { f.photo.asImageBitmap() }
    val measured = hypot((b.x - a.x).toDouble(), (b.y - a.y).toDouble()) / f.pxPerCm
    Page("Known length", onBack = { nav.back() }) {
        Muted("Drag the two ends onto the known length. Squared up at ${"%.2f".format(f.pxPerCm)} px/cm from ${f.depthPoints} depth points, ${(f.plane.axisDistanceM * 100).roundToInt()} cm away.")
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val scale = with(density) { maxWidth.toPx() } / f.photo.width
            Canvas(
                Modifier.fillMaxWidth().height(with(density) { (f.photo.height * scale).toDp() })
                    .pointerInput(f) {
                        var which = 0
                        detectDragGestures(
                            onDragStart = { o -> which = if (hypot(o.x - a.x * scale, o.y - a.y * scale) < hypot(o.x - b.x * scale, o.y - b.y * scale)) 0 else 1 },
                            onDrag = { ch, _ -> ch.consume(); val p = Offset(ch.position.x / scale, ch.position.y / scale); if (which == 0) a = p else b = p },
                        )
                    },
            ) {
                drawImage(img, dstSize = IntSize(size.width.roundToInt(), size.height.roundToInt()))
                drawLine(Palette.manual, a * scale, b * scale, 4f)
                drawCircle(Palette.manual, 12f, a * scale); drawCircle(Palette.manual, 12f, b * scale)
            }
        }
        KeyValue("Measured (no correction)", "${"%.2f".format(measured)} cm")
        OutlinedTextField(truth, { truth = it }, Modifier.fillMaxWidth(), label = { Text("True length, cm") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
        val t = truth.replace(',', '.').toDoubleOrNull()
        if (t != null && t > 0) {
            val err = (measured - t) / t * 100
            KeyValue("Error", "${"%+.2f".format(measured - t)} cm (${"%+.2f".format(err)}%)", if (kotlin.math.abs(err) < 1) Palette.accent else Palette.warn)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Secondary("Add to repeat test", Modifier.weight(1f)) { readings.add(measured) }
                Primary("Use as correction", Modifier.weight(1f)) {
                    val k = (t / measured).toFloat()
                    if (k !in 0.9f..1.1f) msg = "That is more than 10% off — check the ends and the true length first."
                    else { app.prefs.calibration = k; app.prefs.calibratedAt = System.currentTimeMillis(); msg = "Saved: every scan is now corrected ×${"%.4f".format(k)}." }
                }
            }
        }
        if (readings.isNotEmpty()) {
            val spread = readings.max() - readings.min()
            Muted("Repeat test (${readings.size}): ${readings.joinToString { "%.2f".format(it) }} cm — spread ${"%.2f".format(spread)} cm ${if (spread <= 0.5) "✓ within 0.5 cm" else "(the plan's pass mark is 0.5 cm)"}")
        }
        msg?.let { Notice(it, Palette.accent) }
        Secondary("Capture again (move the phone between shots)") { onAgain() }
    }
}

private operator fun Offset.times(k: Float) = Offset(x * k, y * k)
