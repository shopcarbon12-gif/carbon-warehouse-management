package com.shopcarbon.gradingai.ar

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Squares the photo up onto the table plane the depth sensor measured: the
 * result is as if shot from straight above, at one exact scale everywhere
 * (`pxPerCm`), turned so the garment stands the way the operator saw it.
 *
 * The plane is the whole calibration. A point on the table at plane
 * coordinates (s, t) is O + s·e1 + t·e2 in camera space; the camera's pinhole
 * model maps it to the photo; that map is a homography, and Android's Canvas
 * draws a bitmap through a perspective matrix natively.
 */
class Rectifier(
    private val plane: Plane,
    private val fx: Double, private val fy: Double, private val cx: Double, private val cy: Double,
    srcW: Int, srcH: Int,
    /** Clockwise turn that makes the camera image upright on the portrait screen. */
    private val rotationDeg: Int,
    /** Footprint kept around the view axis, metres (a far-off corner on a tilted shot is not useful). */
    halfSpanM: Double = 0.9,
    maxPixels: Int = 9_000_000,
) {
    private val n = doubleArrayOf(plane.nx, plane.ny, plane.nz)
    private val o = doubleArrayOf(0.0, 0.0, plane.d / plane.nz)
    private val e1: DoubleArray
    private val e2: DoubleArray
    /** Pixels per metre on the table. */
    val ppm: Double
    val pxPerCm: Double get() = ppm / 100.0
    val outW: Int
    val outH: Int
    private val sMin: Double; private val sMax: Double; private val tMin: Double; private val tMax: Double

    init {
        val a = doubleArrayOf(1 - n[0] * n[0], -n[0] * n[1], -n[0] * n[2])
        val la = sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2])
        e1 = doubleArrayOf(a[0] / la, a[1] / la, a[2] / la)
        e2 = doubleArrayOf(n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0])
        // Where the photo's corners land on the table.
        val ss = mutableListOf<Double>(); val ts = mutableListOf<Double>()
        for ((u, v) in listOf(0.0 to 0.0, srcW.toDouble() to 0.0, 0.0 to srcH.toDouble(), srcW.toDouble() to srcH.toDouble())) {
            val st = imageToPlane(u, v) ?: continue
            ss += st.first; ts += st.second
        }
        sMin = max(ss.minOrNull() ?: -halfSpanM, -halfSpanM); sMax = min(ss.maxOrNull() ?: halfSpanM, halfSpanM)
        tMin = max(ts.minOrNull() ?: -halfSpanM, -halfSpanM); tMax = min(ts.maxOrNull() ?: halfSpanM, halfSpanM)
        // Native scale at the centre of the photo, so the middle is neither blown up nor thrown away.
        var p = fx / plane.axisDistanceM
        val area = (sMax - sMin) * (tMax - tMin) * p * p
        if (area > maxPixels) p *= sqrt(maxPixels / area)
        ppm = p
        val w0 = ceil((sMax - sMin) * ppm).toInt().coerceAtLeast(1)
        val h0 = ceil((tMax - tMin) * ppm).toInt().coerceAtLeast(1)
        if (rotationDeg % 180 == 0) { outW = w0; outH = h0 } else { outW = h0; outH = w0 }
    }

    /** Photo pixel → plane coordinates (metres), or null when the ray misses the table. */
    fun imageToPlane(u: Double, v: Double): Pair<Double, Double>? {
        val r = doubleArrayOf((u - cx) / fx, (v - cy) / fy, 1.0)
        val den = n[0] * r[0] + n[1] * r[1] + n[2] * r[2]
        if (den <= 1e-6) return null
        val lam = plane.d / den
        val q = doubleArrayOf(lam * r[0] - o[0], lam * r[1] - o[1], lam * r[2] - o[2])
        return dot(q, e1) to dot(q, e2)
    }

    /** Plane coordinates (metres) → output pixel. */
    fun planeToOut(s: Double, t: Double): Pair<Double, Double> = when (((rotationDeg % 360) + 360) % 360) {
        90 -> (tMax - t) * ppm to (s - sMin) * ppm
        180 -> (sMax - s) * ppm to (tMax - t) * ppm
        270 -> (t - tMin) * ppm to (sMax - s) * ppm
        else -> (s - sMin) * ppm to (t - tMin) * ppm
    }

    /** A camera-space point (metres), dropped onto the plane → output pixel. */
    fun cameraToOut(x: Double, y: Double, z: Double): Pair<Double, Double> {
        val off = n[0] * x + n[1] * y + n[2] * z - plane.d
        val q = doubleArrayOf(x - off * n[0] - o[0], y - off * n[1] - o[1], z - off * n[2] - o[2])
        return planeToOut(dot(q, e1), dot(q, e2))
    }

    fun render(src: Bitmap): Bitmap {
        val out = Bitmap.createBitmap(outW, outH, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(out)
        canvas.drawColor(Color.BLACK)
        val m = Matrix().apply { setValues(outFromImage()) }
        canvas.drawBitmap(src, m, Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG))
        return out
    }

    /** The 3×3 map photo pixel → output pixel, row-major, normalised. */
    internal fun outFromImage(): FloatArray {
        // T: output pixel → plane (s, t) in metres.
        val k = 1.0 / ppm
        val t: Array<DoubleArray> = when (((rotationDeg % 360) + 360) % 360) {
            90 -> arrayOf(doubleArrayOf(0.0, k, sMin), doubleArrayOf(-k, 0.0, tMax), doubleArrayOf(0.0, 0.0, 1.0))
            180 -> arrayOf(doubleArrayOf(-k, 0.0, sMax), doubleArrayOf(0.0, -k, tMax), doubleArrayOf(0.0, 0.0, 1.0))
            270 -> arrayOf(doubleArrayOf(0.0, -k, sMax), doubleArrayOf(k, 0.0, tMin), doubleArrayOf(0.0, 0.0, 1.0))
            else -> arrayOf(doubleArrayOf(k, 0.0, sMin), doubleArrayOf(0.0, k, tMin), doubleArrayOf(0.0, 0.0, 1.0))
        }
        // B = [e1 e2 O] (plane → camera), K = intrinsics.
        val b = arrayOf(doubleArrayOf(e1[0], e2[0], o[0]), doubleArrayOf(e1[1], e2[1], o[1]), doubleArrayOf(e1[2], e2[2], o[2]))
        val kk = arrayOf(doubleArrayOf(fx, 0.0, cx), doubleArrayOf(0.0, fy, cy), doubleArrayOf(0.0, 0.0, 1.0))
        val imgFromOut = mul(kk, mul(b, t))
        val inv = invert(imgFromOut)
        val s = inv[2][2]
        return FloatArray(9) { (inv[it / 3][it % 3] / s).toFloat() }
    }

    private fun dot(a: DoubleArray, b: DoubleArray) = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

    private fun mul(a: Array<DoubleArray>, b: Array<DoubleArray>) =
        Array(3) { r -> DoubleArray(3) { c -> a[r][0] * b[0][c] + a[r][1] * b[1][c] + a[r][2] * b[2][c] } }

    private fun invert(m: Array<DoubleArray>): Array<DoubleArray> {
        val a = m[0][0]; val b = m[0][1]; val c = m[0][2]
        val d = m[1][0]; val e = m[1][1]; val f = m[1][2]
        val g = m[2][0]; val h = m[2][1]; val i = m[2][2]
        val det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
        return arrayOf(
            doubleArrayOf((e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det),
            doubleArrayOf((f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det),
            doubleArrayOf((d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det),
        )
    }
}
