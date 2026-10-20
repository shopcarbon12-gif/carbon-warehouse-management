package com.shopcarbon.gradingai

import com.shopcarbon.gradingai.measure.Outline
import com.shopcarbon.gradingai.model.PointDef
import com.shopcarbon.gradingai.model.Profile
import com.shopcarbon.gradingai.vision.Mask
import org.junit.Assert.assertEquals
import org.junit.Test
import kotlin.math.hypot

/**
 * Shorts lying with the legs splayed: each hem is slanted, outer corner higher
 * than the inner one (the owner's John Denim Shorts scan, 2026-10-20). The
 * opening must be the full hem, corner to corner.
 */
class ShortsHemTest {
    private fun pt(k: String, l: String, side: String? = null) = PointDef(k, l, k, "", null, side, false, false)
    private val shorts = Profile(
        "shorts", "Shorts", "shorts", "bottoms",
        listOf(pt("waist", "A"), pt("rise", "I"), pt("inseamL", "G", "L"), pt("inseamR", "G", "R"),
            pt("outseamL", "H", "L"), pt("outseamR", "H", "R"), pt("legOpeningL", "F", "L"), pt("legOpeningR", "F", "R")),
        "front", emptyList(), null, "bottoms", null,
    )

    /** Point-in-polygon fill. */
    private fun fill(m: Mask, poly: List<Pair<Double, Double>>) {
        for (y in 0 until m.h) for (x in 0 until m.w) {
            var inside = false
            var j = poly.size - 1
            for (i in poly.indices) {
                val (xi, yi) = poly[i]; val (xj, yj) = poly[j]
                if ((yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside
                j = i
            }
            if (inside) m.data[y * m.w + x] = 1
        }
    }

    @Test fun slantedHemIsMeasuredCornerToCorner() {
        val pxPerCm = 10.0
        val m = Mask(700, 700)
        // Waistband + seat: 37 cm wide, the crotch 26 cm below the top.
        fill(m, listOf(165.0 to 40.0, 535.0 to 40.0, 545.0 to 300.0, 155.0 to 300.0))
        // Left leg: outer corner (60, 560), inner corner (300, 620) — a 24.7 cm slanted hem.
        fill(m, listOf(155.0 to 290.0, 345.0 to 290.0, 300.0 to 620.0, 60.0 to 560.0))
        // Right leg, mirrored.
        fill(m, listOf(355.0 to 290.0, 545.0 to 290.0, 640.0 to 560.0, 400.0 to 620.0))
        val lines = Outline.measure(m, pxPerCm, shorts).lines
        val want = hypot(300.0 - 60.0, 620.0 - 560.0) / pxPerCm
        for (side in listOf("L", "R")) {
            val op = lines["legOpening$side"]!!.pts
            val got = hypot((op[1].x - op[0].x).toDouble(), (op[1].y - op[0].y).toDouble()) / pxPerCm
            assertEquals("leg opening $side", want, got, 0.8)
        }
        val l = lines["legOpeningL"]!!.pts; val r = lines["legOpeningR"]!!.pts
        val lw = hypot((l[1].x - l[0].x).toDouble(), (l[1].y - l[0].y).toDouble())
        val rw = hypot((r[1].x - r[0].x).toDouble(), (r[1].y - r[0].y).toDouble())
        assertEquals("the two legs agree", lw / pxPerCm, rw / pxPerCm, 0.5)
    }
}
