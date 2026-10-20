package com.shopcarbon.gradingai.measure

import com.shopcarbon.gradingai.model.Profile
import com.shopcarbon.gradingai.vision.Mask
import kotlin.math.abs
import kotlin.math.atan
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.roundToInt
import kotlin.math.sin

/** Outline lines, and the points the silhouette could not place with confidence. */
class OutlineResult(val lines: Map<String, MLine>, val unsure: Set<String>)

/**
 * The outline points: every measurement the garment's silhouette can give,
 * placed at once on the phone (no network). The seam-based points it cannot
 * see — shoulder seams, the crotch seam, strap joins — come back from the AI
 * assist a few seconds later and replace these; so do any points listed as
 * `unsure` (an armpit hidden by a sleeve lying against the body, legs lying
 * pressed together). Until then these are a start the operator can drag.
 *
 * Rules from the WMS's lib/size-grading/garment.ts, extended to Size AI's
 * lists (both sleeves and legs, knee, outseam, side length, strap) and
 * hardened on the owner's guide pictures (2026-10-13): the armpit is the step
 * in each side edge where the sleeve joins, not a 20% width jump (short sleeves
 * angled down join gradually); the hem is the body's bottom, not a cuff hanging
 * lower; the waistband is the first full-width row, not a button tab above it.
 *
 * Everything works on an upright mask in the squared-up photo's pixels; the
 * lines are turned back onto the photo at the end.
 */
object Outline {
    /** Test hook: prints the landmarks found. */
    var debug: ((String) -> Unit)? = null

    fun measure(mask: Mask, pxPerCm: Double, profile: Profile): OutlineResult {
        val angle = topEdgeTilt(mask)
        if (abs(angle) < 0.4 * Math.PI / 180) return measureUpright(mask, pxPerCm, profile)
        val (upright, back) = rotateUpright(mask, angle)
        val r = measureUpright(upright, pxPerCm, profile)
        return OutlineResult(r.lines.mapValues { (_, l) -> l.copy(pts = l.pts.map(back)) }, r.unsure)
    }

    /* ─────────────────────────── shape reading ─────────────────────────── */

    private class Shape(val m: Mask, val top: Int, val bottom: Int, val left: Int, val right: Int, val widths: IntArray, val cx: Int) {
        val h get() = bottom - top + 1
        val w get() = right - left + 1
    }

    private fun rowRuns(m: Mask, y: Int): List<IntArray> {
        val out = ArrayList<IntArray>()
        if (y !in 0 until m.h) return out
        var start = -1
        val row = y * m.w
        for (x in 0 until m.w) {
            if (m.data[row + x].toInt() != 0) { if (start < 0) start = x } else if (start >= 0) { out += intArrayOf(start, x - 1); start = -1 }
        }
        if (start >= 0) out += intArrayOf(start, m.w - 1)
        return out
    }

    private fun solidRuns(m: Mask, y: Int, minRun: Int) = rowRuns(m, y).filter { it[1] - it[0] + 1 >= minRun }

    private fun rowExtent(m: Mask, y: Int): IntArray? {
        val rs = rowRuns(m, y)
        return if (rs.isEmpty()) null else intArrayOf(rs.first()[0], rs.last()[1])
    }

    /** The run through x, or the nearest run to it. */
    private fun centerRun(m: Mask, y: Int, x: Int): IntArray? {
        val rs = rowRuns(m, y)
        if (rs.isEmpty()) return null
        return rs.firstOrNull { x in it[0]..it[1] } ?: rs.minBy { minOf(abs(it[0] - x), abs(it[1] - x)) }
    }

    private fun readShape(m: Mask): Shape? {
        var top = -1; var bottom = -1; var left = m.w; var right = -1
        val widths = IntArray(m.h)
        for (y in 0 until m.h) {
            val rs = rowRuns(m, y)
            if (rs.isEmpty()) continue
            if (top < 0) top = y
            bottom = y
            left = minOf(left, rs.first()[0]); right = maxOf(right, rs.last()[1])
            widths[y] = rs.sumOf { it[1] - it[0] + 1 }
        }
        if (top < 0 || bottom <= top) return null
        var sum = 0.0; var n = 0
        for (y in bottom - ((bottom - top) * 0.3).roundToInt()..bottom - ((bottom - top) * 0.05).roundToInt()) {
            centerRun(m, y, (left + right) / 2)?.let { sum += (it[0] + it[1]) / 2.0; n++ }
        }
        return Shape(m, top, bottom, left, right, widths, if (n > 0) (sum / n).roundToInt() else (left + right) / 2)
    }

    private fun colTop(s: Shape, x: Int): Int {
        if (x !in 0 until s.m.w) return -1
        for (y in s.top..s.bottom) if (s.m.data[y * s.m.w + x].toInt() != 0) return y
        return -1
    }

    private fun colBottom(s: Shape, x: Int): Int {
        if (x !in 0 until s.m.w) return -1
        for (y in s.bottom downTo s.top) if (s.m.data[y * s.m.w + x].toInt() != 0) return y
        return -1
    }

