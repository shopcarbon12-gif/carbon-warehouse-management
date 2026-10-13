package com.shopcarbon.gradingai.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import com.shopcarbon.gradingai.App
import com.shopcarbon.gradingai.measure.MeasureSession
import com.shopcarbon.gradingai.model.SaveResult
import kotlinx.coroutines.launch

@Composable
fun SavedScreen(nav: Nav, s: MeasureSession, r: SaveResult?, offline: Boolean) {
    val app = App.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    var err by remember { mutableStateOf<String?>(null) }
    val item = s.target.lookup
    Page("Saved", onBack = { nav.home() }) {
        if (r == null) {
            Notice(if (offline) "Saved on the phone. It uploads to the WMS by itself when the phone is back online." else "Saved.", Palette.accent)
        } else {
            Card {
                Text("Saved to the WMS · ${item.name} · ${r.size ?: s.target.sizeLabel}", style = MaterialTheme.typography.titleMedium, color = Palette.accent)
                if (r.status == "flagged") Muted("Flagged for your check on the review screen.")
                if (r.total == 0 && s.scan.depth.tof.not()) Muted("Test mode: kept for review, not written to the item.")
            }
            Card {
                Label("Applied to")
                KeyValue("Same product, every colour", "${r.sameProduct} SKUs")
                r.cutGroupName?.let { KeyValue("Cut group $it", "${r.cutGroupProducts} products") }
                KeyValue("Total SKUs updated", "${r.total}")
                if (r.colors.isNotEmpty()) Muted(r.colors.distinct().joinToString())
            }
            if (r.sizeCheck.isNotEmpty()) Card {
                Label("Size check across the ${if (r.cutGroupName != null) "cut" else "product"}")
                for (c in r.sizeCheck.distinctBy { it.key + it.fromSize + it.toSize }.take(12)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("${c.label} ${c.fromSize} → ${c.toSize}", style = MaterialTheme.typography.bodyMedium, color = Palette.text, modifier = Modifier.weight(1f))
                        Text("${if (c.deltaCm > 0) "+" else ""}${c.deltaCm} cm  ${if (c.flag) "check" else "normal"}", style = MaterialTheme.typography.bodyMedium, color = if (c.flag) Palette.warn else Palette.accent)
                    }
                    c.note?.let { if (c.flag) Muted(it) }
                }
            }
            if (r.flags.isNotEmpty()) Card { Label("Flags"); r.flags.forEach { Text("• $it", style = MaterialTheme.typography.bodySmall, color = Palette.warn) } }
            Muted(if (r.dropbox == "queued") "Photo copied to Dropbox › ${app.config?.dropboxFolder ?: "CarbonGradingAI"}." else "Photo kept in the WMS.")
        }
        val studio = (app.config?.studioLink ?: "/inventory/catalog?matrix={matrixId}&mtab=studio").replace("{matrixId}", item.matrixId)
        val seo = (app.config?.seoLink ?: "/inventory/catalog?matrix={matrixId}&mtab=seo").replace("{matrixId}", item.matrixId)
        Secondary("Make product photos (Studio)") { nav.go(Screen.Web("Carbon Studio", studio)) }
        Secondary("Write description (SEO)") { nav.go(Screen.Web("SEO writer", seo)) }
        err?.let { Notice(it, Palette.bad) }
        Primary("Next in the queue") {
            scope.launch {
                try {
                    val q = app.api.queue()
                    val next = q.entries.firstOrNull { !(it.matrixId == item.matrixId && it.size.equals(s.target.sizeLabel, true)) }
                    if (next == null) { err = "Nothing left in the queue."; return@launch }
                    nav.home(); nav.go(Screen.Item(app.api.lookupMatrix(next.matrixId), next.size))
                } catch (e: Exception) { err = e.message }
            }
        }
        Secondary("Scan the next hang tag") { nav.home() }
    }
}
