package com.shopcarbon.gradingai.ui

import androidx.compose.foundation.background
import com.shopcarbon.gradingai.model.WmsTag
import com.shopcarbon.gradingai.model.WmsSku
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
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
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.shopcarbon.gradingai.App
import com.shopcarbon.gradingai.model.WmsProduct
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private val STOCK = listOf("" to "All", "in" to "In stock", "out" to "Out of stock")

/** Remembered while the app is open, so Back from a product finds the same list. */
private var lastQuery = ""
private var lastStock = ""

/**
 * The Catalog tab (owner, 2026-10-24: "the same catalog as in CarbonWMS"):
 * Inventory › Catalog — live products in CarbonWMS's order, each with its
 * colours, sizes and live tags here. GradingAI's own measured-sizes search
 * sits under Scan tag on the GradingAI tab.
 */
@Composable
fun WmsCatalogScreen(nav: Nav) {
    val app = App.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    var q by remember { mutableStateOf(lastQuery) }
    var stock by remember { mutableStateOf(lastStock) }
    var products by remember { mutableStateOf<List<WmsProduct>?>(null) }
    var page by remember { mutableStateOf(1) }
    var loadedRows by remember { mutableStateOf(0) }
    var total by remember { mutableStateOf(0) }
    var loading by remember { mutableStateOf(false) }
    var err by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(q, stock) {
        lastQuery = q; lastStock = stock
        if (products != null) delay(350)
        loading = true; err = null
        runCatching { app.api.wmsCatalog(q.trim(), stock, 1) }
            .onSuccess { products = it.products; loadedRows = it.rows; total = it.total; page = 1 }
            .onFailure { err = it.message; if (products == null) products = emptyList() }
        loading = false
    }
    fun more() = scope.launch {
        loading = true
        runCatching { app.api.wmsCatalog(q.trim(), stock, page + 1) }
            .onSuccess { products = WmsProduct.merge(products.orEmpty(), it.products); loadedRows += it.rows; page += 1 }
            .onFailure { err = it.message }
        loading = false
    }
    val scan = rememberTagScanner({ err = it }) { code -> q = code.trim() }

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
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    )
                }
                IconButton(onClick = { scan() }) { Icon(Icons.Filled.QrCodeScanner, "Scan a tag", tint = Palette.accent) }
            }
            Muted("Name, UPC, custom SKU, vendor or colour — as in CarbonWMS › Catalog")
        }
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for ((id, label) in STOCK) Pill(label, filled = stock == id) { stock = id }
        }
        err?.let { Notice(it, Palette.bad) }
        val list = products
        when {
            list == null -> Muted("Loading…")
            list.isEmpty() -> Muted(if (q.isBlank()) "Nothing here." else "Nothing matches \"$q\".")
            else -> {
                Muted("%,d product%s · %,d of %,d rows".format(list.size, if (list.size == 1) "" else "s", loadedRows, total))
                Group {
                    list.forEachIndexed { i, p ->
                        ListRow(
                            p.name,
                            subtitle = listOfNotNull(
                                p.upc?.let { "UPC $it" },
                                p.colours.size.takeIf { it > 0 }?.let { "$it colour${if (it == 1) "" else "s"}" },
                                p.sizes.takeIf { it.isNotEmpty() }?.joinToString(" "),
                            ).joinToString(" · "),
                            divider = i > 0,
                            leading = { NetImage(p.image, Modifier.size(52.dp), crop = true, maxPx = 240, corner = 10.dp, background = Color.White, zoom = p.gallery) },
                            trailing = {
                                Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                    // One dot per size, filled when it has live tags here (as GradingAI's catalog shows measured sizes).
                                    Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                                        p.sizes.take(10).forEach { z -> Dot(Palette.ok, hollow = p.skus.filter { it.size == z }.sumOf { it.onHand } == 0, size = 8.dp) }
                                    }
                                    Text(
                                        listOfNotNull("${p.onHand} live", p.price?.let { "$%.0f".format(it) }).joinToString(" · "),
                                        style = MaterialTheme.typography.labelSmall, color = Palette.muted,
                                    )
                                }
                            },
                            onClick = { nav.go(Screen.WmsProduct(p)) },
                        )
                    }
                }
                if (loadedRows < total) Secondary(if (loading) "Loading…" else "Show more", enabled = !loading) { more() }
            }
        }
    }
}

private fun tagStatus(s: String) = when (s) {
    "in-stock" -> "Live"
    else -> s.replace('-', ' ').replaceFirstChar { it.uppercase() }
}

/**
 * One CarbonWMS product, laid out like GradingAI's product: its photo (tap to
 * zoom), Sizes / Colours, and under each custom SKU its tags here — EPC,
 * status, bin and zone, as Catalog › RFID shows them on CarbonWMS.
 */