    /** The body's own bottom, from its central columns — long sleeves can hang lower than the hem. */
    private fun bodyBottom(s: Shape): Int {
        val half = maxOf(2, (s.w * 0.06).roundToInt())
        val ys = (s.cx - half..s.cx + half).map { colBottom(s, it) }.filter { it > 0 }.sorted()
        return if (ys.isEmpty()) s.bottom else ys[ys.size / 2]
    }

    /** First row that is at least `frac` of the widest row — belt loops, drawstrings and button tabs sit above it. */
    private fun solidTop(s: Shape, frac: Double = 0.5): Int {
        val maxW = (s.top..s.bottom).maxOf { s.widths[it] }
        for (y in s.top..s.bottom) if (s.widths[y] >= maxW * frac) return y
        return s.top
    }

    /**
     * The armpits, scanning up the body from its middle: on each side, the row
     * where the body's edge steps outward because the sleeve joins it. Null on
     * a side where no step is found — a sleeve lying against the body hides it.
     */
    private fun armpits(s: Shape, pxPerCm: Double, bottom: Int): Pair<Int?, Int?> {
        val from = s.top + ((bottom - s.top) * 0.55).roundToInt()
        val to = s.top + ((bottom - s.top) * 0.08).roundToInt()
        // A sleeve adds several centimetres at once; a blouson over a belt adds one or two.
        val jump = maxOf(2.5 * pxPerCm, s.w * 0.02)
        var pl: Int? = null; var pr: Int? = null
        var prev: IntArray? = null
        for (y in from downTo to) {
            val run = centerRun(s.m, y, s.cx) ?: continue
            val p = prev
            if (p != null) {
                // A sleeve stays out all the way up to the shoulder; a belt end or a pocket flap does not.
                val rows = maxOf(3, (5.0 * pxPerCm).roundToInt())
                fun holds(left: Boolean): Boolean {
                    for (k in 1..rows) {
                        val r = centerRun(s.m, y - k, s.cx) ?: return false
                        if (left && p[0] - r[0] < jump * 0.5) return false
                        if (!left && r[1] - p[1] < jump * 0.5) return false
                    }
                    return true
                }
                if (pl == null && p[0] - run[0] > jump && holds(true)) pl = y + 1
                if (pr == null && run[1] - p[1] > jump && holds(false)) pr = y + 1
                if (pl != null && pr != null) break
            }
            // Only the body's edge is followed: once a side has its armpit, that side stops moving the reference.
            prev = intArrayOf(if (pl == null) run[0] else p?.get(0) ?: run[0], if (pr == null) run[1] else p?.get(1) ?: run[1])
        }
        debug?.invoke("armpits from=$from to=$to jump=${"%.1f".format(jump)} -> L=$pl R=$pr")
        return pl to pr
    }

    /**
     * No sleeves: the bottom of the armhole. Down from the top, the width goes
     * shoulders (or straps) → narrower through the armhole scoop → full body
     * width; the armpit is where full width is reached after the narrowest row.
     */
    private fun sleevelessPit(s: Shape, bottom: Int, pxPerCm: Double): Int {
        val bh = bottom - s.top
        val ref = (s.top + (bh * 0.3).roundToInt()..s.top + (bh * 0.5).roundToInt()).map { s.widths[it.coerceIn(s.top, s.bottom)] }.sorted()
        if (ref.isEmpty()) return s.top + (bh * 0.15).roundToInt()
        val body = ref[ref.size / 2]
        val upper = s.top + (bh * 0.02).roundToInt()..s.top + (bh * 0.35).roundToInt()
        val narrow = upper.minByOrNull { s.widths[it] } ?: s.top
        /* Below the narrowest row the side edges sweep outward round the
           armhole, then turn straight down: that turn is the armpit. A flared
           body keeps widening slowly, which is why full width alone is not it. */
        val step = maxOf(2, (0.5 * pxPerCm).roundToInt())
        val hold = maxOf(3, (1.5 * pxPerCm).roundToInt())
        fun straight(y: Int): Boolean {
            val a = centerRun(s.m, y, s.cx) ?: return false
            val b = centerRun(s.m, y + step, s.cx) ?: return false
            return a[0] - b[0] <= step * 0.35 && b[1] - a[1] <= step * 0.35
        }
        for (y in narrow..s.top + (bh * 0.55).roundToInt()) {
            if (s.widths[y] < body * 0.85) continue
            if ((0 until hold step step).all { straight(y + it) }) return y
        }
        for (y in narrow..s.top + (bh * 0.5).roundToInt()) if (s.widths[y] >= body * 0.95) return y
        return narrow
    }

    /** Where the legs separate, or -1 (the split must hold down the legs). */
    private fun crotchY(s: Shape, from: Int): Int {
        val minRun = maxOf(2, (s.m.w * 0.012).roundToInt())
        val minGap = maxOf(3, (s.w * 0.025).roundToInt())
        val need = maxOf(4, (s.h * 0.06).roundToInt())
        for (y in from..s.bottom - need) {
            val rs = solidRuns(s.m, y, minRun)
            if (rs.size < 2) continue
            val gap = rs.zipWithNext().maxOf { (a, b) -> b[0] - a[1] - 1 }
            if (gap < minGap) continue
            var held = 0
            for (k in 1..need) {
                val r2 = solidRuns(s.m, y + k, minRun)
                if (r2.size >= 2 && r2.zipWithNext().maxOf { (a, b) -> b[0] - a[1] - 1 } >= minGap * 0.6) held++
            }
            if (held >= need * 0.7) return y
        }
        return -1
    }

