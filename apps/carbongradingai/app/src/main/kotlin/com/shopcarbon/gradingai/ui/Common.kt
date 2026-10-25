package com.shopcarbon.gradingai.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Campaign
import androidx.compose.material.icons.filled.GridView
import androidx.compose.material.icons.filled.Straighten
import androidx.compose.material.icons.filled.Home
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.shopcarbon.gradingai.App
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request

/* ───────────────────────── frame ───────────────────────── */

/**
 * Screen frame, iOS style: glass circle buttons in the top corners, a large
 * title, scrolling content on the system grey ground. `bottom` is a docked bar
 * (Save, Undo…); `tabs` floats the glass tab bar over the content. All text is
 * selectable (owner rule).
 */
@Composable
fun Page(
    title: String,
    onBack: (() -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
    bottom: (@Composable () -> Unit)? = null,
    tabs: (@Composable () -> Unit)? = null,
    scroll: Boolean = true,
    /** Small grey line above the title (e.g. "CARBON"). */
    eyebrow: String? = null,
    /** false: the title sits small and centred in the top bar (detail screens). */
    largeTitle: Boolean = true,
    /** Replaces the large title (Home: the Carbon mark + "CarbonTools"). */
    header: (@Composable () -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(Modifier.fillMaxSize().background(Palette.ground)) {
        Row(
            Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 12.dp, vertical = 6.dp).height(48.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (onBack != null) GlassCircle(Icons.AutoMirrored.Filled.ArrowBack, "Back", onBack) else Spacer(Modifier.width(4.dp))
            Box(Modifier.weight(1f).padding(horizontal = if (header != null) 0.dp else 8.dp), contentAlignment = if (header != null) Alignment.CenterStart else Alignment.Center) {
                if (header != null) header()
                else if (!largeTitle) Text(title, style = MaterialTheme.typography.titleMedium, color = Palette.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically, content = actions)
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            SelectionContainer {
                Column(
                    (if (scroll) Modifier.verticalScroll(rememberScrollState()) else Modifier).fillMaxWidth()
                        .padding(start = 16.dp, end = 16.dp, top = 2.dp, bottom = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    if (largeTitle && header == null) Column {
                        eyebrow?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = Palette.muted) }
                        Text(title, style = MaterialTheme.typography.headlineLarge, color = Palette.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                    content()
                }
            }
        }
        /* The bottom row is frozen (owner, 2026-10-22): docked on the ground, nothing scrolls behind it. */
        if (tabs != null) Box(Modifier.fillMaxWidth().background(Palette.ground).navigationBarsPadding().padding(horizontal = 16.dp, vertical = 8.dp)) { tabs() }
        bottom?.let {
            Column(Modifier.fillMaxWidth().background(Palette.surface)) {
                HorizontalDivider(color = Palette.line)
                Box(Modifier.navigationBarsPadding().padding(horizontal = 16.dp, vertical = 10.dp)) { it() }
            }
        }
    }
}

/** The Carbon mark and "CarbonTools" in the logo's typeface (Home). */
@Composable
fun BrandTitle() {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Image(androidx.compose.ui.res.painterResource(com.shopcarbon.gradingai.R.drawable.carbon_mark), "Carbon", Modifier.size(38.dp))
        Text("CarbonTools", fontFamily = Brand, fontSize = 30.sp, color = Palette.text, maxLines = 1)
    }
}

/** Liquid-glass circle button for the top corners. */
@Composable
fun GlassCircle(icon: ImageVector, label: String, onClick: () -> Unit, tint: Color = Palette.text, dark: Boolean = false) {
    Box(
        Modifier.size(42.dp).shadow(6.dp, CircleShape, ambientColor = Color.Black.copy(alpha = 0.08f), spotColor = Color.Black.copy(alpha = 0.12f))
            .background(if (dark) Palette.glassDark else Color.White.copy(alpha = 0.92f), CircleShape)
            .border(1.dp, Color.White.copy(alpha = if (dark) 0.25f else 0.9f), CircleShape)
            .clip(CircleShape).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, label, tint = if (dark) Color.White else tint, modifier = Modifier.size(22.dp)) }
}

/* ───────────────────────── tab bar ───────────────────────── */

enum class Tab(val label: String, val icon: ImageVector) {
    Home("GradingAI", Icons.Filled.Straighten),
    Catalog("Catalog", Icons.Filled.GridView),
    Studio("Bulk Studio", Icons.Filled.AutoAwesome),
    Social("Social", Icons.Filled.Campaign),
}

/** The floating Liquid Glass tab bar: four tabs, the chosen one in blue. */
@Composable
fun BottomTabs(selected: Tab?, onPick: (Tab) -> Unit) {
    Row(
        Modifier.fillMaxWidth().shadow(14.dp, RoundedCornerShape(32.dp), ambientColor = Color.Black.copy(alpha = 0.1f), spotColor = Color.Black.copy(alpha = 0.16f))
            .background(Color.White.copy(alpha = 0.94f), RoundedCornerShape(32.dp))
            .border(1.dp, Color.White, RoundedCornerShape(32.dp)).padding(6.dp),
        horizontalArrangement = Arrangement.SpaceEvenly,
    ) {
        for (t in Tab.entries) {
            val on = t == selected
            Column(
                Modifier.weight(1f).clip(RoundedCornerShape(26.dp)).background(if (on) Palette.accentSoft else Color.Transparent)
                    .clickable { onPick(t) }.padding(vertical = 7.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Icon(t.icon, t.label, tint = if (on) Palette.accent else Palette.muted, modifier = Modifier.size(24.dp))
                Text(t.label, style = MaterialTheme.typography.labelSmall, color = if (on) Palette.accent else Palette.muted)
            }
        }
    }
}

/* ───────────────────────── blocks ───────────────────────── */

@Composable
fun Card(modifier: Modifier = Modifier, padding: Dp = 16.dp, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier.fillMaxWidth().shadow(1.dp, RoundedCornerShape(18.dp), ambientColor = Color.Black.copy(alpha = 0.04f), spotColor = Color.Black.copy(alpha = 0.06f))
            .background(Palette.surface, RoundedCornerShape(18.dp)).clip(RoundedCornerShape(18.dp)).padding(padding),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        content = content,
    )
}

/** iOS inset grouped list: rows with hairline dividers. */
@Composable
fun Group(modifier: Modifier = Modifier, header: String? = null, footer: String? = null, rows: @Composable ColumnScope.() -> Unit) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        header?.let { Text(it.uppercase(), style = MaterialTheme.typography.labelSmall, color = Palette.muted, modifier = Modifier.padding(start = 16.dp)) }
        Column(Modifier.fillMaxWidth().background(Palette.surface, RoundedCornerShape(16.dp)).clip(RoundedCornerShape(16.dp)), content = rows)
        footer?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Palette.muted, modifier = Modifier.padding(horizontal = 16.dp)) }
    }
}

