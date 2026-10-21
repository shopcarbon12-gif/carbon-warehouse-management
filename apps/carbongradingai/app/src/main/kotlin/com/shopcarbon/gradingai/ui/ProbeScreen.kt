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
import com.shopcarbon.gradingai.measure.appVersion
import org.json.JSONArray
import org.json.JSONObject
import android.graphics.Bitmap
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.launch
import kotlin.math.hypot
import kotlin.math.roundToInt

/**
 * Depth sensor and accuracy check. Live: is it the time-of-flight sensor, the
 * distance to the table, its tilt and how flat the reading is. Then capture a
 * flat, rigid object of known size (the printed 18×24 cm target, a board, a
 * tile) and compare width, height and diagonal — diagnostic only.
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
    if (f != null) { CheckAccuracy(nav, f, readings, onAgain = { flat = null }); return }

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
            Text("Lay a flat, rigid object of known size (the printed 18×24 cm target, a board, a tile) on the table, hold the phone level above it as for a scan, and capture.", color = Palette.muted, style = MaterialTheme.typography.bodySmall)
            problem?.let { Text(it, color = Palette.bad) }
        }
        Column(Modifier.align(androidx.compose.ui.Alignment.BottomCenter).padding(24.dp)) {
            Primary(if (busy) "Squaring up…" else "Capture", enabled = !busy && live?.plane != null) { camera.requestCapture() }
            Secondary("Close") { nav.back() }
        }
    }
}

/** Width, height and diagonal of the four corners (TL, TR, BR, BL), in cm: each the mean of its two opposite sides. */
internal fun quadSizes(c: List<Offset>, pxPerCm: Double): Triple<Double, Double, Double> {
    fun d(i: Int, j: Int) = hypot((c[j].x - c[i].x).toDouble(), (c[j].y - c[i].y).toDouble()) / pxPerCm
    return Triple((d(0, 1) + d(3, 2)) / 2, (d(0, 3) + d(1, 2)) / 2, (d(0, 2) + d(1, 3)) / 2)
}

/**
 * Accuracy check — diagnostic only. Drag the four corners onto a flat, rigid
 * object of known size; width, height and diagonal are compared with the
 * truth and the result is saved to the WMS so a drift shows over time. The
 * scale is never corrected from a check (one reading is not enough to trust).
 */