    /** Median run over a few rows — one ragged row cannot set a width. */
    private fun steady(s: Shape, y: Int, span: Int, full: Boolean): IntArray? {
        val out = ArrayList<IntArray>()
        for (yy in y - span..y + span) {
            if (yy < s.top || yy > s.bottom) continue
            (if (full) rowExtent(s.m, yy) else centerRun(s.m, yy, s.cx))?.let { out += it }
        }
        if (out.isEmpty()) return null
        return out.sortedBy { it[1] - it[0] }[out.size / 2]
    }

    private fun bodyWidth(s: Shape, y: Int) = centerRun(s.m, y, s.cx)?.let { it[1] - it[0] + 1 } ?: 0

    /* ─────────────────────────── measuring ─────────────────────────── */

    private fun line(x1: Number, y1: Number, x2: Number, y2: Number) = MLine(listOf(Pt(x1.toFloat(), y1.toFloat()), Pt(x2.toFloat(), y2.toFloat())))
    private fun hline(run: IntArray, y: Int) = line(run[0], y, run[1] + 1, y)

    private fun measureUpright(m: Mask, pxPerCm: Double, profile: Profile): OutlineResult {
        val s = readShape(m) ?: return OutlineResult(emptyMap(), profile.points.map { it.key }.toSet())
        val keys = profile.points.map { it.key }.toSet()
        val out = LinkedHashMap<String, MLine>()
        val unsure = HashSet<String>()
        when (profile.family) {
            "trousers", "shorts" -> legs(s, pxPerCm, keys, out, unsure)
            "skirt" -> skirt(s, pxPerCm, out)
            "onepiece" -> onepiece(s, pxPerCm, out, unsure)
            else -> upper(s, pxPerCm, keys, profile.family == "dress", out, unsure)
        }
        // Bend lines (front rise) get their middle point so the operator can drag it onto the seam's curve.
        for (p in profile.points) if (p.bend) out[p.key]?.let { l ->
            if (l.pts.size == 2) out[p.key] = l.copy(pts = listOf(l.pts[0], Pt((l.pts[0].x + l.pts[1].x) / 2, (l.pts[0].y + l.pts[1].y) / 2), l.pts[1]))
        }
        for (k in keys) if (k !in out) unsure += k
        return OutlineResult(out.filterKeys { it in keys }, unsure.filter { it in keys }.toSet())
    }

