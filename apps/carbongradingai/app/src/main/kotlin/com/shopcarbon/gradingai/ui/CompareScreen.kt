package com.shopcarbon.gradingai.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Undo
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.ViewList
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.shopcarbon.gradingai.App
import com.shopcarbon.gradingai.measure.Units
import com.shopcarbon.gradingai.model.CatalogRow
import com.shopcarbon.gradingai.model.Lookup
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.roundToInt

private enum class Side { MINE, THEIRS }
private data class Edit(val side: Side, val key: String, val before: Double?)

/**
 * Compare (owner, 2026-10-22): the garment in hand — this product, this size —
 * against another product found by UPC, SKU or name (or a scanned tag). Both
 * columns can be corrected here; Save copies the other product's whole grading
 * onto every size of this product (the compared size with the numbers as shown
 * on the right). Undo steps back one edit, Refresh reloads both from CarbonWMS,
 * ✕ leaves without saving.
 */
@Composable
fun CompareScreen(nav: Nav, start: Lookup, size: String) {
    val app = App.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    var mine by remember { mutableStateOf(start) }
    var other by remember { mutableStateOf<Lookup?>(null) }
    var otherSize by remember { mutableStateOf<String?>(null) }
    var q by remember { mutableStateOf("") }
    var hits by remember { mutableStateOf<List<CatalogRow>>(emptyList()) }
    var busy by remember { mutableStateOf<String?>(null) }
    var err by remember { mutableStateOf<String?>(null) }
    var units by remember { mutableStateOf(if (app.prefs.units == "both") "both" else app.prefs.units) }
    // Edited values, by side and key (cm). A key missing here shows what CarbonWMS holds.
    val mineEdits = remember { mutableStateMapOf<String, Double>() }
    val theirEdits = remember { mutableStateMapOf<String, Double>() }
    val undo = remember { mutableStateListOf<Edit>() }

    val focus = androidx.compose.ui.platform.LocalFocusManager.current
    fun pick(l: Lookup) {
        focus.clearFocus()
        other = l; q = ""; hits = emptyList(); err = null
        theirEdits.clear(); undo.removeAll { it.side == Side.THEIRS }
        val labels = l.sizeLabels()
        otherSize = labels.firstOrNull { it == size } ?: labels.firstOrNull()
    }
    fun openCode(code: String) {
        busy = "Finding $code…"; err = null
        scope.launch {
            try {
                val l = app.api.lookupCode(code)
                if (l.matrixId == mine.matrixId) err = "That is the item in your hand — pick another product." else pick(l)
            } catch (e: Exception) { err = e.message } finally { busy = null }
        }
    }
    fun refresh() {
        busy = "Refreshing…"; err = null
        scope.launch {
            try {
                mine = app.api.lookupMatrix(mine.matrixId)
                other?.let { o -> other = app.api.lookupMatrix(o.matrixId) }
                mineEdits.clear(); theirEdits.clear(); undo.clear()
            } catch (e: Exception) { err = e.message } finally { busy = null }
        }
    }
    LaunchedEffect(q) {
        val t = q.trim()
        if (t.length < 2) { hits = emptyList(); return@LaunchedEffect }
        delay(300)
        runCatching { hits = app.api.catalog(t, "all").filter { it.matrixId != mine.matrixId }.take(8) }
    }
    val scan = rememberTagScanner({ err = it }) { code -> openCode(code) }

    // The rows: every measurement either side has, in the order of this garment's points.
    val profile = app.config?.profile(mine.profileId) ?: app.config?.profile(other?.profileId)
    val baseMine = mine.origins[size]?.pointsCm.orEmpty()
    val baseTheirs = otherSize?.let { other?.origins?.get(it)?.pointsCm }.orEmpty()
    val pairs = profile?.points?.mapNotNull { it.pairOf }?.toSet().orEmpty()
    fun lrHidden(k: String) = pairs.any { p -> k == p + "L" || k == p + "R" }
    val keys = (baseMine.keys + baseTheirs.keys).filterNot { lrHidden(it) }.distinct()
        .sortedBy { k -> profile?.points?.indexOfFirst { it.key == k || it.pairOf == k }?.takeIf { it >= 0 } ?: 99 }
    fun label(k: String): String = profile?.points?.firstOrNull { it.key == k }?.label
        ?: profile?.points?.firstOrNull { it.pairOf == k }?.label?.replace(Regex("""[,\s]*(leg |sleeve )?\b[LR]$"""), "") ?: k
    fun valueOf(side: Side, k: String): Double? = if (side == Side.MINE) mineEdits[k] ?: baseMine[k] else theirEdits[k] ?: baseTheirs[k]
    /** `first`: the first change since the box was tapped — one Undo step per box edit, not per key. */
    fun setValue(side: Side, k: String, v: Double?, first: Boolean) {
        if (first) undo.add(Edit(side, k, (if (side == Side.MINE) mineEdits else theirEdits)[k]))
        val m = if (side == Side.MINE) mineEdits else theirEdits
        if (v == null) m.remove(k) else m[k] = v
    }

    fun save() {
        val o = other ?: return
        if (otherSize == null) return
        busy = "Copying…"; err = null
        scope.launch {
            try {
                // My compared size: the right column as shown (pairs follow their plain value), plus my own extra keys.
                val pts = JSONObject()
                for (k in keys) {
                    val v = valueOf(Side.THEIRS, k) ?: valueOf(Side.MINE, k) ?: continue
                    pts.put(k, v)
                    if (k in pairs) { pts.put(k + "L", v); pts.put(k + "R", v) }
                }
                // Their other sizes go across as CarbonWMS holds them; the compared size takes the edited numbers.
                val overrides = JSONObject().put(size, pts)
                val res = app.api.copyGrading(o.matrixId, mine.matrixId, overrides)
                nav.replace(Screen.CompareDone(mine, o.name, res))
            } catch (e: Exception) { err = e.message ?: "Could not copy" } finally { busy = null }
        }
    }

    Page(
        "Compare", onBack = { nav.back() }, largeTitle = false,
        actions = {
            GlassCircle(Icons.AutoMirrored.Filled.Undo, "Undo", {
                undo.removeLastOrNull()?.let { e ->
                    val m = if (e.side == Side.MINE) mineEdits else theirEdits
                    if (e.before == null) m.remove(e.key) else m[e.key] = e.before
                }
            }, tint = if (undo.isEmpty()) Palette.muted else Palette.text)
            GlassCircle(Icons.Filled.Refresh, "Refresh", { refresh() })
        },
        bottom = {
            Primary(
                if (busy == "Copying…") "Copying…" else "Save — copy to all my sizes",
                enabled = other != null && otherSize != null && busy == null && keys.isNotEmpty(),
                caption = other?.let { "From ${it.name}" },
            ) { save() }
        },
    ) {
        // The garment in hand.
        Group(header = "In your hand") {
            ListRow(
                mine.name,
                subtitle = listOfNotNull("Size $size", mine.skusOfSize(size).mapNotNull { it.color }.distinct().joinToString().ifBlank { null }, mine.upc?.let { "UPC $it" }).joinToString(" · "),
                leading = { NetImage(mine.skusOfSize(size).firstNotNullOfOrNull { it.image } ?: mine.image, Modifier.size(52.dp), crop = true, maxPx = 240, corner = 10.dp, zoom = (mine.skusOfSize(size).firstNotNullOfOrNull { it.image } ?: mine.image)?.let(::listOf)) },
            )
        }
        // The other product: scan or search.
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Label("Compare with")
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(
                    Modifier.size(48.dp).background(Palette.surface, RoundedCornerShape(14.dp)).clickable { scan() },
                    contentAlignment = Alignment.Center,
                ) { Icon(Icons.Filled.QrCodeScanner, "Scan a tag", tint = Palette.accent) }
                Row(
                    Modifier.weight(1f).height(48.dp).background(Palette.surface, RoundedCornerShape(14.dp)).padding(horizontal = 12.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Icon(Icons.Filled.Search, null, tint = Palette.muted, modifier = Modifier.size(20.dp))
                    Box(Modifier.weight(1f)) {
                        if (q.isEmpty()) Text("UPC, custom SKU or name", style = MaterialTheme.typography.bodyLarge, color = Palette.muted)
                        BasicTextField(
                            q, { q = it }, singleLine = true, textStyle = MaterialTheme.typography.bodyLarge.copy(color = Palette.text),
                            cursorBrush = SolidColor(Palette.accent), modifier = Modifier.fillMaxWidth(),
                            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                            keyboardActions = KeyboardActions(onSearch = { q.trim().takeIf { it.isNotEmpty() }?.let { openCode(it) } }),
                        )
                    }
                }
            }
            if (hits.isNotEmpty()) Group {
                hits.forEachIndexed { i, r ->
                    ListRow(
                        r.name, subtitle = r.upc?.let { "UPC $it" }, divider = i > 0,
                        leading = { NetImage(r.image, Modifier.size(40.dp), crop = true, maxPx = 200, corner = 8.dp, zoom = r.image?.let(::listOf)) },
                        onClick = {
                            busy = "Opening…"
                            scope.launch { try { pick(app.api.lookupMatrix(r.matrixId)) } catch (e: Exception) { err = e.message } finally { busy = null } }
                        },
                    )
                }
            }
        }
        busy?.takeIf { it != "Copying…" }?.let { Muted(it) }
        err?.let { Notice(it, Palette.bad) }

        val o = other
        if (o != null) {
            Group {
                ListRow(
                    o.name,
                    subtitle = listOfNotNull(o.upc?.let { "UPC $it" }, "${o.colours().size} colour${if (o.colours().size == 1) "" else "s"}").joinToString(" · "),
                    leading = { NetImage(o.image, Modifier.size(52.dp), crop = true, maxPx = 240, corner = 10.dp, zoom = o.image?.let(::listOf)) },
                    trailing = { Text("Change", style = MaterialTheme.typography.bodyMedium, color = Palette.accent) },
                    onClick = { other = null; otherSize = null; theirEdits.clear() },
                )
            }
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Muted("Their size")
                for (s in o.sizeLabels()) Pill(s, filled = s == otherSize) { otherSize = s; theirEdits.clear(); undo.removeAll { it.side == Side.THEIRS } }
            }
            if (o.origins.isEmpty()) Notice("${o.name} has no measurements in CarbonWMS yet — nothing to copy.", Palette.warn)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for ((k, l) in listOf("cm" to "CM", "in" to "INCH", "both" to "BOTH")) Pill(l, filled = units == k) { units = k }
        }

        // Side by side.
        if (keys.isNotEmpty()) Column(Modifier.fillMaxWidth().background(Palette.surface, RoundedCornerShape(16.dp)).padding(vertical = 6.dp)) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("", Modifier.weight(1f))
                Text("Mine · $size", Modifier.width(96.dp), style = MaterialTheme.typography.labelSmall, color = Palette.muted, textAlign = TextAlign.Center)
                Text(if (o != null) "Theirs · ${otherSize ?: "—"}" else "Theirs", Modifier.width(96.dp), style = MaterialTheme.typography.labelSmall, color = Palette.muted, textAlign = TextAlign.Center)
            }
            keys.forEach { k ->
                val a = valueOf(Side.MINE, k)
                val b = valueOf(Side.THEIRS, k)
                Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(label(k), style = MaterialTheme.typography.bodyMedium, color = Palette.text)
                        if (a != null && b != null) {
                            val d = b - a
                            Text((if (d >= 0) "+" else "−") + Units.show(kotlin.math.abs(d), if (units == "both") "cm" else units), style = MaterialTheme.typography.labelSmall, color = guideColor(d))
                        }
                    }
                    NumberCell(a, units, k in mineEdits, Modifier.width(96.dp)) { v, first -> setValue(Side.MINE, k, v, first) }
                    NumberCell(b, units, k in theirEdits, Modifier.width(96.dp), enabled = o != null) { v, first -> setValue(Side.THEIRS, k, v, first) }
                }
            }
        } else if (o == null) Muted("Scan or search the product to compare with.")
        if (o != null) Muted(
            "Save copies the right-hand column to your size $size and ${o.name}'s other sizes to yours (matching size names). " +
                "It adds new readings — you can Undo it on the next screen.",
        )
    }
}

