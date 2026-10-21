package com.shopcarbon.gradingai.ar

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.sqrt
import kotlin.random.Random

/**
 * One depth reading from the time-of-flight sensor, aligned with the camera
 * image: millimetres per pixel (0 = no reading) and ARCore's confidence
 * (0–255), plus the pinhole intrinsics scaled to the depth image.
 */
class DepthSnapshot(
    val w: Int,
    val h: Int,
    val mm: ShortArray,
    val conf: ByteArray,
    val fx: Float,
    val fy: Float,
    val cx: Float,
    val cy: Float,
    /**
     * How much older the depth image is than the camera frame it was read with
     * (ARCore frame timestamp − depth image timestamp). ARCore's raw depth can
     * carry an earlier depth frame reprojected forward; this is how stale it is.
     */
    val ageMs: Double = 0.0,
) {
    /** Share of depth pixels with a reading and confidence ≥ [minConf] (0–1). */
    fun highConfFrac(minConf: Int): Double {
        var ok = 0
        for (i in mm.indices) if ((mm[i].toInt() and 0xffff) > 0 && (conf[i].toInt() and 0xff) >= minConf) ok++
        return if (mm.isEmpty()) 0.0 else ok.toDouble() / mm.size
    }

    /** Camera-space points (metres; x right, y down, z forward), every `step` pixels, confidence ≥ minConf. */
    fun points(step: Int = 1, minConf: Int = 128, maxPoints: Int = 60_000): Points {
        var n = 0
        val cap = minOf(maxPoints, (w / step + 1) * (h / step + 1))
        val xs = FloatArray(cap); val ys = FloatArray(cap); val zs = FloatArray(cap)
        loop@ for (v in 0 until h step step) for (u in 0 until w step step) {
            val i = v * w + u
            val z = (mm[i].toInt() and 0xffff) / 1000f
            if (z <= 0.15f || z > 4f) continue
            if ((conf[i].toInt() and 0xff) < minConf) continue
            if (n >= cap) break@loop
            xs[n] = (u - cx) / fx * z; ys[n] = (v - cy) / fy * z; zs[n] = z
            n++
        }
        return Points(xs, ys, zs, n)
    }
}

class Points(val x: FloatArray, val y: FloatArray, val z: FloatArray, val n: Int)

/**
 * The table, as a plane in camera space: n·p = d with n pointing away from the
 * camera (n.z > 0) and d the perpendicular distance in metres.
 */
data class Plane(val nx: Double, val ny: Double, val nz: Double, val d: Double, val inlierFrac: Double, val rmsMm: Double, val count: Int) {
    /** Angle between the camera's view axis and straight down onto the table. */
    val tiltDeg: Double get() = acos(nz.coerceIn(-1.0, 1.0)) * 180.0 / PI
    /** Distance from the camera to the table along the view axis. */
    val axisDistanceM: Double get() = d / nz
    fun signedHeight(x: Double, y: Double, z: Double): Double = d - (nx * x + ny * y + nz * z)
}

object PlaneFit {
    /**
     * RANSAC for the dominant flat surface, then a least-squares refit on its
     * inliers. A garment lying on the table is within a centimetre or two of the
     * table, so the tolerance keeps both as "the surface" and the refit is not
     * pulled by the phone's edge of the table or the floor beyond it.
     */
    fun fit(p: Points, iterations: Int = 160, tolM: Double = 0.010, seed: Int = 7): Plane? {
        if (p.n < 200) return null
        val rnd = Random(seed)
        var best = 0
        var bn = DoubleArray(3); var bd = 0.0
        val sample = minOf(p.n, 4000)
        val idx = IntArray(sample) { if (p.n <= sample) it else rnd.nextInt(p.n) }
        repeat(iterations) {
            val a = idx[rnd.nextInt(sample)]; val b = idx[rnd.nextInt(sample)]; val c = idx[rnd.nextInt(sample)]
            val ux = (p.x[b] - p.x[a]).toDouble(); val uy = (p.y[b] - p.y[a]).toDouble(); val uz = (p.z[b] - p.z[a]).toDouble()
            val vx = (p.x[c] - p.x[a]).toDouble(); val vy = (p.y[c] - p.y[a]).toDouble(); val vz = (p.z[c] - p.z[a]).toDouble()
            var nx = uy * vz - uz * vy; var ny = uz * vx - ux * vz; var nz = ux * vy - uy * vx
            val len = sqrt(nx * nx + ny * ny + nz * nz)
            if (len < 1e-9) return@repeat
            nx /= len; ny /= len; nz /= len
            if (nz < 0) { nx = -nx; ny = -ny; nz = -nz }
            if (nz < 0.5) return@repeat // more than 60° off: not the table under the phone
            val d = nx * p.x[a] + ny * p.y[a] + nz * p.z[a]
            var count = 0
            for (k in idx) if (abs(nx * p.x[k] + ny * p.y[k] + nz * p.z[k] - d) < tolM) count++
            if (count > best) { best = count; bn = doubleArrayOf(nx, ny, nz); bd = d }
        }
        if (best < 100) return null
        // Refit z = a·x + b·y + c on every inlier (the plane is roughly facing the camera).
        var sxx = 0.0; var sxy = 0.0; var sx = 0.0; var syy = 0.0; var sy = 0.0; var sxz = 0.0; var syz = 0.0; var sz = 0.0; var m = 0
        for (k in 0 until p.n) {
            val x = p.x[k].toDouble(); val y = p.y[k].toDouble(); val z = p.z[k].toDouble()
            if (abs(bn[0] * x + bn[1] * y + bn[2] * z - bd) >= tolM) continue
            sxx += x * x; sxy += x * y; sx += x; syy += y * y; sy += y; sxz += x * z; syz += y * z; sz += z; m++
        }
        val sol = solve3(
            arrayOf(doubleArrayOf(sxx, sxy, sx), doubleArrayOf(sxy, syy, sy), doubleArrayOf(sx, sy, m.toDouble())),
            doubleArrayOf(sxz, syz, sz),
        ) ?: return null
        val (a, b, c) = Triple(sol[0], sol[1], sol[2])
        val norm = sqrt(a * a + b * b + 1)
        val plane = Plane(-a / norm, -b / norm, 1 / norm, c / norm, 0.0, 0.0, m)
        var sq = 0.0; var inl = 0
        for (k in 0 until p.n) {
            val r = plane.signedHeight(p.x[k].toDouble(), p.y[k].toDouble(), p.z[k].toDouble())
            if (abs(r) < tolM) { sq += r * r; inl++ }
        }
        return plane.copy(inlierFrac = inl.toDouble() / p.n, rmsMm = if (inl > 0) sqrt(sq / inl) * 1000 else 0.0, count = inl)
    }

    private fun solve3(a: Array<DoubleArray>, b: DoubleArray): DoubleArray? {
        val m = Array(3) { r -> doubleArrayOf(a[r][0], a[r][1], a[r][2], b[r]) }
        for (col in 0 until 3) {
            var piv = col
            for (r in col + 1 until 3) if (abs(m[r][col]) > abs(m[piv][col])) piv = r
            if (abs(m[piv][col]) < 1e-12) return null
            val t = m[col]; m[col] = m[piv]; m[piv] = t
            for (r in 0 until 3) if (r != col) {
                val f = m[r][col] / m[col][col]
                for (k in col until 4) m[r][k] -= f * m[col][k]
            }
        }
        return DoubleArray(3) { m[it][3] / m[it][it] }
    }
}