    /** Tops, jackets, tanks, camisoles and dresses. */
    private fun upper(s: Shape, pxPerCm: Double, keys: Set<String>, dress: Boolean, out: MutableMap<String, MLine>, unsure: MutableSet<String>) {
        val sleeved = keys.any { it.startsWith("sleeve") || it.startsWith("cuff") }
        val bottom = bodyBottom(s)
        var pit: Int
        var pitL: Int? = null; var pitR: Int? = null
        if (sleeved) {
            val (l, r) = armpits(s, pxPerCm, bottom)
            pitL = l; pitR = r
            pit = listOfNotNull(l, r).maxOrNull() ?: -1
            if (l == null || r == null) unsure += listOf("chest", "waist", "shoulder", "sleeve", "sleeveL", "sleeveR", "cuff", "cuffL", "cuffR")
            // A typical armpit sits about a quarter of the way down the body: a start to drag from.
            if (pit < 0) pit = s.top + ((bottom - s.top) * 0.27).roundToInt()
        } else {
            pit = sleevelessPit(s, bottom, pxPerCm)
            // An armhole that seems to end in the top eighth of the body was not really seen.
            if (pit - s.top < (bottom - s.top) * 0.12) unsure += listOf("chest", "waist")
        }

        val chestY = minOf(bottom, pit + (2.54 * pxPerCm).roundToInt())
        val chest = steady(s, chestY, 1, full = false)
        if (chest != null) out["chest"] = hline(chest, chestY)
        /* The hem where the side seams end: a curved shirt tail narrows in its
           last few centimetres, and its width there is not the hem. */
        val refY = bottom - (8 * pxPerCm).roundToInt()
        val refW = bodyWidth(s, refY)
        var hemY = bottom - maxOf(2, ((bottom - s.top) * 0.015).roundToInt())
        if (refW > 0) for (y in hemY downTo refY) if (bodyWidth(s, y) >= refW * 0.92) { hemY = y; break }
        steady(s, hemY, 2, full = false)?.let { out["hem"] = hline(it, hemY) }

        // Waist: the narrowest body row between the chest line and the hem (dress: the upper middle).
        val bh = bottom - s.top
        val wFrom = if (dress) maxOf(chestY + (2 * pxPerCm).roundToInt(), s.top + (bh * 0.25).roundToInt()) else chestY + (bh * 0.06).roundToInt()
        val wTo = if (dress) s.top + (bh * 0.62).roundToInt() else hemY - (bh * 0.05).roundToInt()
        var wy = -1; var ww = Int.MAX_VALUE; var widest = 0
        for (y in wFrom..wTo) {
            val bw = bodyWidth(s, y)
            if (bw <= 0) continue
            if (bw < ww) { ww = bw; wy = y }
            if (bw > widest) widest = bw
        }
        /* A straight-sided garment has no narrowest point — the "narrowest" row
           is noise, often right under the chest. Standard rule then: halfway
           between the armpit and the hem. */
        if (wy > 0 && widest - ww < maxOf(1.0 * pxPerCm, widest * 0.02)) wy = (pit + hemY) / 2
        /* Narrowest at the very start of the range means the garment only
           widens from the chest down: no real waist was seen. A standard
           position to start from, and the AI assist places it. */
        else if (wy > 0 && wy - wFrom < 2 * pxPerCm) {
            wy = if (dress) pit + ((bottom - pit) * 0.3).roundToInt() else (pit + hemY) / 2
            unsure += "waist"
        }
        if (wy > 0) steady(s, wy, 2, full = false)?.let { out["waist"] = hline(it, wy) }

        if (dress) {
            var hy = -1; var hw = -1
            for (y in maxOf(wy + 1, s.top + (bh * 0.4).roundToInt())..bottom - (bh * 0.08).roundToInt()) {
                val bw = bodyWidth(s, y)
                if (bw > hw) { hw = bw; hy = y }
            }
            if (hy > 0) steady(s, hy, 2, full = false)?.let { out["hip"] = hline(it, hy) }
        }

        // Body length: from the high point of the shoulder (left of the neck) straight down to the hem.
        val hps = highPoint(s, left = true)
        if (hps != null) {
            val b = colBottom(s, hps.first).coerceAtMost(bottom + (s.h * 0.02).roundToInt())
            if (b > hps.second) out["length"] = line(hps.first, hps.second, hps.first, b + 1)
        }

        if (sleeved && chest != null) {
            val ends = HashMap<String, Pt>()
            for (side in listOf("L", "R")) {
                val sidePit = (if (side == "L") pitL else pitR) ?: pit
                val bodyEdge = centerRun(s.m, minOf(bottom, sidePit + 2), s.cx)?.let { if (side == "L") it[0] else it[1] } ?: (if (side == "L") chest[0] else chest[1])
                val sl = sleeve(s, pxPerCm, sidePit, bodyEdge, side) ?: continue
                if ("sleeve$side" in keys) out["sleeve$side"] = line(sl.shoulder.first, sl.shoulder.second, sl.top.first, sl.top.second)
                if ("cuff$side" in keys) out["cuff$side"] = line(sl.top.first, sl.top.second, sl.bottom.first, sl.bottom.second)
                if (side == "L") {
                    if ("sleeve" in keys) out["sleeve"] = line(sl.shoulder.first, sl.shoulder.second, sl.top.first, sl.top.second)
                    if ("cuff" in keys) out["cuff"] = line(sl.top.first, sl.top.second, sl.bottom.first, sl.bottom.second)
                }
                ends[side] = Pt(sl.shoulder.first.toFloat(), sl.shoulder.second.toFloat())
            }
            val l = ends["L"]; val r = ends["R"]
            if (l != null && r != null) out["shoulder"] = MLine(listOf(l, r))
        } else if ("shoulder" in keys) {
            // Sleeveless (tank, vest): across the tops of the shoulders.
            val band = s.top + (1.5 * pxPerCm).roundToInt()
            var l = s.m.w; var r = -1; var yAt = s.top
            for (y in s.top..minOf(band, s.bottom)) rowExtent(s.m, y)?.let { if (it[0] < l) { l = it[0]; yAt = y }; if (it[1] > r) r = it[1] }
            if (r > l) out["shoulder"] = line(l, yAt, r + 1, yAt)
        }
        if ("strap" in keys) strap(s, pxPerCm)?.let { out["strap"] = it }
    }

    /** The topmost point near the neck on one side: where the shoulder seam meets the collar. */
    private fun highPoint(s: Shape, left: Boolean): Pair<Int, Int>? {
        val from = if (left) (s.cx - s.w * 0.28).roundToInt() else s.cx
        val to = if (left) s.cx else (s.cx + s.w * 0.28).roundToInt()
        var best: Pair<Int, Int>? = null
        for (x in from..to) {
            val t = colTop(s, x)
            if (t < 0) continue
            if (best == null || t < best.second || (t == best.second && (if (left) x > best.first else x < best.first))) best = x to t
        }
        return best
    }

    private class Sleeve(val shoulder: Pair<Int, Int>, val top: Pair<Int, Int>, val bottom: Pair<Int, Int>)