/** One row of a [Group]. `divider` draws the hairline above it (all rows but the first). */
@Composable
fun ListRow(
    title: String,
    subtitle: String? = null,
    divider: Boolean = false,
    titleColor: Color = Palette.text,
    leading: (@Composable () -> Unit)? = null,
    trailing: (@Composable RowScope.() -> Unit)? = null,
    chevron: Boolean = false,
    onClick: (() -> Unit)? = null,
) {
    Column {
        if (divider) HorizontalDivider(color = Palette.line, modifier = Modifier.padding(start = if (leading != null) 72.dp else 16.dp))
        Row(
            Modifier.fillMaxWidth().then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier).padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            leading?.invoke()
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.bodyLarge, color = titleColor, maxLines = 2, overflow = TextOverflow.Ellipsis)
                subtitle?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Palette.muted, maxLines = 2, overflow = TextOverflow.Ellipsis) }
            }
            trailing?.invoke(this)
            if (chevron) Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = Palette.muted.copy(alpha = 0.7f))
        }
    }
}

@Composable
fun Label(text: String) = Text(text.uppercase(), style = MaterialTheme.typography.labelSmall, color = Palette.muted)

/** Section heading inside a page ("Measure next"). */
@Composable
fun Section(text: String) = Text(text, style = MaterialTheme.typography.titleLarge, color = Palette.text)

@Composable
fun Muted(text: String) = Text(text, style = MaterialTheme.typography.bodySmall, color = Palette.muted)

/** A chip: grey outline, or filled blue when chosen. */
@Composable
fun Pill(text: String, color: Color = Palette.muted, filled: Boolean = false, onClick: (() -> Unit)? = null) {
    Text(
        text,
        style = MaterialTheme.typography.labelMedium,
        color = if (filled) Color.White else if (color == Palette.muted) Palette.text else color,
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(if (filled) (if (color == Palette.muted) Palette.accent else color) else Palette.surface, RoundedCornerShape(50))
            .border(1.dp, if (filled) Color.Transparent else Palette.line, RoundedCornerShape(50))
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 14.dp, vertical = 8.dp),
    )
}

/** A small status chip ("AI", "Edited", "+0.4"). */
@Composable
fun Badge(text: String, color: Color, solid: Boolean = false) = Text(
    text,
    style = MaterialTheme.typography.labelSmall,
    color = if (solid) Color.White else color,
    fontWeight = FontWeight.SemiBold,
    modifier = Modifier.background(if (solid) color else color.copy(alpha = 0.14f), RoundedCornerShape(8.dp)).padding(horizontal = 8.dp, vertical = 3.dp),
)

@Composable
fun Dot(color: Color, hollow: Boolean = false, size: Dp = 10.dp) = Box(
    Modifier.size(size).then(if (hollow) Modifier.border(1.5.dp, Palette.muted.copy(alpha = 0.6f), CircleShape) else Modifier.background(color, CircleShape)),
)

