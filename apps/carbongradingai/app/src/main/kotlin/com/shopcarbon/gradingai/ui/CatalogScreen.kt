package com.shopcarbon.gradingai.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.shopcarbon.gradingai.App
import com.shopcarbon.gradingai.model.CatalogRow
import com.shopcarbon.gradingai.model.Lookup
import com.shopcarbon.gradingai.model.SizeStatus
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private val FILTERS = listOf("all" to "All", "unmeasured" to "Not measured", "jeans" to "Jeans", "tshirts" to "T-shirts", "shorts" to "Shorts")

/** Remembered while the app is open, so Back from a product finds the same list. */
private var lastQuery = ""
private var lastFilter = "all"

/**
 * Catalog (owner, 2026-10-22: "add catalog from CarbonWMS"; "search name, UPC,
 * custom SKU etc. like in CarbonWMS"). Every live product, its sizes as dots —
 * blue measured, hollow not yet.
 */
@Composable
fun CatalogScreen(nav: Nav) {
    val app = App.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    var q by remember { mutableStateOf(lastQuery) }
    var filter by remember { mutableStateOf(lastFilter) }
    var rows by remember { mutableStateOf<List<CatalogRow>?>(null) }
    var err by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(q, filter) {
        lastQuery = q; lastFilter = filter
        delay(if (q.isBlank()) 0 else 300)
        runCatching { rows = app.api.catalog(q.trim(), filter); err = null }.onFailure { err = it.message }
    }
    val scan = rememberTagScanner({ err = it }) { code -> openCode(nav, app, scope, code, { busy = it }) { err = it } }

    Page("Catalog", tabs = { BottomTabs(Tab.Catalog) { onTab(nav, it) } }) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(
                Modifier.fillMaxWidth().height(48.dp).background(Palette.surface, RoundedCornerShape(14.dp)).padding(start = 12.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(Icons.Filled.Search, null, tint = Palette.muted, modifier = Modifier.size(22.dp))
                Box(Modifier.weight(1f)) {
                    if (q.isEmpty()) Text("Search", style = MaterialTheme.typography.bodyLarge, color = Palette.muted)
                    BasicTextField(
                        q, { q = it }, singleLine = true, textStyle = MaterialTheme.typography.bodyLarge.copy(color = Palette.text),
                        cursorBrush = SolidColor(Palette.accent), modifier = Modifier.fillMaxWidth(),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search), keyboardActions = KeyboardActions(onSearch = {}),
                    )
                }
                IconButton(onClick = { scan() }) { Icon(Icons.Filled.QrCodeScanner, "Scan a tag", tint = Palette.accent) }
            }
            Muted("Name, UPC, custom SKU, vendor or colour")
        }
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for ((id, label) in FILTERS) Pill(label, filled = filter == id) { filter = id }
        }
        busy?.let { Muted(it) }
        err?.let { Notice(it, Palette.bad) }
        val list = rows
        when {
            list == null -> Muted("Loading…")
            list.isEmpty() -> Muted(if (q.isBlank()) "Nothing here." else "Nothing matches \"$q\".")
            else -> Group {
                list.forEachIndexed { i, r ->
                    ListRow(
                        r.name,
                        subtitle = listOfNotNull(r.upc?.let { "UPC $it" }, "${r.colours} colour${if (r.colours == 1) "" else "s"}").joinToString(" · "),
                        divider = i > 0,
                        leading = { NetImage(r.image, Modifier.size(52.dp), crop = true, maxPx = 240, corner = 10.dp) },
                        trailing = {
                            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) { r.sizes.take(10).forEach { (_, m) -> Dot(Palette.accent, hollow = !m, size = 8.dp) } }
                                Text("${r.measured} of ${r.sizes.size}", style = MaterialTheme.typography.labelSmall, color = Palette.muted)
                            }
                        },
                        onClick = { openProduct(nav, app, scope, r.matrixId) { err = it } },
                    )
                }
            }
        }
    }
}