    /**
     * One sleeve as it lies: its axis from the armpit to its far end, the cuff
     * as the outline's far edge across that axis (top corner = end of the top
     * fold), and the shoulder point as the bend in the top edge between the
     * neck and the cuff — the AI assist then moves it onto the real armhole seam.
     */
    private fun sleeve(s: Shape, pxPerCm: Double, pit: Int, bodyEdge: Int, side: String): Sleeve? {
        val left = side == "L"
        val pts = ArrayList<IntArray>()
        // A centimetre clear of the body's edge, which drifts a few pixels down the side.
        val margin = maxOf(1.0 * pxPerCm, s.w * 0.012).roundToInt()
        for (y in s.top..s.bottom) {
            val row = y * s.m.w
            val xs = if (left) s.left until bodyEdge - margin else bodyEdge + margin + 1..s.right
            for (x in xs) {
                if (s.m.data[row + x].toInt() == 0) continue
                val edge = x == 0 || x == s.m.w - 1 || y == 0 || y == s.m.h - 1 ||
                    s.m.data[row + x - 1].toInt() == 0 || s.m.data[row + x + 1].toInt() == 0 ||
                    s.m.data[row - s.m.w + x].toInt() == 0 || s.m.data[row + s.m.w + x].toInt() == 0
                if (edge) pts += intArrayOf(x, y)
            }
        }
        if (pts.size < 20) return null
        val ax0 = bodyEdge.toDouble(); val ay0 = pit.toDouble()
        // The sleeve's far end is its outermost point sideways (the farthest point from the armpit is the shoulder).
        val far0 = if (left) pts.minWith(compareBy<IntArray> { it[0] }.thenByDescending { it[1] }) else pts.maxWith(compareBy<IntArray> { it[0] }.thenBy { it[1] })
        /* Only the sleeve itself: the piece beyond the body edge that holds
           that far point. A dress widening below the armpit is another piece. */
        val keep = sleevePiece(s, far0, if (left) bodyEdge - margin else bodyEdge + margin + 1, left)
        pts.retainAll { keep[it[1] * s.m.w + it[0]] }
        if (pts.size < 20) return null
        val far = far0
        var ax = far[0] - ax0; var ay = far[1] - ay0
        val al = hypot(ax, ay).takeIf { it > 1 } ?: return null
        ax /= al; ay /= al
        // Normal pointing up-ish (towards the shoulder).
        var nx = -ay; var ny = ax
        if (ny > 0) { nx = -nx; ny = -ny }
        val proj = { p: IntArray -> (p[0] - ax0) * ax + (p[1] - ay0) * ay }
        val maxP = pts.maxOf(proj)
        val cuffPts = pts.filter { proj(it) >= maxP - 1.2 * pxPerCm }
        val up = { p: IntArray -> p[0] * nx + p[1] * ny }
        val topC = cuffPts.maxBy(up)
        val botC = cuffPts.minBy(up)
        // Shoulder: furthest point of the top edge above the chord high-point → cuff top corner.
        val hps = highPoint(s, left) ?: return null
        val x0 = minOf(hps.first, topC[0]); val x1 = maxOf(hps.first, topC[0])
        var best: Pair<Int, Int>? = null; var bestD = -1.0
        val cdx = (topC[0] - hps.first).toDouble(); val cdy = (topC[1] - hps.second).toDouble()
        val cl = hypot(cdx, cdy).coerceAtLeast(1.0)
        for (x in x0..x1) {
            val t = colTop(s, x)
            if (t < 0) continue
            val d = abs((x - hps.first) * cdy - (t - hps.second) * cdx) / cl
            val above = (t - hps.second) < (x - hps.first) * cdy / (if (cdx == 0.0) 1.0 else cdx)
            if (above && d > bestD) { bestD = d; best = x to t }
        }
        val shoulder = if (best != null && bestD > 0.4 * pxPerCm) best else bodyEdge to colTop(s, bodyEdge).coerceAtLeast(s.top)
        return Sleeve(shoulder, topC[0] to topC[1], botC[0] to botC[1])
    }

    /** The connected garment pixels beyond `edgeX` (left or right of it) that include `seed`. */
    private fun sleevePiece(s: Shape, seed: IntArray, edgeX: Int, left: Boolean): BooleanArray {
        val w = s.m.w; val h = s.m.h
        val seen = BooleanArray(w * h)
        val stack = IntArray(w * h)
        var sp = 0
        fun ok(x: Int, y: Int) = x in 0 until w && y in 0 until h && (if (left) x < edgeX else x >= edgeX) && s.m.data[y * w + x].toInt() != 0
        if (!ok(seed[0], seed[1])) return seen
        seen[seed[1] * w + seed[0]] = true; stack[sp++] = seed[1] * w + seed[0]
        while (sp > 0) {
            val p = stack[--sp]; val x = p % w; val y = p / w
            for ((nx, ny) in arrayOf(x - 1 to y, x + 1 to y, x to y - 1, x to y + 1)) {
                if (!ok(nx, ny)) continue
                val i = ny * w + nx
                if (!seen[i]) { seen[i] = true; stack[sp++] = i }
            }
        }
        return seen
    }

    /** Camisole strap on the left: from where it joins the body's top edge up to the top of its fold. */
    private fun strap(s: Shape, pxPerCm: Double): MLine? {
        val maxW = (s.top..s.bottom).maxOf { s.widths[it] }
        var bodyTop = -1
        for (y in s.top..s.bottom) if (s.widths[y] >= maxW * 0.6) { bodyTop = y; break }
        if (bodyTop <= s.top + pxPerCm) return null
        var x = -1; var topY = bodyTop
        for (y in bodyTop - 1 downTo s.top) {
            val r = rowRuns(s.m, y).firstOrNull { (it[0] + it[1]) / 2 < s.cx } ?: break
            x = (r[0] + r[1]) / 2; topY = y
        }
        if (x < 0) return null
        val baseX = rowRuns(s.m, bodyTop - 1).firstOrNull { (it[0] + it[1]) / 2 < s.cx }?.let { (it[0] + it[1]) / 2 } ?: x
        return line(baseX, bodyTop, x, topY)
    }

