package com.shopcarbon.gradingai.vision

import android.graphics.Bitmap
import android.graphics.Color
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.segmentation.subject.SubjectSegmentation
import com.google.mlkit.vision.segmentation.subject.SubjectSegmenterOptions
import java.util.concurrent.TimeUnit
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * The garment's cut-out, on the phone.
 *
 * First choice is ML Kit's subject segmentation (on-device, Google Play
 * services). On a plain table it separates a garment cleanly, including dark
 * on dark. When it finds nothing sensible — or Play services has not
 * downloaded its model yet — a colour cut-out takes over: the table colour is
 * read from the photo's border and everything far enough from it is garment.
 */
object Segmenter {
    private val client by lazy {
        SubjectSegmentation.getClient(SubjectSegmenterOptions.Builder().enableForegroundConfidenceMask().build())
    }

    data class Cut(val mask: Mask, val method: String)

    /** Blocking; call off the main thread. `work` is the long side the cut-out runs at. */
    fun cut(src: Bitmap, work: Int = 1024): Cut? {
        val scale = minOf(1f, work.toFloat() / max(src.width, src.height))
        val small = if (scale < 1f) Bitmap.createScaledBitmap(src, (src.width * scale).roundToInt(), (src.height * scale).roundToInt(), true) else src
        val ml = runCatching { mlKit(small) }.getOrNull()
        val pick = ml?.takeIf { sane(it) }?.let { Cut(it, "mlkit") } ?: colour(small)?.let { Cut(it, "colour") } ?: return null
        val r = maxOf(1, (max(small.width, small.height) / 300f).roundToInt())
        val clean = Mask.clean(pick.mask, r)
        return Cut(if (small === src) clean else clean.resized(src.width, src.height), pick.method)
    }

    private fun mlKit(bmp: Bitmap): Mask? {
        val res = Tasks.await(client.process(InputImage.fromBitmap(bmp, 0)), 8, TimeUnit.SECONDS)
        val buf = res.foregroundConfidenceMask ?: return null
        buf.rewind()
        val m = Mask(bmp.width, bmp.height)
        for (i in 0 until bmp.width * bmp.height) if (buf.get() >= 0.5f) m.data[i] = 1
        return m
    }

    /** A real garment: one main piece, 3–92% of the frame. */
    private fun sane(m: Mask): Boolean {
        val total = m.w * m.h
        val a = m.area()
        if (a < total * 0.03 || a > total * 0.92) return false
        return Mask.largest(m).area() > a * 0.8
    }

    /**
     * Table colour from the outer band, a distance threshold by Otsu's method,
     * and the biggest piece. Good enough on the darker surface the owner uses
     * for white items, and on light tables for dark ones.
     */
    fun colour(bmp: Bitmap): Mask? {
        val w = bmp.width; val h = bmp.height
        val px = IntArray(w * h)
        bmp.getPixels(px, 0, w, 0, 0, w, h)
        val band = max(2, minOf(w, h) / 40)
        val rs = ArrayList<Int>(); val gs = ArrayList<Int>(); val bs = ArrayList<Int>()
        for (y in 0 until h) for (x in 0 until w) {
            if (x >= band && x < w - band && y >= band && y < h - band) continue
            if ((x + y) % 3 != 0) continue
            val c = px[y * w + x]; rs += Color.red(c); gs += Color.green(c); bs += Color.blue(c)
        }
        if (rs.isEmpty()) return null
        rs.sort(); gs.sort(); bs.sort()
        val br = rs[rs.size / 2]; val bg = gs[gs.size / 2]; val bb = bs[bs.size / 2]
        val dist = IntArray(w * h)
        val hist = IntArray(256)
        for (i in 0 until w * h) {
            val c = px[i]
            val dr = Color.red(c) - br; val dg = Color.green(c) - bg; val db = Color.blue(c) - bb
            val d = minOf(255, sqrt((dr * dr + dg * dg + db * db).toDouble()).toInt())
            dist[i] = d; hist[d]++
        }
        val t = maxOf(28, otsu(hist, w * h))
        val m = Mask(w, h)
        for (i in 0 until w * h) if (dist[i] > t) m.data[i] = 1
        return if (m.area() < w * h * 0.02) null else m
    }

    private fun otsu(hist: IntArray, total: Int): Int {
        var sum = 0.0
        for (i in 0 until 256) sum += i * hist[i].toDouble()
        var sumB = 0.0; var wB = 0; var best = 0.0; var thr = 0
        for (i in 0 until 256) {
            wB += hist[i]; if (wB == 0) continue
            val wF = total - wB; if (wF == 0) break
            sumB += i * hist[i].toDouble()
            val mB = sumB / wB; val mF = (sum - sumB) / wF
            val between = wB.toDouble() * wF * (mB - mF) * (mB - mF)
            if (between > best) { best = between; thr = i }
        }
        return thr
    }

    /** Live coverage check on a small preview frame: which edges the garment touches, null = no garment. */
    fun coverage(preview: Bitmap): Set<String>? {
        val m = runCatching { mlKit(preview) }.getOrNull()?.takeIf { sane(it) } ?: colour(preview) ?: return null
        val big = Mask.largest(m)
        if (big.area() < big.w * big.h * 0.03) return null
        return big.touchedEdges(maxOf(1, minOf(preview.width, preview.height) / 60))
    }
}
