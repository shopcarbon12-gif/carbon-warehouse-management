package com.shopcarbon.gradingai

import com.shopcarbon.gradingai.measure.MLine
import com.shopcarbon.gradingai.measure.Pt
import com.shopcarbon.gradingai.measure.pointsCm
import com.shopcarbon.gradingai.model.PointDef
import com.shopcarbon.gradingai.model.Profile
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * Bottoms measured on two photos: the widths and outseams on the first, the
 * crotch points (rise, inseams) on the legs-spread second one — each at its
 * own photo's scale, the L/R average over both.
 */
class CrotchPhotoTest {
    private fun pt(k: String, side: String? = null, pair: String? = null) = PointDef(k, k, k, "", pair, side, false, false)
    private val shorts = Profile(
        "shorts", "Shorts", "shorts", "bottoms",
        listOf(pt("waist"), pt("rise"), pt("inseamL", "L", "inseam"), pt("inseamR", "R", "inseam"), pt("outseamL", "L", "outseam"), pt("outseamR", "R", "outseam")),
        "front", emptyList(), null, "bottoms", null, crotchKeys = listOf("rise", "inseamL", "inseamR"),
    )
    private fun vline(len: Float) = MLine(listOf(Pt(0f, 0f), Pt(0f, len)))

    @Test fun eachPhotoAtItsOwnScale() {
        // Main photo 13 px/cm, crotch photo 17 px/cm (held lower).
        val main = mapOf("waist" to vline(13f * 36.8f), "outseamL" to vline(13f * 51.6f), "outseamR" to vline(13f * 52.2f))
        val crotch = mapOf("rise" to vline(17f * 26.1f), "inseamL" to vline(17f * 27.6f), "inseamR" to vline(17f * 27.9f))
        val cm = pointsCm(shorts, listOf(main to 13.0, crotch to 17.0))
        assertEquals(36.8, cm["waist"]!!, 0.05)
        assertEquals(26.1, cm["rise"]!!, 0.05)
        assertEquals(27.75, cm["inseam"]!!, 0.06)
        assertEquals(51.9, cm["outseam"]!!, 0.05)
    }

    @Test fun crotchPhotoWinsForCrotchPoints() {
        // The first photo's own (wrong) crotch is dropped once the crotch photo has it.
        val main = mapOf("rise" to vline(13f * 20.6f))
        val crotch = mapOf("rise" to vline(17f * 26.1f))
        val cm = pointsCm(shorts, listOf(main to 13.0, crotch to 17.0))
        assertEquals(26.1, cm["rise"]!!, 0.05)
        assertFalse("inseam" in cm)
    }
}