    private fun skirt(s: Shape, pxPerCm: Double, out: MutableMap<String, MLine>) {
        val top = solidTop(s)
        val waistY = top + maxOf(1, (0.5 * pxPerCm).roundToInt())
        val waist = steady(s, waistY, 2, full = true) ?: return
        out["waist"] = hline(waist, waistY)
        val hipY = minOf(s.bottom - 2, top + (18 * pxPerCm).roundToInt())
        steady(s, hipY, 2, full = true)?.let { out["hip"] = hline(it, hipY) }
        val hemY = s.bottom - maxOf(2, (s.h * 0.015).roundToInt())
        val hem = steady(s, hemY, 2, full = true)
        if (hem != null) {
            out["hem"] = hline(hem, hemY)
            out["sideLength"] = line(waist[0], top, hem[0], s.bottom + 1)
        }
        val cx = (waist[0] + waist[1]) / 2
        out["length"] = line(cx, colTop(s, cx).coerceAtLeast(top), cx, colBottom(s, cx) + 1)
    }

    private fun onepiece(s: Shape, pxPerCm: Double, out: MutableMap<String, MLine>, unsure: MutableSet<String>) {
        val crotch = crotchY(s, s.top + (s.h * 0.45).roundToInt())
        val bottom = if (crotch > 0) crotch else bodyBottom(s)
        val (l, r) = armpits(s, pxPerCm, bottom)
        // Both armpits or neither: one "armpit" alone is usually a belt knot or a pocket.
        var pit = if (l != null && r != null) maxOf(l, r) else -1
        if (pit < 0) { pit = sleevelessPit(s, bottom, pxPerCm); unsure += listOf("chest", "waist", "length") }
        val chestY = minOf(bottom, pit + (2.54 * pxPerCm).roundToInt())
        steady(s, chestY, 1, full = false)?.let { out["chest"] = hline(it, chestY) }
        val wTo = if (crotch > 0) crotch - (4 * pxPerCm).roundToInt() else s.top + (s.h * 0.6).roundToInt()
        var wy = -1; var ww = Int.MAX_VALUE
        for (y in chestY + (3 * pxPerCm).roundToInt()..wTo) { val bw = bodyWidth(s, y); if (bw in 1 until ww) { ww = bw; wy = y } }
        if (wy > 0) steady(s, wy, 2, full = false)?.let { out["waist"] = hline(it, wy) }
        var hy = -1; var hw = -1
        val hTo = if (crotch > 0) crotch - 2 else s.top + (s.h * 0.75).roundToInt()
        for (y in (if (wy > 0) wy + 1 else chestY + 1)..hTo) { val bw = bodyWidth(s, y); if (bw > hw) { hw = bw; hy = y } }
        if (hy > 0) steady(s, hy, 2, full = false)?.let { out["hip"] = hline(it, hy) }
        val hps = highPoint(s, left = true)
        if (hps != null) {
            val end = if (crotch > 0) crotch else bottom
            out["length"] = line(hps.first, hps.second, hps.first, end)
            if (crotch < 0) unsure += "length"
        }
        if (crotch > 0) leg(s, pxPerCm, crotch, "L", null)?.let { out["inseam"] = it.inseam } else unsure += "inseam"
    }

    private class Leg(val inseam: MLine, val outseam: MLine?, val opening: MLine, val thigh: MLine?, val knee: MLine?)

    private fun legs(s: Shape, pxPerCm: Double, keys: Set<String>, out: MutableMap<String, MLine>, unsure: MutableSet<String>) {
        val top = solidTop(s)
        val waistY = top + maxOf(1, (0.5 * pxPerCm).roundToInt())
        val waist = steady(s, waistY, 2, full = true) ?: return
        out["waist"] = hline(waist, waistY)
        if ("hip" in keys) {
            val hipY = minOf(s.bottom - 2, top + (18 * pxPerCm).roundToInt())
            steady(s, hipY, 2, full = true)?.let { out["hip"] = hline(it, hipY) }
        }
        var crotch = crotchY(s, top + (s.h * 0.15).roundToInt())
        if (crotch < 0) {
            // Legs lying pressed together all the way: no gap to find. A typical crotch height; the AI places the real one.
            crotch = top + ((s.bottom - top) * (if ("kneeL" in keys) 0.3 else 0.5)).roundToInt()
            unsure += listOf("rise", "inseamL", "inseamR", "thighL", "thighR", "kneeL", "kneeR")
        }
        val minRun = maxOf(2, (s.m.w * 0.012).roundToInt())
        val at = solidRuns(s.m, crotch, minRun)
        val crotchX = if (at.size >= 2) (at[0][1] + at[1][0]) / 2 else (waist[0] + waist[1]) / 2
        val riseTop = colTop(s, crotchX).coerceAtLeast(top)
        out["rise"] = line(crotchX, riseTop, crotchX, crotch)
        for (side in listOf("L", "R")) {
            val l = leg(s, pxPerCm, crotch, side, waist) ?: continue
            out["inseam$side"] = l.inseam
            l.outseam?.let { out["outseam$side"] = it }
            out["legOpening$side"] = l.opening
            l.thigh?.let { out["thigh$side"] = it }
            l.knee?.let { out["knee$side"] = it }
        }
    }

