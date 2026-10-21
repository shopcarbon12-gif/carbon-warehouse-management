package com.shopcarbon.gradingai

import androidx.compose.ui.geometry.Offset
import com.shopcarbon.gradingai.ui.quadSizes
import org.junit.Assert.assertEquals
import org.junit.Test
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin

/** The accuracy check's width / height / diagonal from four dragged corners. */
class AccuracyCheckTest {
    @Test
    fun rotatedTargetReadsItsTrueSize() {
        // The 24 × 18 cm target at 20 px/cm, turned 17° on the table.
        val k = 20.0; val a = Math.toRadians(17.0)
        fun p(x: Double, y: Double) = Offset((300 + (x * cos(a) - y * sin(a)) * k).toFloat(), (200 + (x * sin(a) + y * cos(a)) * k).toFloat())
        val (w, h, d) = quadSizes(listOf(p(0.0, 0.0), p(24.0, 0.0), p(24.0, 18.0), p(0.0, 18.0)), k)
        assertEquals(24.0, w, 0.01)
        assertEquals(18.0, h, 0.01)
        assertEquals(hypot(24.0, 18.0), d, 0.01)
    }

    @Test
    fun sidesAreAveraged() {
        // A slightly uneven pick: top edge 24.2 cm, bottom 23.8 → width 24.0.
        val k = 10.0
        val c = listOf(Offset(0f, 0f), Offset(242f, 0f), Offset(238f, 180f), Offset(0f, 180f))
        val (w, _, _) = quadSizes(c, k)
        assertEquals(24.0, w, 0.01)
    }
}
