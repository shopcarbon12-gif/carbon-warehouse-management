package com.shopcarbon.gradingai.ui

import androidx.compose.runtime.mutableStateListOf
import com.shopcarbon.gradingai.measure.MeasureSession
import com.shopcarbon.gradingai.measure.MeasureTarget
import com.shopcarbon.gradingai.model.Lookup
import com.shopcarbon.gradingai.model.SaveResult

sealed class Screen {
    data object Login : Screen()
    data object Home : Screen()
    data object Queue : Screen()
    data class Guide(val profileId: String? = null) : Screen()
    data class Item(val lookup: Lookup, val preSize: String? = null) : Screen()
    data class Capture(val target: MeasureTarget) : Screen()
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

    fun go(s: Screen) { if (s is Screen.Item) currentItem = s.lookup; stack.add(s) }
    fun replace(s: Screen) { stack[stack.lastIndex] = s }
    fun back(): Boolean { if (stack.size <= 1) return false; stack.removeAt(stack.lastIndex); return true }
    fun reset(s: Screen) { stack.clear(); stack.add(s) }
    /** Back to Home, keeping nothing above it. */
    fun home() { reset(Screen.Home) }
}