    /**
     * One leg, measured square across itself (see garment.ts legAxis): its
     * centre line through the middle of its runs; the hem a centimetre above
     * where that line leaves the leg; thigh 2.5 cm below the crotch; knee
     * halfway down the inseam. Legs lying together are split at the crotch's x.
     */
    private fun leg(s: Shape, pxPerCm: Double, crotch: Int, side: String, waist: IntArray?): Leg? {
        val m = s.m
        val minRun = maxOf(2, (m.w * 0.012).roundToInt())
        val at = solidRuns(m, crotch, minRun)
        val crotchX = if (at.size >= 2) (at[0][1] + at[1][0]) / 2.0 else waist?.let { (it[0] + it[1]) / 2.0 } ?: s.cx.toDouble()
        val left = side == "L"
        fun legRun(y: Int): IntArray? {
            val rs = solidRuns(m, y, minRun).flatMap { r ->
                // A run straddling the split is two legs lying together.
                if (r[0] < crotchX && r[1] > crotchX) listOf(intArrayOf(r[0], crotchX.toInt()), intArrayOf(crotchX.toInt() + 1, r[1])) else listOf(r)
            }
            return if (left) rs.lastOrNull { (it[0] + it[1]) / 2.0 < crotchX } else rs.firstOrNull { (it[0] + it[1]) / 2.0 > crotchX }
        }
        val ys = ArrayList<Double>(); val xs = ArrayList<Double>()
        val span = s.bottom - crotch
        var y = crotch + (span * 0.08).roundToInt()
        while (y <= s.bottom - span * 0.05) { legRun(y)?.let { ys += y.toDouble(); xs += (it[0] + it[1]) / 2.0 }; y += 2 }
        if (ys.size < 8) return null
        val my = ys.average(); val mx = xs.average()
        var sxy = 0.0; var syy = 0.0
        for (i in ys.indices) { sxy += (ys[i] - my) * (xs[i] - mx); syy += (ys[i] - my) * (ys[i] - my) }
        val b = if (syy > 0) sxy / syy else 0.0; val a = mx - b * my
        val dn = hypot(b, 1.0)
        val dx = b / dn; val dy = 1 / dn
        val nx = dy; val ny = -dx
        fun on(x: Double, yy: Double): Boolean {
            if (!m[x.roundToInt(), yy.roundToInt()]) return false
            // Stay on this leg's side of the split.
            return if (left) x <= crotchX + 1 || yy < crotch else x >= crotchX - 1 || yy < crotch
        }
        fun across(cx: Double, cy: Double): MLine {
            fun edge(sgn: Int): Double {
                var t = 0.0; var gap = 0; var last = 0.0
                while (t < m.w) { t += 0.5; if (on(cx + nx * t * sgn, cy + ny * t * sgn)) { last = t; gap = 0 } else if (++gap > 4) break }
                return last
            }
            val r = edge(1); val l = edge(-1)
            return line(cx - nx * l, cy - ny * l, cx + nx * r, cy + ny * r)
        }
        fun centre(yy: Double) = (a + b * yy) to yy
        val start = centre(crotch + span * 0.5)
        var end = start; var gap = 0
        val maxGap = maxOf(4, (1.5 * pxPerCm).roundToInt())
        var t = 1
        while (t < 2 * m.h && gap <= maxGap) {
            val px = start.first + dx * t; val py = start.second + dy * t
            if (on(px, py)) { end = px to py; gap = 0 } else gap++
            t++
        }
        val backPx = maxOf(2.0, pxPerCm)
        /* The opening runs along the hem, corner to corner. Legs lying splayed
           (shorts above all) have a SLANTED hem: a line square across the leg
           near the low inner corner runs off the bottom edge long before the
           outer side, which read John Denim Shorts' 23 cm openings as 10–13 cm
           (owner's first Note10+ scan, 2026-10-20). The hem's two corners are
           the leg's extreme points along the two diagonals of its own axis;
           square-across stays the fallback. */
        val opening = hemCorners(m, crotch, span, dx, dy, nx, ny, ::on)
            ?: across(end.first - dx * backPx, end.second - dy * backPx)
        val (h0, h1) = opening.pts
        val inner = if (abs(h0.x - crotchX) < abs(h1.x - crotchX)) h0 else h1
        val outer = if (inner === h0) h1 else h0
        val inX = if (at.size >= 2) (if (left) at[0][1] + 1 else at[1][0]).toFloat() else crotchX.toFloat()
        val inseam = MLine(listOf(Pt(inX, crotch.toFloat()), inner))
        val outseam = waist?.let { w -> MLine(listOf(Pt((if (left) w[0] else w[1] + 1).toFloat(), solidTop(s).toFloat()), outer)) }
        val thighY = crotch + 2.54 * pxPerCm
        val thighC = centre(thighY).let { c -> if (on(c.first, c.second)) c else legRun(thighY.roundToInt())?.let { r -> (r[0] + r[1]) / 2.0 to thighY } }
        val thigh = thighC?.let { across(it.first, it.second) }
        val kneeY = crotch + (inner.y - crotch) * 0.5
        val kneeC = centre(kneeY)
        val knee = if (on(kneeC.first, kneeC.second)) across(kneeC.first, kneeC.second) else null
        return Leg(inseam, outseam, opening, thigh, knee)
    }

