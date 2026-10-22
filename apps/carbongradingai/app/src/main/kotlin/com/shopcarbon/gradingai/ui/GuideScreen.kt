package com.shopcarbon.gradingai.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.shopcarbon.gradingai.App
import com.shopcarbon.gradingai.model.Profile

private val GUIDE_COLORS = listOf(
    Color(0xFFE6194B), Color(0xFF3CB44B), Color(0xFF4363D8), Color(0xFFF58231), Color(0xFF911EB4), Color(0xFF00A6A6),
    Color(0xFFF032E6), Color(0xFF9A6324), Color(0xFF469990), Color(0xFF800000), Color(0xFF000075), Color(0xFF808000),
)

/** The measuring guide: how to lay each garment type, and where every point sits. Served by the WMS. */
@Composable
fun GuideScreen(nav: Nav, profileId: String?) {
    val app = App.get(LocalContext.current)
    val profiles = app.config?.profiles.orEmpty()
    val p = profiles.firstOrNull { it.id == profileId }
    if (p == null) {
        Page("Guide", tabs = { BottomTabs(Tab.Guide) { onTab(nav, it) } }) {
            Muted("How to lay each garment. Flat measurements: straight across the garment lying smooth, never doubled; buttons and zips closed, nothing stretched.")
            if (profiles.isEmpty()) Notice("The guide comes from CarbonWMS — connect once to load it.")
            for (pair in profiles.chunked(2)) Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                for (x in pair) Card(Modifier.weight(1f).clickable { nav.go(Screen.Guide(x.id)) }, padding = 12.dp) {
                    NetImage(x.guide?.image, Modifier.fillMaxWidth().aspectRatio(1f), maxPx = 400, background = Color.White)
                    Text(x.label, style = MaterialTheme.typography.titleMedium, color = Palette.text)
                    Muted("${x.points.size} points")
                }
                if (pair.size == 1) Box(Modifier.weight(1f))
            }
        }
        return
    }
    Page(p.label, onBack = { nav.back() }, largeTitle = false) {
        Card(padding = 10.dp) { GuidePicture(p) }
        Notice("Lay it like this: ${p.lay}", Palette.accent)
        p.points.forEachIndexed { i, pt ->
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(pt.letter + (pt.side ?: ""), style = MaterialTheme.typography.titleMedium, color = GUIDE_COLORS[i % GUIDE_COLORS.size], fontWeight = FontWeight.Bold, modifier = Modifier.width(34.dp))
                androidx.compose.foundation.layout.Column(Modifier.weight(1f)) {
                    Text(pt.label + if (pt.hard) "  · AI assist" else "", style = MaterialTheme.typography.bodyMedium, color = Palette.text, fontWeight = FontWeight.Medium)
                    Muted(pt.rule)
                }
            }
        }
        p.guide?.examples?.takeIf { it.isNotEmpty() }?.let { ex ->
            Label("Measured the same way")
            for (e in ex) {
                NetImage(e.image, Modifier.fillMaxWidth().aspectRatio(1f), maxPx = 900)
                Muted(e.label)
            }
        }
    }
}

@Composable
fun GuidePicture(p: Profile) {
    val g = p.guide
    Box(Modifier.fillMaxWidth().aspectRatio(1f)) {
        NetImage(g?.image, Modifier.fillMaxSize(), maxPx = 1100)
        if (g != null) Canvas(Modifier.fillMaxSize()) {
            val paint = android.graphics.Paint().apply { textSize = 30f; isFakeBoldText = true; isAntiAlias = true; setShadowLayer(4f, 0f, 0f, android.graphics.Color.BLACK) }
            p.points.forEachIndexed { i, pt ->
                val l = g.lines[pt.key] ?: return@forEachIndexed
                if (l.size < 2) return@forEachIndexed
                val c = GUIDE_COLORS[i % GUIDE_COLORS.size]
                val a = Offset(l[0].first * size.width, l[0].second * size.height)
                val b = Offset(l[1].first * size.width, l[1].second * size.height)
                drawLine(Color.White, a, b, 7f, StrokeCap.Round)
                drawLine(c, a, b, 4f, StrokeCap.Round)
                drawCircle(c, 7f, a); drawCircle(c, 7f, b)
                paint.color = android.graphics.Color.argb(255, (c.red * 255).toInt(), (c.green * 255).toInt(), (c.blue * 255).toInt())
                drawContext.canvas.nativeCanvas.drawText(pt.letter + (pt.side ?: ""), (a.x + b.x) / 2 + 6, (a.y + b.y) / 2 - 8, paint)
            }
        }
    }
}