@Composable
fun WmsProductScreen(nav: Nav, start: WmsProduct) {
    val app = App.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    var p by remember { mutableStateOf(start) }
    var err by remember { mutableStateOf<String?>(null) }
    var tab by remember { mutableStateOf("sizes") }
    var open by remember { mutableStateOf<String?>(null) }
    val tags = remember { mutableStateMapOf<String, List<WmsTag>?>() }
    // The list page may hold only part of the product's rows; read them all.
    LaunchedEffect(start.matrixId) { runCatching { app.api.wmsProduct(start) }.onSuccess { it?.let { f -> p = f } }.onFailure { err = it.message } }
    fun toggle(key: String, skus: List<WmsSku>) {
        open = if (open == key) null else key
        if (open == null) return
        for (s in skus) if (!tags.containsKey(s.customSkuId)) {
            tags[s.customSkuId] = null
            scope.launch { runCatching { app.api.wmsTags(s.customSkuId) }.onSuccess { tags[s.customSkuId] = it }.onFailure { tags[s.customSkuId] = emptyList(); err = it.message } }
        }
    }

    Page(p.name, onBack = { nav.back() }, largeTitle = false, tabs = { BottomTabs(Tab.Catalog) { onTab(nav, it) } }) {
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            NetImage(p.image, Modifier.fillMaxWidth(0.62f), maxPx = 900, corner = 20.dp, fitAspect = 0.75f, background = Color.White, zoom = p.gallery)
        }
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(p.name, style = MaterialTheme.typography.headlineSmall, color = Palette.text)
            Muted(
                listOfNotNull(
                    p.upc?.let { "UPC $it" }, p.vendor, p.category,
                    "${p.colours.size} colour${if (p.colours.size == 1) "" else "s"}", p.price?.let { "$%.2f".format(it) },
                ).joinToString(" · "),
            )
        }
        Card(padding = 14.dp) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                val total = p.skus.size
                val withStock = p.skus.count { it.onHand > 0 }
                ProgressRing(if (total > 0) withStock.toFloat() / total else 0f, Modifier.size(84.dp), stroke = 10.dp) {
                    Text("${p.onHand}", style = MaterialTheme.typography.titleLarge, color = Palette.text)
                }
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text("${p.onHand} live here", style = MaterialTheme.typography.titleMedium, color = Palette.text)
                    Muted("$withStock of $total SKUs in stock")
                }
            }
        }
        err?.let { Notice(it, Palette.bad) }
        Row(Modifier.fillMaxWidth().background(Palette.raised, RoundedCornerShape(10.dp)).padding(3.dp)) {
            for ((id, label) in listOf("sizes" to "Sizes", "colours" to "Colours")) {
                Text(
                    label, style = MaterialTheme.typography.labelMedium, color = Palette.text, fontWeight = if (tab == id) FontWeight.SemiBold else FontWeight.Normal,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.weight(1f).background(if (tab == id) Palette.surface else Color.Transparent, RoundedCornerShape(8.dp)).clickable { tab = id; open = null }.padding(vertical = 8.dp),
                )
            }
        }
        val groups: List<Pair<String, List<WmsSku>>> =
            if (tab == "sizes") p.sizes.map { z -> z to p.skus.filter { it.size == z } } + p.skus.filter { it.size == null }.let { if (it.isEmpty()) emptyList() else listOf("One size" to it) }
            else p.skus.groupBy { it.color ?: "—" }.toList()
        Group(footer = "Tap a ${if (tab == "sizes") "size" else "colour"} to see its custom SKUs and tags.") {
            groups.forEachIndexed { i, (label, skus) ->
                val live = skus.sumOf { it.onHand }
                val img = skus.firstNotNullOfOrNull { it.image }
                ListRow(
                    label,
                    subtitle = (if (tab == "sizes") skus.mapNotNull { it.color }.distinct().joinToString(" · ") else skus.mapNotNull { it.size }.joinToString(" · ")).ifBlank { null },
                    divider = i > 0,
                    leading = if (tab == "colours") ({ NetImage(img, Modifier.size(52.dp), crop = true, maxPx = 240, corner = 10.dp, background = Color.White, zoom = p.gallery, zoomAt = p.gallery.indexOf(img).coerceAtLeast(0)) })
                        else ({ Dot(Palette.ok, hollow = live == 0) }),
                    trailing = { Badge("$live live", if (live > 0) Palette.ok else Palette.muted, solid = live > 0) },
                    onClick = { toggle(tab + label, skus) },
                )
                if (open == tab + label) Column(
                    Modifier.fillMaxWidth().background(Palette.ground).padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    for (s in skus) {
                        Column(Modifier.fillMaxWidth().background(Palette.surface, RoundedCornerShape(12.dp)).padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                NetImage(s.image, Modifier.size(40.dp), crop = true, maxPx = 200, corner = 8.dp, background = Color.White, zoom = s.image?.let(::listOf))
                                Column(Modifier.weight(1f)) {
                                    Text(listOfNotNull(s.color, s.size).joinToString(" · ").ifBlank { s.sku }, style = MaterialTheme.typography.bodyMedium, color = Palette.text, fontWeight = FontWeight.Medium)
                                    Muted(listOfNotNull(s.sku, s.upc?.let { "UPC $it" }, s.bin?.let { "Bin $it" }, s.price?.toDoubleOrNull()?.let { "$%.2f".format(it) }).joinToString(" · "))
                                }
                                Badge("${s.onHand}", if (s.onHand > 0) Palette.ok else Palette.muted)
                            }
                            when (val t = tags[s.customSkuId]) {
                                null -> Muted("Loading tags…")
                                else -> if (t.isEmpty()) Muted("No tags here.") else for (tag in t) {
                                    KeyValue(
                                        tag.epc.ifBlank { tag.serial ?: "—" },
                                        listOfNotNull(tagStatus(tag.status), tag.bin?.takeIf { it.isNotBlank() }, tag.zone).joinToString(" · "),
                                        if (tag.status == "in-stock") Palette.ok else Palette.muted,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