    /**
     * The two bottom corners of one leg: among its pixels in the lower 60% of
     * the leg, the ones furthest along (axis + normal) and (axis − normal).
     * Null when the leg is too small to trust (the caller falls back).
     */
    private fun hemCorners(
        m: Mask, crotch: Int, span: Int, dx: Double, dy: Double, nx: Double, ny: Double,
        on: (Double, Double) -> Boolean,
    ): MLine? {
        val from = crotch + (span * 0.4).roundToInt()
        var bestA = Double.NEGATIVE_INFINITY; var bestB = Double.NEGATIVE_INFINITY
        var a: Pt? = null; var b: Pt? = null; var n = 0
        for (y in from until m.h) for (x in 0 until m.w) {
            if (!m[x, y] || !on(x.toDouble(), y.toDouble())) continue
            n++
            val along = x * dx + y * dy; val side = x * nx + y * ny
            if (along + side > bestA) { bestA = along + side; a = Pt(x.toFloat(), y.toFloat()) }
            if (along - side > bestB) { bestB = along - side; b = Pt(x.toFloat(), y.toFloat()) }
        }
        if (a == null || b == null || n < 50) return null
        return MLine(listOf(b, a))
    }

    /* ─────────────────────────── tilt ─────────────────────────── */

    /** How far the top edge is from level, radians (see garment.ts topEdgeTilt). */
    fun topEdgeTilt(m: Mask): Double {
        val bb = m.bbox() ?: return 0.0
        val left = bb[0]; val top = bb[1]; val right = bb[2]; val bottom = bb[3]
        if (right - left < 20 || bottom - top < 20) return 0.0
        val h = bottom - top + 1
        val span = right - left
        val cols = ArrayList<DoubleArray>()
        for (x in (left + span * 0.05).roundToInt()..(right - span * 0.05).roundToInt()) {
            for (y in top..bottom) if (m.data[y * m.w + x].toInt() != 0) { cols += doubleArrayOf(x.toDouble(), y.toDouble()); break }
        }
        var pts = cols.filter { it[1] <= top + h * 0.12 }
        if (pts.size < 10) return 0.0
        fun fit(q: List<DoubleArray>): DoubleArray {
            var sx = 0.0; var sy = 0.0; var sxx = 0.0; var sxy = 0.0
            for (p in q) { sx += p[0]; sy += p[1]; sxx += p[0] * p[0]; sxy += p[0] * p[1] }
            val n = q.size; val d = n * sxx - sx * sx
            val b = if (d != 0.0) (n * sxy - sx * sy) / d else 0.0
            return doubleArrayOf((sy - b * sx) / n, b)
        }
        var ln = fit(pts)
        repeat(3) {
            val near = cols.filter { abs(it[1] - (ln[0] + ln[1] * it[0])) <= maxOf(3.0, h * 0.03) }
            if (near.size < 10) return@repeat
            val resid = near.map { abs(it[1] - (ln[0] + ln[1] * it[0])) }
            val cut = resid.sorted()[(resid.size * 0.7).toInt()]
            pts = near.filterIndexed { i, _ -> resid[i] <= maxOf(1.5, cut) }
            if (pts.size < 10) return@repeat
            ln = fit(pts)
        }
        // Only a top edge that spans both shoulders (or the waistband) says anything about tilt — a collar alone does not.
        if (pts.isEmpty() || pts.maxOf { it[0] } - pts.minOf { it[0] } < span * 0.45) return 0.0
        val angle = atan(ln[1])
        return if (abs(angle) > 25 * Math.PI / 180) 0.0 else angle
    }

    private fun rotateUpright(m: Mask, angle: Double): Pair<Mask, (Pt) -> Pt> {
        val bb = m.bbox()!!
        val cx = (bb[0] + bb[2]) / 2.0; val cy = (bb[1] + bb[3]) / 2.0
        val d = ceil(hypot((bb[2] - bb[0] + 1).toDouble(), (bb[3] - bb[1] + 1).toDouble())).toInt() + 8
        val oc = d / 2.0
        val c = cos(angle); val sn = sin(angle)
        val back = { p: Pt ->
            val qx = p.x - oc; val qy = p.y - oc
            Pt((c * qx - sn * qy + cx).toFloat(), (sn * qx + c * qy + cy).toFloat())
        }
        val out = Mask(d, d)
        for (y in 0 until d) for (x in 0 until d) {
            val p = back(Pt(x.toFloat(), y.toFloat()))
            val sx = p.x.roundToInt(); val sy = p.y.roundToInt()
            if (sx < 0 || sy < 0 || sx >= m.w || sy >= m.h) continue
            if (m.data[sy * m.w + sx].toInt() != 0) out.data[y * d + x] = 1
        }
        return out to back
    }
}
