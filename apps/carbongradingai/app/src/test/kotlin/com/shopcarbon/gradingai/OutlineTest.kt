package com.shopcarbon.gradingai

import com.shopcarbon.gradingai.measure.Outline
import com.shopcarbon.gradingai.measure.pointsCm
import com.shopcarbon.gradingai.model.AppConfig
import com.shopcarbon.gradingai.vision.Mask
import org.json.JSONObject
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.DataInputStream
import java.io.File
import kotlin.math.sqrt

/**
 * The outline measurer on the owner's guide pictures (clean flat lays), every
 * garment type. Reads raw RGB copies (raw/<name>.rgb: width, height, then
 * bytes) from GRADING_TEST_DIR and writes the lines to outline/<profile>.json
 * for drawing; skipped when the folder is not set.
 */
class OutlineTest {
    private fun ch(b: ByteArray, i: Int, k: Int): Int = b[i * 3 + k].toInt() and 0xff

    @Test fun guidePictures() {
        val dir = System.getenv("GRADING_TEST_DIR")?.let(::File)
        assumeTrue("GRADING_TEST_DIR not set", dir != null && File(dir, "profiles.json").exists())
        val root = JSONObject(File(dir, "profiles.json").readText())
        val cfg = AppConfig.parse(root)
        val arr = root.getJSONArray("profiles")
        val mains = HashMap<String, String>()
        for (i in 0 until arr.length()) mains[arr.getJSONObject(i).getString("id")] = arr.getJSONObject(i).getString("main")
        val out = File(dir, "outline").apply { mkdirs() }
        Outline.debug = { println("    · $it") }
        for (p in cfg.profiles) {
            val raw = File(dir, "raw/" + mains[p.id]!!.substringAfterLast('/').replace(".webp", ".rgb"))
            val inp = DataInputStream(raw.inputStream().buffered())
            val w = inp.readInt(); val h = inp.readInt()
            val px = ByteArray(w * h * 3); inp.readFully(px); inp.close()
            val corners = listOf(5 * w + 5, 5 * w + w - 6, (h - 6) * w + 5, (h - 6) * w + w - 6)
            val bg = IntArray(3) { k -> corners.map { ch(px, it, k) }.sorted()[2] }
            val m = Mask(w, h)
            for (i in 0 until w * h) {
                var s = 0.0
                for (k in 0..2) { val dv = ch(px, i, k) - bg[k]; s += (dv * dv).toDouble() }
                if (sqrt(s) > 28) m.data[i] = 1
            }
            val clean = Mask.clean(m, 2)
            val pxPerCm = 11.0
            val res = Outline.measure(clean, pxPerCm, p)
            val lines = res.lines
            val cm = pointsCm(p, lines, pxPerCm)
            println("${p.id}: ${lines.size}/${p.points.size} — " + p.points.joinToString { "${it.letter}${it.side ?: ""} ${cm[it.key]?.let { v -> "%.1f".format(v) } ?: "—"}" } + "  unsure ${res.unsure.sorted()}")
            val j = JSONObject().put("image", mains[p.id]).put("w", w).put("h", h)
            val lj = JSONObject()
            for ((k, l) in lines) lj.put(k, l.toJson())
            j.put("lines", lj)
            File(out, "${p.id}.json").writeText(j.toString())
        }
    }
}
