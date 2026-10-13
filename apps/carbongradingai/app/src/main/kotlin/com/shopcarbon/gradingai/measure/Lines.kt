package com.shopcarbon.gradingai.measure

import com.shopcarbon.gradingai.model.Profile
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.roundToInt

data class Pt(val x: Float, val y: Float)

/**
 * One measuring line on the squared-up photo: two ends (three for a line with
 * a bend, the front rise), where it came from, and whether the operator moved it.
 */
data class MLine(val pts: List<Pt>, val source: String = "outline", val moved: Boolean = false) {
    fun lengthPx(): Double = pts.zipWithNext { a, b -> hypot((b.x - a.x).toDouble(), (b.y - a.y).toDouble()) }.sum()

    fun toJson(): JSONObject = JSONObject()
        .put("pts", JSONArray().apply { pts.forEach { put(JSONArray().put(it.x.toDouble()).put(it.y.toDouble())) } })
        .put("source", source)
        .put("moved", moved)
}

object Units {
    fun cm(v: Double) = "${(v * 10).roundToInt() / 10.0}"
    fun inch(v: Double) = "${(v / 2.54 * 10).roundToInt() / 10.0}″"
    fun show(v: Double, units: String) = when (units) {
        "in" -> inch(v)
        "both" -> "${cm(v)} cm · ${inch(v)}"
        else -> "${cm(v)} cm"
    }
}

/** Centimetres per point, plus each L/R pair's average under its plain key (as the WMS stores it). */
fun pointsCm(profile: Profile, lines: Map<String, MLine>, pxPerCm: Double): Map<String, Double> {
    val out = LinkedHashMap<String, Double>()
    for (p in profile.points) {
        val l = lines[p.key] ?: continue
        val v = l.lengthPx() / pxPerCm
        if (v > 0.3) out[p.key] = (v * 10).roundToInt() / 10.0
    }
    profile.points.filter { it.pairOf != null }.groupBy { it.pairOf!! }.forEach { (plain, pts) ->
        val vs = pts.mapNotNull { out[it.key] }
        if (vs.isNotEmpty()) out[plain] = (vs.average() * 10).roundToInt() / 10.0
    }
    return out
}

/** L/R pairs that differ by more than the limit — a twisted leg or a sleeve not laid straight. */
fun pairWarnings(profile: Profile, cm: Map<String, Double>, limit: Float): List<String> =
    profile.points.filter { it.pairOf != null }.groupBy { it.pairOf!! }.mapNotNull { (plain, pts) ->
        val vs = pts.mapNotNull { cm[it.key] }
        if (vs.size == 2 && abs(vs[0] - vs[1]) > limit) "${pts.first().label.removeSuffix(" L")}: left and right differ by ${Units.cm(abs(vs[0] - vs[1]))} cm" else null
    }