fun openProduct(nav: Nav, app: App, scope: kotlinx.coroutines.CoroutineScope, matrixId: String, onError: (String) -> Unit) {
    scope.launch { try { nav.go(Screen.Product(app.api.lookupMatrix(matrixId))) } catch (e: Exception) { onError(e.message ?: "Could not open") } }
}

/** One product: every size with how it stands, every colour with its photo. Measure opens the item for that size. */
@Composable
fun ProductScreen(nav: Nav, item: Lookup) {
    val app = App.get(LocalContext.current)
    var tab by remember { mutableStateOf("sizes") }
    val profile = app.config?.profile(item.profileId)
    Page(item.name, onBack = { nav.back() }, largeTitle = false) {
        NetImage(item.image, Modifier.fillMaxWidth().aspectRatio(1.25f), maxPx = 900, corner = 20.dp, background = Color.White)
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(item.name, style = MaterialTheme.typography.headlineSmall, color = Palette.text)
            val nc = item.colours().size
            Muted(listOfNotNull(item.upc?.let { "UPC $it" }, profile?.label, "$nc colour${if (nc == 1) "" else "s"}").joinToString(" · "))
        }
        Row(Modifier.fillMaxWidth().background(Palette.raised, RoundedCornerShape(10.dp)).padding(3.dp)) {
            for ((id, label) in listOf("sizes" to "Sizes", "colours" to "Colours")) {
                Text(
                    label, style = MaterialTheme.typography.labelMedium, color = Palette.text, fontWeight = if (tab == id) FontWeight.SemiBold else FontWeight.Normal,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                    modifier = Modifier.weight(1f).background(if (tab == id) Palette.surface else Color.Transparent, RoundedCornerShape(8.dp)).clickable { tab = id }.padding(vertical = 8.dp),
                )
            }
        }
        if (tab == "sizes") {
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = 16.dp)) {
                for ((c, hollow, t) in listOf(Triple(Palette.ok, false, "Scanned"), Triple(Palette.accent, false, "Size guide"), Triple(Palette.muted, true, "Not measured"))) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) { Dot(c, hollow = hollow, size = 8.dp); Muted(t) }
                }
            }
            Group {
                item.sizeLabels().forEachIndexed { i, s ->
                    val st = item.statusOf(s)
                    val last = item.skusOfSize(s).mapNotNull { it.lastMeasuredAt }.maxOrNull()
                    ListRow(
                        s,
                        divider = i > 0,
                        trailing = {
                            Text(
                                when (st) { SizeStatus.Scanned -> "Scanned ${ago(last)}"; SizeStatus.Guide -> "Size guide"; SizeStatus.NotMeasured -> "Not measured" },
                                style = MaterialTheme.typography.bodySmall, color = if (st == SizeStatus.Guide) Palette.accent else Palette.muted,
                            )
                            Dot(if (st == SizeStatus.Scanned) Palette.ok else Palette.accent, hollow = st == SizeStatus.NotMeasured)
                            Text(
                                "Measure", style = MaterialTheme.typography.labelMedium, color = Color.White,
                                modifier = Modifier.background(Palette.accent, RoundedCornerShape(50)).clickable { nav.go(Screen.Item(item, s)) }.padding(horizontal = 12.dp, vertical = 6.dp),
                            )
                        },
                    )
                }
            }
        } else {
            Group {
                item.colours().forEachIndexed { i, c ->
                    val skus = item.sizes.filter { it.color?.trim() == c }
                    ListRow(
                        c, subtitle = skus.mapNotNull { it.size }.distinct().joinToString(" · "), divider = i > 0,
                        leading = { NetImage(skus.firstNotNullOfOrNull { it.image } ?: item.image, Modifier.size(52.dp), crop = true, maxPx = 240, corner = 10.dp) },
                    )
                }
            }
        }
        item.cutGroup?.let { Muted("Cut group: ${it.name} · ${it.products} products — one reading covers them all.") }
    }
}