/**
 * One editable measurement: shows cm, inches or both; typed in the unit shown
 * (cm when both). What is typed stays as typed while the box is in use; it
 * follows the value again when that changes from outside (Undo, Refresh, units).
 */
@Composable
private fun NumberCell(v: Double?, units: String, edited: Boolean, modifier: Modifier, enabled: Boolean = true, onSet: (Double?, Boolean) -> Unit) {
    val inch = units == "in"
    fun fmt(x: Double?) = x?.let { if (inch) ((it / 2.54) * 10).roundToInt() / 10.0 else (it * 10).roundToInt() / 10.0 }?.toString() ?: ""
    var tf by remember { mutableStateOf(TextFieldValue(fmt(v))) }
    /** The value this box itself last produced — anything else arriving is an outside change. */
    var produced by remember { mutableStateOf(v) }
    var started by remember { mutableStateOf(false) }
    LaunchedEffect(v, units) { if (v != produced || !started) { tf = TextFieldValue(fmt(v)); produced = v } }
    var focused by remember { mutableStateOf(false) }
    // After the tap has placed its cursor: select the whole number.
    LaunchedEffect(focused) { if (focused) { delay(80); tf = tf.copy(selection = TextRange(0, tf.text.length)) } }
    Column(modifier.padding(horizontal = 4.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        BasicTextField(
            tf,
            { next ->
                val changed = next.text != tf.text
                tf = next
                if (!changed) return@BasicTextField
                val t = next.text
                val n = t.replace(',', '.').toDoubleOrNull()
                val cm = if (t.isBlank()) null else if (n != null && n > 0) (if (inch) n * 2.54 else n) else return@BasicTextField
                val first = !started
                started = true
                produced = cm
                onSet(cm, first)
            },
            enabled = enabled, singleLine = true,
            textStyle = TextStyle(color = Palette.text, fontWeight = if (edited) FontWeight.Bold else FontWeight.Medium, fontSize = MaterialTheme.typography.bodyLarge.fontSize, textAlign = TextAlign.Center),
            cursorBrush = SolidColor(Palette.accent),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            modifier = Modifier.fillMaxWidth()
                // Tapping a box selects its number, so typing replaces it.
                .onFocusChanged {
                    focused = it.isFocused
                    if (!it.isFocused) { started = false; tf = TextFieldValue(fmt(produced)) }
                }
                .background(if (edited) Palette.accentSoft else Palette.ground, RoundedCornerShape(10.dp))
                .border(1.dp, if (edited) Palette.accent else Palette.line, RoundedCornerShape(10.dp)).padding(vertical = 8.dp),
        )
        if (units == "both" && v != null) Text(Units.inch(v), style = MaterialTheme.typography.labelSmall, color = Palette.muted)
    }
}

/** After a copy: what went across, Undo, and where next. */
@Composable
fun CompareDoneScreen(nav: Nav, mine: Lookup, fromName: String, result: JSONObject) {
    val app = App.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    var undone by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var err by remember { mutableStateOf<String?>(null) }
    val applied = result.optJSONArray("applied") ?: JSONArray()
    val skipped = result.optJSONArray("skipped") ?: JSONArray()
    val scan = rememberTagScanner({ err = it }) { code -> nav.home(); openCode(nav, app, scope, code, { }) { err = it } }
    Page("Copied", onBack = { nav.home() }, largeTitle = false) {
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(if (undone) Icons.AutoMirrored.Filled.Undo else Icons.Filled.CheckCircle, null, tint = if (undone) Palette.muted else Palette.ok, modifier = Modifier.size(68.dp))
            Text(if (undone) "Copy undone" else "Copied to ${mine.name}", style = MaterialTheme.typography.headlineSmall, color = Palette.text, textAlign = TextAlign.Center)
            Text(if (undone) "Every size is back to what it had." else "From $fromName", style = MaterialTheme.typography.bodyMedium, color = Palette.muted)
        }
        if (!undone) Group(header = "Sizes") {
            for (i in 0 until applied.length()) {
                val a = applied.getJSONObject(i)
                ListRow(a.optString("size"), divider = i > 0, trailing = {
                    if (a.optBoolean("edited")) Badge("Edited", Palette.accent)
                    Text("${a.optInt("skus")} SKU${if (a.optInt("skus") == 1) "" else "s"}", style = MaterialTheme.typography.bodySmall, color = Palette.muted)
                })
            }
        }
        if (!undone && skipped.length() > 0) Muted("Not copied (no such size on $fromName): " + (0 until skipped.length()).joinToString { skipped.getString(it) })
        err?.let { Notice(it, Palette.bad) }
        if (!undone) Secondary(if (busy) "Undoing…" else "Undo this copy", enabled = !busy) {
            busy = true
            scope.launch {
                try { app.api.undoCopy(result.optJSONArray("rowIds") ?: JSONArray()); undone = true } catch (e: Exception) { err = e.message } finally { busy = false }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Tile(Icons.Filled.QrCodeScanner, "Scan new tag", Modifier.weight(1f)) { scan() }
            Tile(Icons.Filled.ViewList, "Queue", Modifier.weight(1f)) { nav.home(); nav.go(Screen.Queue) }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Tile(Icons.Filled.Search, "See ${mine.name.take(14)}", Modifier.weight(1f)) {
                scope.launch { try { nav.home(); nav.go(Screen.Product(app.api.lookupMatrix(mine.matrixId))) } catch (e: Exception) { err = e.message } }
            }
            Tile(Icons.Filled.Home, "Home", Modifier.weight(1f)) { nav.home() }
        }
    }
}
