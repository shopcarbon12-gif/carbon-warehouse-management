package com.shopcarbon.gradingai

import com.shopcarbon.gradingai.ar.Plane
import com.shopcarbon.gradingai.ar.PlaneFit
import com.shopcarbon.gradingai.ar.Points
import com.shopcarbon.gradingai.ar.Rectifier
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.random.Random

/**
 * The scale chain on a synthetic, tilted table: the plane fit must find the
 * table among garment bumps and outliers, and a 50 cm line on the table must
 * come out 50 cm in the squared-up picture whichever way it points.
 */
class RectifierTest {
    private val fx = 1500.0; private val fy = 1500.0; private val cx = 960.0; private val cy = 540.0
    private val tilt = Math.toRadians(6.0); private val roll = Math.toRadians(3.0)
    private val n: DoubleArray = run {
        val v = doubleArrayOf(sin(roll), -sin(tilt), cos(tilt) * cos(roll))
        val l = sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]); doubleArrayOf(v[0] / l, v[1] / l, v[2] / l)
    }
    private val d = 0.92
    private val truth = Plane(n[0], n[1], n[2], d, 1.0, 0.0, 0)

    private fun project(p: DoubleArray) = doubleArrayOf(fx * p[0] / p[2] + cx, fy * p[1] / p[2] + cy)

    /** A point on the table under image pixel (u, v), raised by h metres. */
    private fun tableUnder(u: Double, v: Double, h: Double = 0.0): DoubleArray {
        val r = doubleArrayOf((u - cx) / fx, (v - cy) / fy, 1.0)
        val lam = (d - h) / (n[0] * r[0] + n[1] * r[1] + n[2] * r[2])
        return doubleArrayOf(lam * r[0], lam * r[1], lam * r[2])
    }

    @Test fun planeFitFindsTheTable() {
        val rnd = Random(3)
        val xs = ArrayList<Float>(); val ys = ArrayList<Float>(); val zs = ArrayList<Float>()
        for (i in 0 until 12000) {
            val u = rnd.nextDouble(0.0, 1920.0); val v = rnd.nextDouble(0.0, 1080.0)
            val garment = u in 600.0..1300.0 && v in 250.0..800.0
            val outlier = rnd.nextDouble() < 0.12
            val h = if (garment) 0.012 else 0.0
            val p = if (outlier) tableUnder(u, v, rnd.nextDouble(-0.4, 0.3)) else tableUnder(u, v, h + rnd.nextDouble(-0.003, 0.003))
            xs += p[0].toFloat(); ys += p[1].toFloat(); zs += p[2].toFloat()
        }
        val fit = PlaneFit.fit(Points(xs.toFloatArray(), ys.toFloatArray(), zs.toFloatArray(), xs.size))
        assertNotNull(fit)
        val dot = fit!!.nx * n[0] + fit.ny * n[1] + fit.nz * n[2]
        assertEquals("normal", 1.0, dot, 2e-4)
        // The 1 cm garment and noise may pull the fit a few mm; the scale error is d'/d.
        assertEquals("distance", d, fit.d, 0.008)
        println("fit d=${fit.d} tilt=${fit.tiltDeg} inliers=${fit.inlierFrac} rms=${fit.rmsMm} mm")
    }

    @Test fun fiftyCentimetresStayFifty() {
        for (rot in listOf(0, 90, 180, 270)) {
            val r = Rectifier(truth, fx, fy, cx, cy, 1920, 1080, rot)
            val m = r.outFromImage()
            fun viaMatrix(u: Double, v: Double): Pair<Double, Double> {
                val w = m[6] * u + m[7] * v + m[8]
                return (m[0] * u + m[1] * v + m[2]) / w to (m[3] * u + m[4] * v + m[5]) / w
            }
            val rnd = Random(rot)
            repeat(40) {
                // A 50 cm segment on the table, anywhere, any direction.
                val a = tableUnder(rnd.nextDouble(300.0, 1600.0), rnd.nextDouble(150.0, 900.0))
                val ang = rnd.nextDouble(0.0, Math.PI)
                val e1 = doubleArrayOf(1 - n[0] * n[0], -n[0] * n[1], -n[0] * n[2]).let { v -> val l = sqrt(v.sumOf { it * it }); DoubleArray(3) { v[it] / l } }
                val e2 = doubleArrayOf(n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0])
                val b = DoubleArray(3) { a[it] + 0.5 * (cos(ang) * e1[it] + sin(ang) * e2[it]) }
                val pa = project(a); val pb = project(b)
                val oa = viaMatrix(pa[0], pa[1]); val ob = viaMatrix(pb[0], pb[1])
                val cm = hypot(ob.first - oa.first, ob.second - oa.second) / r.pxPerCm
                assertEquals("rot $rot", 50.0, cm, 0.02)
                val qa = r.cameraToOut(a[0], a[1], a[2]); val qb = r.cameraToOut(b[0], b[1], b[2])
                assertEquals("cameraToOut rot $rot", 50.0, hypot(qb.first - qa.first, qb.second - qa.second) / r.pxPerCm, 0.02)
            }
            println("rot $rot: out ${r.outW}×${r.outH} at ${"%.2f".format(r.pxPerCm)} px/cm")
        }
    }

    @Test fun garmentHeightCorrection() {
        // A 50 cm line lying 1.2 cm above the table reads long at the table's scale by d/(d−h).
        val r = Rectifier(truth, fx, fy, cx, cy, 1920, 1080, 90)
        val h = 0.012
        val a = tableUnder(700.0, 500.0, h)
        val b = DoubleArray(3) { i -> a[i] + 0.5 * doubleArrayOf(1.0, 0.0, -n[0] / n[2]).let { v -> val l = sqrt(v.sumOf { it * it }); v[i] / l } }
        val pa = project(a); val pb = project(b)
        val qa = r.imageToPlane(pa[0], pa[1])!!; val qb = r.imageToPlane(pb[0], pb[1])!!
        val atTable = hypot(qb.first - qa.first, qb.second - qa.second) * 100
        val corrected = atTable * (d - h) / d
        println("at table scale ${"%.3f".format(atTable)} cm, corrected ${"%.3f".format(corrected)} cm")
        assertEquals(50.0, corrected, 0.05)
    }
}
