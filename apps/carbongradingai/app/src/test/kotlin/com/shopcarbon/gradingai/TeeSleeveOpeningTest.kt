package com.shopcarbon.gradingai

import com.shopcarbon.gradingai.measure.Outline
import com.shopcarbon.gradingai.model.PointDef
import com.shopcarbon.gradingai.model.Profile
import com.shopcarbon.gradingai.vision.Mask
import org.junit.Assert.assertEquals
import org.junit.Test
import kotlin.math.hypot

/**
 * A tee lying with its sleeves angled down: each sleeve opening slants back from
 * the sleeve's tip towards the armpit. The opening must be measured corner to
 * corner — every tee scan of 2026-10-22 read 3–4 cm (only the tip), the real
 * openings were ~20 cm. Outline traced from the owner's Kinda T-Shirt L scan.
 */
class TeeSleeveOpeningTest {
    private fun pt(k: String, l: String, side: String? = null, pair: String? = null) = PointDef(k, l, k, "", pair, side, false, false)
    private val tee = Profile(
        "tee", "T-shirt", "top", "tee",
        listOf(pt("chest", "A"), pt("length", "D"), pt("shoulder", "E"), pt("waist", "B"), pt("hem", "C"),
            pt("sleeveL", "G", "L", "sleeve"), pt("sleeveR", "G", "R", "sleeve"), pt("cuffL", "J", "L", "cuff"), pt("cuffR", "J", "R", "cuff")),
        "front", emptyList(), null, "sleeves", null,
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

    private fun check(w: Int, h: Int, pxPerCm: Double, poly: List<Pair<Double, Double>>, l: List<Pair<Double, Double>>, r: List<Pair<Double, Double>>) {
        val m = Mask(w, h)
        fill(m, poly)
        val lines = Outline.measure(m, pxPerCm, tee).lines
        for ((side, c) in listOf("L" to l, "R" to r)) {
            val want = hypot(c[1].first - c[0].first, c[1].second - c[0].second) / pxPerCm
            val op = lines["cuff$side"]!!.pts
            val got = hypot((op[1].x - op[0].x).toDouble(), (op[1].y - op[0].y).toDouble()) / pxPerCm
            assertEquals("sleeve opening $side", want, got, 1.0)
        }
    }

    @Test fun slantedOpeningIsMeasuredCornerToCorner() = check(
        1067, 859, 9.7557,
        listOf(
            1010.0 to 245.0, 589.0 to 55.0, 518.0 to 79.0, 433.0 to 60.0, 264.0 to 137.0, 58.0 to 289.0,
            172.0 to 442.0, 260.0 to 412.0, 286.0 to 799.0, 828.0 to 787.0, 814.0 to 375.0, 910.0 to 418.0,
        ),
        listOf(58.0 to 289.0, 172.0 to 442.0), listOf(1010.0 to 245.0, 910.0 to 418.0),
    )

    /** Oversized Basic T-Shirt M (2026-10-22): wider sleeves, a small spur at the right armpit. */
    @Test fun oversizedTee() = check(
        1139, 905, 10.4098,
        listOf(
            1087.0 to 280.0, 632.0 to 61.0, 490.0 to 71.0, 330.0 to 136.0, 63.0 to 327.0, 191.0 to 490.0,
            264.0 to 462.0, 284.0 to 839.0, 862.0 to 834.0, 863.0 to 431.0, 885.0 to 416.0, 973.0 to 466.0,
        ),
        listOf(63.0 to 327.0, 191.0 to 490.0), listOf(1087.0 to 280.0, 973.0 to 466.0),
    )
}