@Composable
private fun CheckAccuracy(nav: Nav, f: Flat, readings: MutableList<Double>, onAgain: () -> Unit) {
    val ctx = LocalContext.current
    val app = App.get(ctx)
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current
    val corners = remember(f) {
        val w = f.photo.width; val h = f.photo.height
        mutableStateListOf(Offset(w * 0.3f, h * 0.3f), Offset(w * 0.7f, h * 0.3f), Offset(w * 0.7f, h * 0.7f), Offset(w * 0.3f, h * 0.7f))
    }
    var trueW by remember { mutableStateOf(app.prefs.checkW) }
    var trueH by remember { mutableStateOf(app.prefs.checkH) }
    var msg by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    var saved by remember(f) { mutableStateOf(false) }
    val img = remember(f) { f.photo.asImageBitmap() }
    val (mw, mh, md) = quadSizes(corners, f.pxPerCm)
    Page("Check accuracy", onBack = { nav.back() }) {
        Muted("Drag the four corners onto the object's corners (or save now and set them on the WMS). Squared up at ${"%.2f".format(f.pxPerCm)} px/cm from ${f.depthPoints} depth points, ${(f.plane.axisDistanceM * 100).roundToInt()} cm away, tilt ${"%.1f".format(f.plane.tiltDeg)}°, depth ${"%.0f".format(f.depthAgeMs)} ms old.")
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val scale = with(density) { maxWidth.toPx() } / f.photo.width
            Canvas(
                Modifier.fillMaxWidth().height(with(density) { (f.photo.height * scale).toDp() })
                    .pointerInput(f) {
                        var which = 0
                        detectDragGestures(
                            onDragStart = { o -> which = corners.indices.minBy { hypot(o.x - corners[it].x * scale, o.y - corners[it].y * scale) } },
                            onDrag = { ch, _ -> ch.consume(); corners[which] = Offset(ch.position.x / scale, ch.position.y / scale) },
                        )
                    },
            ) {
                drawImage(img, dstSize = IntSize(size.width.roundToInt(), size.height.roundToInt()))
                for (i in 0 until 4) drawLine(Palette.manual, corners[i] * scale, corners[(i + 1) % 4] * scale, 4f)
                drawLine(Palette.manual.copy(alpha = 0.5f), corners[0] * scale, corners[2] * scale, 2f)
                drawLine(Palette.manual.copy(alpha = 0.5f), corners[1] * scale, corners[3] * scale, 2f)
                corners.forEach { drawCircle(Palette.manual, 14f, it * scale) }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(trueW, { trueW = it; saved = false }, Modifier.weight(1f), label = { Text("True width, cm") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
            OutlinedTextField(trueH, { trueH = it; saved = false }, Modifier.weight(1f), label = { Text("True height, cm") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
        }
        val tw = trueW.replace(',', '.').toDoubleOrNull()?.takeIf { it > 0 }
        val th = trueH.replace(',', '.').toDoubleOrNull()?.takeIf { it > 0 }
        @Composable fun row(name: String, m: Double, t: Double?) {
            if (t == null) { KeyValue(name, "${"%.2f".format(m)} cm"); return }
            val err = (m - t) / t * 100
            KeyValue(name, "${"%.2f".format(m)} / ${"%.2f".format(t)} cm  (${"%+.2f".format(m - t)} cm, ${"%+.2f".format(err)}%)",
                if (kotlin.math.abs(err) < 1) Palette.accent else Palette.warn)
        }
        row("Width", mw, tw)
        row("Height", mh, th)
        row("Diagonal", md, if (tw != null && th != null) hypot(tw, th) else null)
        if (tw != null && th != null) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Secondary("Add to repeat test", Modifier.weight(1f)) { readings.add(md) }
                Primary(if (saving) "Saving…" else if (saved) "Saved ✓" else "Save check", Modifier.weight(1f), enabled = !saving && !saved) {
                    saving = true; msg = null
                    app.prefs.checkW = trueW; app.prefs.checkH = trueH
                    val body = JSONObject().put("trueW", tw).put("trueH", th).put("measuredW", mw).put("measuredH", mh).put("measuredDiag", md)
                        .put("depth", f.depthJson(ctx)).put("appVersion", appVersion(ctx)).put("deviceModel", android.os.Build.MODEL ?: "")
                        // The photo and corners go too, so the corners can be checked and moved on the desktop.
                        .put("corners", JSONArray().apply { corners.forEach { put(JSONArray().put(it.x.toDouble()).put(it.y.toDouble())) } })
                        .put("pxPerCm", f.pxPerCm).put("photoW", f.photo.width).put("photoH", f.photo.height)
                    scope.launch {
                        try {
                            val file = withContext(Dispatchers.IO) {
                                File(ctx.cacheDir, "check.jpg").also { out -> out.outputStream().use { f.photo.compress(Bitmap.CompressFormat.JPEG, 90, it) } }
                            }
                            app.api.saveAccuracyCheck(body, file); saved = true
                            msg = "Saved to the WMS (Size Grading › Scan review › Accuracy checks) — the corners can be moved there."
                        }
                        catch (e: Exception) { msg = "Not saved: ${e.message}" }
                        finally { saving = false }
                    }
                }
            }
        }
        if (readings.isNotEmpty()) {
            val spread = readings.max() - readings.min()
            Muted("Repeat test, diagonal (${readings.size}): ${readings.joinToString { "%.2f".format(it) }} cm — spread ${"%.2f".format(spread)} cm ${if (spread <= 0.5) "✓ within 0.5 cm" else "(the pass mark is 0.5 cm)"}")
        }
        Muted("This is a check only — scans are never corrected from it.")
        if (app.prefs.calibration != 1f) {
            Notice("An older scale correction (×${"%.4f".format(app.prefs.calibration)}) is still applied to every scan.")
            Secondary("Clear the old correction") { app.prefs.calibration = 1f; app.prefs.calibratedAt = 0; msg = "Old correction cleared — scans use the depth sensor's scale only." }
        }
        msg?.let { Notice(it, if (it.startsWith("Not saved")) Palette.bad else Palette.accent) }
        Secondary("Capture again (move the phone between shots)") { onAgain() }
    }
}

private operator fun Offset.times(k: Float) = Offset(x * k, y * k)
