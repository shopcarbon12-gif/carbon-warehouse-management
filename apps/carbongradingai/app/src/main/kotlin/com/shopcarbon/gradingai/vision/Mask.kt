package com.shopcarbon.gradingai.vision

/** A binary garment mask, 1 byte per pixel (1 = garment). */
class Mask(val w: Int, val h: Int, val data: ByteArray = ByteArray(w * h)) {
    operator fun get(x: Int, y: Int): Boolean = x in 0 until w && y in 0 until h && data[y * w + x].toInt() != 0
    fun area(): Int = data.count { it.toInt() != 0 }

    fun bbox(): IntArray? {
        var l = w; var t = h; var r = -1; var b = -1
        for (y in 0 until h) { val row = y * w; for (x in 0 until w) if (data[row + x].toInt() != 0) { if (x < l) l = x; if (x > r) r = x; if (y < t) t = y; if (y > b) b = y } }
        return if (r < 0) null else intArrayOf(l, t, r, b)
    }

    fun crop(l: Int, t: Int, cw: Int, ch: Int): Mask {
        val out = Mask(cw, ch)
        for (y in 0 until ch) {
            val sy = y + t
            if (sy !in 0 until h) continue
            for (x in 0 until cw) { val sx = x + l; if (sx in 0 until w) out.data[y * cw + x] = data[sy * w + sx] }
        }
        return out
    }

    /** Nearest-neighbour resize (the mask is upscaled from the cut-out's working size). */
    fun resized(nw: Int, nh: Int): Mask {
        val out = Mask(nw, nh)
        for (y in 0 until nh) { val sy = (y * h / nh).coerceIn(0, h - 1); for (x in 0 until nw) out.data[y * nw + x] = data[sy * w + (x * w / nw).coerceIn(0, w - 1)] }
        return out
    }

    /** Which frame edges the garment touches (within `margin` px): "top", "right", "bottom", "left". */
    fun touchedEdges(margin: Int): Set<String> {
        val out = mutableSetOf<String>()
        val minRun = maxOf(2, (w + h) / 200)
        fun countRow(y: Int) = (0 until w).count { this[it, y] }
        fun countCol(x: Int) = (0 until h).count { this[x, it] }
        if ((0..margin).any { countRow(it) >= minRun }) out += "top"
        if ((0..margin).any { countRow(h - 1 - it) >= minRun }) out += "bottom"
        if ((0..margin).any { countCol(it) >= minRun }) out += "left"
        if ((0..margin).any { countCol(w - 1 - it) >= minRun }) out += "right"
        return out
    }

    companion object {
        /** Dilate (hit = 1) or erode (hit = 0) with a square of radius r, separable. */
        fun morph(src: Mask, r: Int, dilate: Boolean): Mask {
            if (r <= 0) return src
            val w = src.w; val h = src.h
            val tmp = ByteArray(w * h)
            val target: Byte = if (dilate) 1 else 0
            for (y in 0 until h) {
                val row = y * w
                for (x in 0 until w) {
                    var v = src.data[row + x]
                    if (v != target) {
                        for (k in maxOf(0, x - r)..minOf(w - 1, x + r)) if (src.data[row + k] == target) { v = target; break }
                    }
                    tmp[row + x] = v
                }
            }
            val out = Mask(w, h)
            for (x in 0 until w) for (y in 0 until h) {
                var v = tmp[y * w + x]
                if (v != target) {
                    for (k in maxOf(0, y - r)..minOf(h - 1, y + r)) if (tmp[k * w + x] == target) { v = target; break }
                }
                out.data[y * w + x] = v
            }
            return out
        }

        /** The largest 4-connected component. */
        fun largest(src: Mask): Mask {
            val w = src.w; val h = src.h
            val label = IntArray(w * h)
            val stack = IntArray(w * h)
            var best = 0; var bestSize = 0; var next = 1
            for (i in 0 until w * h) {
                if (src.data[i].toInt() == 0 || label[i] != 0) continue
                var sp = 0; stack[sp++] = i; label[i] = next; var size = 0
                while (sp > 0) {
                    val p = stack[--sp]; size++
                    val x = p % w; val y = p / w
                    if (x > 0 && src.data[p - 1].toInt() != 0 && label[p - 1] == 0) { label[p - 1] = next; stack[sp++] = p - 1 }
                    if (x < w - 1 && src.data[p + 1].toInt() != 0 && label[p + 1] == 0) { label[p + 1] = next; stack[sp++] = p + 1 }
                    if (y > 0 && src.data[p - w].toInt() != 0 && label[p - w] == 0) { label[p - w] = next; stack[sp++] = p - w }
                    if (y < h - 1 && src.data[p + w].toInt() != 0 && label[p + w] == 0) { label[p + w] = next; stack[sp++] = p + w }
                }
                if (size > bestSize) { bestSize = size; best = next }
                next++
            }
            val out = Mask(w, h)
            if (best == 0) return out
            for (i in 0 until w * h) if (label[i] == best) out.data[i] = 1
            return out
        }

        /** Fill holes: background not reachable from the border becomes garment (prints, logos, shadows inside). */
        fun fillHoles(src: Mask): Mask {
            val w = src.w; val h = src.h
            val outside = BooleanArray(w * h)
            val stack = IntArray(w * h)
            var sp = 0
            fun push(i: Int) { if (!outside[i] && src.data[i].toInt() == 0) { outside[i] = true; stack[sp++] = i } }
            for (x in 0 until w) { push(x); push((h - 1) * w + x) }
            for (y in 0 until h) { push(y * w); push(y * w + w - 1) }
            while (sp > 0) {
                val p = stack[--sp]; val x = p % w; val y = p / w
                if (x > 0) push(p - 1); if (x < w - 1) push(p + 1); if (y > 0) push(p - w); if (y < h - 1) push(p + w)
            }
            val out = Mask(w, h)
            for (i in 0 until w * h) out.data[i] = if (src.data[i].toInt() != 0 || !outside[i]) 1 else 0
            return out
        }

        /** Open then close then largest component then fill — a clean silhouette. */
        fun clean(src: Mask, r: Int): Mask {
            val opened = morph(morph(src, r, dilate = false), r, dilate = true)
            val closed = morph(morph(opened, r, dilate = true), r, dilate = false)
            return fillHoles(largest(closed))
        }
    }
}
