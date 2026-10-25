package com.shopcarbon.gradingai.ui

import android.graphics.Bitmap
import android.net.Uri
import android.widget.MediaController
import android.widget.VideoView
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.shopcarbon.gradingai.App

/**
 * The full-screen picture viewer every CarbonTools tab shares (owner,
 * 2026-10-25: "pictures in mobile view size with zoom in popup windows"):
 * pinch or double-tap to zoom, drag to look around, swipe between pictures,
 * tap ✕ or Back to close. Videos (.mp4) play in it. Bulk Studio's web page
 * opens it through the WebView bridge (window.CarbonWMSPCNative.zoomImage).
 */
object Zoom {
    data class Request(val urls: List<String>, val at: Int)

    val open = mutableStateOf<Request?>(null)

    fun show(urls: List<String>, at: Int = 0) {
        if (urls.isNotEmpty()) open.value = Request(urls, at.coerceIn(0, urls.lastIndex))
    }

    fun isVideo(url: String) = Regex("""\.(mp4|mov|webm)(\?|$)""", RegexOption.IGNORE_CASE).containsMatchIn(url) || url.startsWith("data:video")
}

/** Placed once over the whole app (MainActivity). */
@Composable
fun ZoomHost() {
    val req = Zoom.open.value ?: return
    Dialog(
        onDismissRequest = { Zoom.open.value = null },
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        val pager = rememberPagerState(initialPage = req.at) { req.urls.size }
        var zoomed by remember { mutableStateOf(false) }
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            HorizontalPager(pager, Modifier.fillMaxSize(), userScrollEnabled = !zoomed, key = { it }) { i ->
                val url = req.urls[i]
                if (Zoom.isVideo(url)) ZoomVideo(url, active = pager.currentPage == i)
                else ZoomPicture(url) { zoomed = it }
            }
            Row(
                Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    if (req.urls.size > 1) "${pager.currentPage + 1} of ${req.urls.size}" else "",
                    style = MaterialTheme.typography.titleMedium, color = Color.White,
                )
                GlassCircle(Icons.Filled.Close, "Close", { Zoom.open.value = null }, tint = Color.White, dark = true)
            }
        }
    }
}

@Composable
private fun ZoomPicture(url: String, onZoomed: (Boolean) -> Unit) {
    val app = App.get(LocalContext.current)
    var bmp by remember(url) { mutableStateOf<Bitmap?>(null) }
    var failed by remember(url) { mutableStateOf(false) }
    LaunchedEffect(url) { bmp = loadNetBitmap(app, url, 2600); failed = bmp == null }
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    fun set(s: Float, o: Offset, w: Float, h: Float) {
        scale = s.coerceIn(1f, 6f)
        val mx = w * (scale - 1f) / 2f
        val my = h * (scale - 1f) / 2f
        offset = if (scale <= 1.01f) Offset.Zero else Offset(o.x.coerceIn(-mx, mx), o.y.coerceIn(-my, my))
        onZoomed(scale > 1.01f)
    }
    Box(
        Modifier.fillMaxSize()
            .pointerInput(url) {
                detectTapGestures(onDoubleTap = { p ->
                    if (scale > 1.01f) set(1f, Offset.Zero, size.width.toFloat(), size.height.toFloat())
                    else {
                        // Zoom in on the tapped spot.
                        val c = Offset(size.width / 2f, size.height / 2f)
                        set(2.5f, (c - p) * 1.5f, size.width.toFloat(), size.height.toFloat())
                    }
                })
            }
            .pointerInput(url) {
                // Two fingers zoom; one finger pans only while zoomed — otherwise the swipe belongs to the pager.
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    do {
                        val ev = awaitPointerEvent()
                        if (ev.changes.size > 1 || scale > 1.01f) {
                            set(scale * ev.calculateZoom(), offset + ev.calculatePan(), size.width.toFloat(), size.height.toFloat())
                            ev.changes.forEach { if (it.positionChanged()) it.consume() }
                        }
                    } while (ev.changes.any { it.pressed })
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        val b = bmp
        when {
            b != null -> Image(
                b.asImageBitmap(), "Picture",
                Modifier.fillMaxSize().graphicsLayer(scaleX = scale, scaleY = scale, translationX = offset.x, translationY = offset.y),
                contentScale = ContentScale.Fit,
            )
            failed -> Text("The picture could not be loaded.", color = Color.White)
            else -> CircularProgressIndicator(color = Color.White)
        }
    }
}

@Composable
private fun ZoomVideo(url: String, active: Boolean) {
    var view by remember { mutableStateOf<VideoView?>(null) }
    LaunchedEffect(active) { view?.let { if (active) it.start() else it.pause() } }
    AndroidView(
        { ctx ->
            // Centred at its own shape: a VideoView keeps its aspect but sits top-left without the frame.
            android.widget.FrameLayout(ctx).apply {
                val v = VideoView(ctx).apply {
                    val mc = MediaController(ctx)
                    mc.setAnchorView(this)
                    setMediaController(mc)
                    setVideoURI(Uri.parse(url))
                    setOnPreparedListener { mp -> mp.isLooping = true; if (active) start() }
                }
                addView(v, android.widget.FrameLayout.LayoutParams(-2, -2, android.view.Gravity.CENTER))
                view = v
            }
        },
        Modifier.fillMaxSize(),
        onRelease = { view?.stopPlayback() },
    )
}
