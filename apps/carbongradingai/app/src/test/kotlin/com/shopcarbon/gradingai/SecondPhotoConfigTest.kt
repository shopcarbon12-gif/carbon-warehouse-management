package com.shopcarbon.gradingai

import com.shopcarbon.gradingai.model.AppConfig
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/** The second photo comes from the WMS config: tops lift the sleeves for the chest, trousers take only the rise. */
class SecondPhotoConfigTest {
    private fun profile(json: String) = AppConfig.parse(JSONObject("""{"profiles":[$json]}""")).profiles.single()

    @Test fun topsTakeTheChestFromASleevesUpPhoto() {
        val p = profile("""{"id":"tee","family":"top","points":[{"key":"chest"},{"key":"waist"}],
            "secondPhoto":{"keys":["chest","waist"],"lay":"lift the sleeves","title":"sleeves up","sidesOk":["left","right","top"]}}""")
        assertEquals(listOf("chest", "waist"), p.crotchKeys)
        assertEquals("sleeves up", p.secondTitle)
        assertEquals(setOf("left", "right", "top"), p.secondSidesOk)
    }

    @Test fun trousersTakeOnlyTheRiseAndOlderConfigsStillWork() {
        val newer = profile("""{"id":"trousers","family":"trousers","points":[{"key":"rise"}],
            "crotchPhoto":{"keys":["rise"],"lay":"x"},"secondPhoto":{"keys":["rise"],"lay":"x","title":"crotch","sidesOk":["left","right","bottom"]}}""")
        assertEquals(listOf("rise"), newer.crotchKeys)
        assertEquals(setOf("left", "right", "bottom"), newer.secondSidesOk)
        // A WMS without secondPhoto: the crotch photo as before.
        val older = profile("""{"id":"shorts","family":"shorts","points":[{"key":"rise"}],"crotchPhoto":{"keys":["rise","inseamL","inseamR"],"lay":"x"}}""")
        assertEquals(listOf("rise", "inseamL", "inseamR"), older.crotchKeys)
        assertEquals("crotch", older.secondTitle)
        assertEquals(setOf("left", "right"), older.secondSidesOk)
    }
}