@Composable
fun Primary(text: String, modifier: Modifier = Modifier.fillMaxWidth(), enabled: Boolean = true, caption: String? = null, onClick: () -> Unit) =
    Button(
        onClick, modifier.height(if (caption != null) 60.dp else 52.dp), enabled = enabled, shape = RoundedCornerShape(50),
        colors = ButtonDefaults.buttonColors(containerColor = Palette.accent, contentColor = Color.White, disabledContainerColor = Palette.accent.copy(alpha = 0.35f), disabledContentColor = Color.White),
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(text, style = MaterialTheme.typography.labelLarge)
            caption?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = Color.White.copy(alpha = 0.85f), maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
    }

@Composable
fun Secondary(text: String, modifier: Modifier = Modifier.fillMaxWidth(), enabled: Boolean = true, onClick: () -> Unit) =
    Button(
        onClick, modifier.height(48.dp), enabled = enabled, shape = RoundedCornerShape(50),
        colors = ButtonDefaults.buttonColors(containerColor = Palette.raised, contentColor = Palette.text, disabledContainerColor = Palette.raised.copy(alpha = 0.6f), disabledContentColor = Palette.muted),
    ) { Text(text, style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.Medium)) }

/** Square tinted button with an icon above its label (the 2×2 grid after saving). */
@Composable
fun Tile(icon: ImageVector, label: String, modifier: Modifier = Modifier, enabled: Boolean = true, onClick: () -> Unit) {
    Column(
        modifier.height(92.dp).clip(RoundedCornerShape(18.dp)).background(Palette.surface).border(1.dp, Palette.line, RoundedCornerShape(18.dp))
            .clickable(enabled = enabled, onClick = onClick).padding(10.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
    ) {
        Icon(icon, null, tint = if (enabled) Palette.text else Palette.muted, modifier = Modifier.size(30.dp))
        Spacer(Modifier.height(6.dp))
        Text(label, style = MaterialTheme.typography.bodyMedium, color = if (enabled) Palette.text else Palette.muted)
    }
}

@Composable
fun KeyValue(k: String, v: String, color: Color = Palette.text) = Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
    Text(k, style = MaterialTheme.typography.bodyMedium, color = Palette.muted)
    Text(v, style = MaterialTheme.typography.bodyMedium, color = color, fontWeight = FontWeight.Medium)
}

@Composable
fun Notice(text: String, color: Color = Palette.warn) = Text(
    text, style = MaterialTheme.typography.bodyMedium, color = if (color == Palette.muted) Palette.text else color,
    modifier = Modifier.fillMaxWidth().background(color.copy(alpha = 0.12f), RoundedCornerShape(14.dp)).padding(14.dp),
)

/** Activity-ring style progress (0–1). */
@Composable
fun ProgressRing(progress: Float, modifier: Modifier, stroke: Dp = 14.dp, center: @Composable BoxScope.() -> Unit = {}) {
    Box(modifier, contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val w = stroke.toPx()
            val d = size.minDimension - w
            val tl = Offset((size.width - d) / 2, (size.height - d) / 2)
            drawArc(Palette.accentSoft, 0f, 360f, false, tl, Size(d, d), style = Stroke(w))
            drawArc(Palette.accent, -90f, 360f * progress.coerceIn(0f, 1f), false, tl, Size(d, d), style = Stroke(w, cap = StrokeCap.Round))
        }
        center()
    }
}

/* ───────── images from CarbonWMS (product photos, guide pictures, scan photos) ───────── */

private val imageCache = LruCache<String, Bitmap>(60)
private val imageHttp = OkHttpClient()

@Composable
fun NetImage(
    url: String?, modifier: Modifier, crop: Boolean = false, maxPx: Int = 1400, corner: Dp = 12.dp, background: Color = Palette.raised,
    /** The frame takes the picture's own shape once it loads (no bars at the sides); this ratio until then. */
    fitAspect: Float? = null,
) {
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
    val b = bmp
    val shaped = if (fitAspect != null) modifier.aspectRatio(b?.let { it.width.toFloat() / it.height } ?: fitAspect) else modifier
    Box(shaped.clip(RoundedCornerShape(corner)).background(background), contentAlignment = Alignment.Center) {
        if (b != null) Image(b.asImageBitmap(), null, Modifier.fillMaxSize(), contentScale = if (crop || fitAspect != null) ContentScale.Crop else ContentScale.Fit)
    }
}

/** Downloads an image from CarbonWMS into a file (a saved scan's photo, to edit it). */
suspend fun downloadToFile(app: App, url: String, to: java.io.File): java.io.File = withContext(Dispatchers.IO) {
    val full = if (url.startsWith("http")) url else app.prefs.origin + url
    val rb = Request.Builder().url(full)
    app.vault.token()?.let { rb.header("Authorization", "Bearer $it") }
    imageHttp.newCall(rb.build()).execute().use { r ->
        if (!r.isSuccessful) throw IllegalStateException("The photo could not be loaded (${r.code})")
        to.parentFile?.mkdirs()
        to.outputStream().use { out -> r.body!!.byteStream().copyTo(out) }
    }
    to
}
