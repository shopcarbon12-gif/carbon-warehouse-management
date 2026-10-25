package com.shopcarbon.gradingai.ui

import androidx.compose.foundation.background
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
                            leading = { NetImage(p.image, Modifier.size(52.dp), crop = true, maxPx = 240, corner = 10.dp, background = Color.White) },
                            trailing = {
                                Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                    Badge("${p.onHand}", if (p.onHand > 0) Palette.ok else Palette.muted)
                                    p.price?.let { Text("$%.2f".format(it), style = MaterialTheme.typography.labelSmall, color = Palette.muted) }
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

/** One CarbonWMS product: every colour, each size with its custom SKU, live tags, bin and price. */
@Composable
fun WmsProductScreen(nav: Nav, start: WmsProduct) {
    val app = App.get(LocalContext.current)
    var p by remember { mutableStateOf(start) }
    var err by remember { mutableStateOf<String?>(null) }
    // The list page may hold only part of the product's rows; read them all.
    LaunchedEffect(start.matrixId) { runCatching { app.api.wmsProduct(start) }.onSuccess { it?.let { f -> p = f } }.onFailure { err = it.message } }

    Page(p.name, onBack = { nav.back() }, largeTitle = false, tabs = { BottomTabs(Tab.Catalog) { onTab(nav, it) } }) {
        NetImage(p.image, Modifier.fillMaxWidth(), maxPx = 1200, corner = 18.dp, background = Color.White, fitAspect = 0.8f)
        Text(p.name, style = MaterialTheme.typography.headlineSmall, color = Palette.text)
        Card(padding = 14.dp) {
            p.upc?.let { KeyValue("UPC", it) }
            p.vendor?.let { KeyValue("Vendor", it) }
            p.category?.let { KeyValue("Category", it) }
            p.price?.let { KeyValue("Price", "$%.2f".format(it)) }
            KeyValue("Live here", "${p.onHand}", if (p.onHand > 0) Palette.ok else Palette.muted)
        }
        err?.let { Notice(it, Palette.bad) }
        val byColour = p.skus.groupBy { it.color ?: "—" }
        for ((colour, skus) in byColour) {
            Group(header = "$colour · ${skus.sumOf { it.onHand }} live") {
                skus.forEachIndexed { i, s ->
                    ListRow(
                        s.size ?: "One size",
                        subtitle = listOfNotNull(s.sku, s.upc?.let { "UPC $it" }, s.bin?.let { "Bin $it" }).joinToString(" · "),
                        divider = i > 0,
                        trailing = { Badge("${s.onHand}", if (s.onHand > 0) Palette.ok else Palette.muted, solid = s.onHand > 0) },
                    )
                }
            }
        }
    }
}
