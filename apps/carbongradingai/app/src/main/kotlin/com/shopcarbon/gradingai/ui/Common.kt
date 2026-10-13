package com.shopcarbon.gradingai.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.MenuBook
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.shopcarbon.gradingai.App
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request

/** Screen frame: title bar, scrolling content, optional bottom bar. All text is selectable (owner rule). */
@Composable
fun Page(
    title: String,
    onBack: (() -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
    bottom: (@Composable () -> Unit)? = null,
    scroll: Boolean = true,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(Modifier.fillMaxSize().background(Palette.ground)) {
        Row(
            Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 4.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (onBack != null) IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = Palette.text) }
            else Spacer(Modifier.width(12.dp))
            Text(title, style = MaterialTheme.typography.titleLarge, color = Palette.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            actions()
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            SelectionContainer {
                Column(
                    (if (scroll) Modifier.verticalScroll(rememberScrollState()) else Modifier).fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                    content = content,
                )
            }
        }
        bottom?.invoke()
    }
}

enum class Tab(val label: String, val icon: ImageVector) {
    Measure("Measure", Icons.Filled.CameraAlt),
    Queue("Queue", Icons.Filled.Checklist),
    Studio("Studio", Icons.Filled.AutoAwesome),
    Seo("SEO", Icons.Filled.Description),
    Guide("Guide", Icons.Filled.MenuBook),
}

@Composable
fun BottomTabs(selected: Tab?, onPick: (Tab) -> Unit) {
    Row(
        Modifier.fillMaxWidth().background(Palette.surface).navigationBarsPadding().padding(vertical = 6.dp),
        horizontalArrangement = Arrangement.SpaceEvenly,
    ) {
        for (t in Tab.entries) {
            val on = t == selected
            Column(
                Modifier.weight(1f).clickable { onPick(t) }.padding(vertical = 4.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Icon(t.icon, t.label, tint = if (on) Palette.accent else Palette.muted, modifier = Modifier.size(22.dp))
                Text(t.label, style = MaterialTheme.typography.labelMedium, color = if (on) Palette.accent else Palette.muted)
            }
        }
    }
}

@Composable
fun Card(modifier: Modifier = Modifier, padding: Dp = 14.dp, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier.fillMaxWidth().background(Palette.surface, RoundedCornerShape(14.dp)).border(1.dp, Palette.line, RoundedCornerShape(14.dp)).padding(padding),
        verticalArrangement = Arrangement.spacedBy(6.dp),
        content = content,
    )
}

@Composable
fun Label(text: String) = Text(text.uppercase(), style = MaterialTheme.typography.labelSmall, color = Palette.muted)

@Composable
fun Muted(text: String) = Text(text, style = MaterialTheme.typography.bodySmall, color = Palette.muted)

@Composable
fun Pill(text: String, color: Color = Palette.muted, filled: Boolean = false, onClick: (() -> Unit)? = null) {
    Text(
        text,
        style = MaterialTheme.typography.labelMedium,
        color = if (filled) Palette.ground else color,
        modifier = Modifier
            .background(if (filled) color else Color.Transparent, RoundedCornerShape(50))
            .border(1.dp, color, RoundedCornerShape(50))
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 12.dp, vertical = 6.dp),
    )
}

@Composable
fun Primary(text: String, modifier: Modifier = Modifier.fillMaxWidth(), enabled: Boolean = true, onClick: () -> Unit) =
    Button(onClick, modifier.height(52.dp), enabled = enabled, shape = RoundedCornerShape(12.dp), colors = ButtonDefaults.buttonColors(containerColor = Palette.accent, contentColor = Color(0xFF00281A))) {
        Text(text, style = MaterialTheme.typography.labelLarge)
    }

@Composable
fun Secondary(text: String, modifier: Modifier = Modifier.fillMaxWidth(), enabled: Boolean = true, onClick: () -> Unit) =
    OutlinedButton(onClick, modifier.height(48.dp), enabled = enabled, shape = RoundedCornerShape(12.dp)) {
        Text(text, style = MaterialTheme.typography.labelLarge, color = Palette.text)
    }

@Composable
fun KeyValue(k: String, v: String, color: Color = Palette.text) = Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
    Text(k, style = MaterialTheme.typography.bodyMedium, color = Palette.muted)
    Text(v, style = MaterialTheme.typography.bodyMedium, color = color, fontWeight = FontWeight.Medium)
}

@Composable
fun Notice(text: String, color: Color = Palette.warn) = Text(
    text, style = MaterialTheme.typography.bodyMedium, color = color,
    modifier = Modifier.fillMaxWidth().background(color.copy(alpha = 0.12f), RoundedCornerShape(10.dp)).padding(12.dp),
)

/* ───────── images from the WMS (product photos, guide pictures) ───────── */

private val imageCache = LruCache<String, Bitmap>(40)
private val imageHttp = OkHttpClient()

@Composable
fun NetImage(url: String?, modifier: Modifier, crop: Boolean = false, maxPx: Int = 1400) {
    val ctx = LocalContext.current
    var bmp by remember(url) { mutableStateOf(url?.let { imageCache.get(it) }) }
    LaunchedEffect(url) {
        if (url.isNullOrBlank() || bmp != null) return@LaunchedEffect
        val app = App.get(ctx)
        val full = if (url.startsWith("http")) url else app.prefs.origin + url
        bmp = withContext(Dispatchers.IO) {
            runCatching {
                val rb = Request.Builder().url(full)
                if (full.startsWith(app.prefs.origin)) app.vault.token()?.let { rb.header("Authorization", "Bearer $it") }
                imageHttp.newCall(rb.build()).execute().use { r ->
                    val bytes = r.body?.bytes() ?: return@use null
                    val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, o)
                    var s = 1
                    while (maxOf(o.outWidth, o.outHeight) / (s * 2) >= maxPx) s *= 2
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = s })
                }
            }.getOrNull()?.also { imageCache.put(url, it) }
        }
    }
    Box(modifier.background(Palette.raised, RoundedCornerShape(10.dp)), contentAlignment = Alignment.Center) {
        val b = bmp
        if (b != null) Image(b.asImageBitmap(), null, Modifier.fillMaxSize(), contentScale = if (crop) ContentScale.Crop else ContentScale.Fit)
    }
}
