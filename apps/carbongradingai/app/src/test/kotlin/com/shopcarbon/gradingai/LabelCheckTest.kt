package com.shopcarbon.gradingai

import com.shopcarbon.gradingai.measure.LabelCheck
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LabelCheckTest {
    private val sizes = listOf("S", "M", "L")

    @Test fun misreadFibreStillMatches() {
        // The Ayla Dress label on the S25: "elestane" against the WMS's "Elastane".
        val r = LabelCheck.compare("S\n90% POLYESTER 10% ELESTANE\n90% POLIÉSTER 10% ELASTANO", sizes, "S", "90% Polyester, 10% Elastane")
        assertNull(r.flag)
        assertTrue(r.summary, r.summary.contains("Fabric matches CarbonWMS"))
    }

    @Test fun brandAndOtherLanguages() {
        assertNull(LabelCheck.compare("M 95% COTTON 5% SPANDEX", sizes, "M", "95% Cotton, 5% Lycra").flag)
        assertNull(LabelCheck.compare("L 100% ALGODÓN", sizes, "L", "100% Cotton").flag)
    }

    @Test fun realDifferencesAreFlagged() {
        assertTrue(LabelCheck.compare("S 80% COTTON 20% POLYESTER", sizes, "S", "100% Cotton").flag!!.startsWith("care label fabric"))
        assertEquals("care label says M, measured as S", LabelCheck.compare("M 100% COTTON", sizes, "S", "100% Cotton").flag)
    }
}
