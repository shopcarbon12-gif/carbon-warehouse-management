package com.shopcarbon.gradingai.ui

import androidx.compose.runtime.mutableStateListOf
import com.shopcarbon.gradingai.measure.MeasureSession
import com.shopcarbon.gradingai.measure.MeasureTarget
import com.shopcarbon.gradingai.model.Lookup
import com.shopcarbon.gradingai.model.SaveResult

sealed class Screen {
    data object Login : Screen()
    data object Home : Screen()
    /** GradingAI's catalog search (under Scan tag): sizes measured per product. `focus`: the keyboard comes up at once. */
    data class Catalog(val focus: Boolean = false) : Screen()
    /** The Catalog tab: CarbonWMS's own catalog (Inventory › Catalog). */
    data object WmsCatalog : Screen()
    /** One product of the CarbonWMS catalog: every colour and size with its stock. */
    data class WmsProduct(val product: com.shopcarbon.gradingai.model.WmsProduct) : Screen()
    /** The Social tab: CarbonCast — the posts calendar, approval, publishing switch, best times. */
    data object Social : Screen()
    data class SocialPost(val post: com.shopcarbon.gradingai.model.SocialPost) : Screen()
    /** Bulk Studio: CarbonWMS's own Bulk Studio, inside the app (same settings; sends to the OpenAI batch). */
    data object Studio : Screen()
    /** A product from the Catalog: every size and colour with its status. */
    data class Product(val lookup: Lookup) : Screen()
    data object Queue : Screen()
    /** Scans the app or CarbonWMS flagged, waiting for a look. */
    data object ToCheck : Screen()
    /** Compare the garment in hand (this product, this size) with another product, and copy its grading. */
    data class Compare(val lookup: Lookup, val size: String) : Screen()
    /** After a Compare copy: what was written, Undo, and where to go next. */
    data class CompareDone(val mine: Lookup, val fromName: String, val result: org.json.JSONObject) : Screen()
    /** A scan already saved: its photo and lines, editable, saved back to CarbonWMS. */
    data class EditSaved(val scanId: String) : Screen()
    data class Guide(val profileId: String? = null) : Screen()
    data class Item(val lookup: Lookup, val preSize: String? = null) : Screen()
    /** `crotchFor`: the second photo of a pair of bottoms, for that session's crotch points. */
    data class Capture(val target: MeasureTarget, val crotchFor: MeasureSession? = null) : Screen()
    data class Result(val session: MeasureSession) : Screen()
    data class Saved(val session: MeasureSession, val result: SaveResult?, val queuedOffline: Boolean) : Screen()
    data class Web(val title: String, val path: String) : Screen()
    data object Settings : Screen()
    data object Probe : Screen()
}

/** A plain back stack: the app has few screens and no deep links. */
class Nav(start: Screen) {
    val stack = mutableStateListOf(start)
    val top: Screen get() = stack.last()
    /** The product last opened, for the Studio / SEO tabs. */
    var currentItem: Lookup? = null

    fun go(s: Screen) { if (s is Screen.Item) currentItem = s.lookup; if (s is Screen.Product) currentItem = s.lookup; stack.add(s) }
    fun replace(s: Screen) { stack[stack.lastIndex] = s }
    fun back(): Boolean { if (stack.size <= 1) return false; stack.removeAt(stack.lastIndex); return true }
    fun reset(s: Screen) { stack.clear(); stack.add(s) }
    /** Back to Home, keeping nothing above it. */
    fun home() { reset(Screen.Home) }
}
