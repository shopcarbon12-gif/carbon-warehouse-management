package com.shopcarbon.gradingai.measure

import android.content.Context
import android.graphics.Bitmap
import com.shopcarbon.gradingai.ar.CaptureBundle
import com.shopcarbon.gradingai.ar.PlaneFit
import com.shopcarbon.gradingai.ar.Rectifier
import com.shopcarbon.gradingai.model.Profile
import com.shopcarbon.gradingai.vision.Mask
import com.shopcarbon.gradingai.vision.Segmenter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.util.UUID
import kotlin.math.max
import kotlin.math.roundToInt

/** How the scale was set — kept with every scan so a suspect reading can be judged later. */
data class DepthFacts(
    val distanceCm: Double,
    val tiltDeg: Double,
    val garmentHeightCm: Double,
    val inlierFrac: Double,
    val planeRmsMm: Double,
    val tof: Boolean,
    val calibration: Float,
    val tablePxPerCm: Double,
    val depthPoints: Int,
    val segMethod: String,
    /** Depth image age against the photo's own ARCore frame (ms) — 1.0.6 freshness rule. */
    val depthAgeMs: Double = -1.0,
    /** Depth pixels with a reading at the confidence used (0–1). */
    val highConfFrac: Double = -1.0,
    /** Depth points on the fitted table plane. */
    val inlierCount: Int = 0,
    val appVersion: String = "",
    val deviceModel: String = "",
) {
    fun toJson(): JSONObject = JSONObject()
        .put("depthAgeMs", round1(depthAgeMs)).put("highConfPct", round1(highConfFrac * 100)).put("inlierCount", inlierCount)
        .put("inlierPct", round1(inlierFrac * 100)).put("appVersion", appVersion).put("deviceModel", deviceModel)
        .put("distanceCm", round1(distanceCm)).put("tiltDeg", round1(tiltDeg)).put("garmentHeightCm", round1(garmentHeightCm))
        .put("inlierFrac", (inlierFrac * 1000).roundToInt() / 1000.0).put("planeRmsMm", round1(planeRmsMm))
        .put("tof", tof).put("calibration", calibration.toDouble()).put("tablePxPerCm", (tablePxPerCm * 1000).roundToInt() / 1000.0)
        .put("depthPoints", depthPoints).put("cutout", segMethod)

    private fun round1(v: Double) = (v * 10).roundToInt() / 10.0
}

class Scan(
    val id: String,
    val photo: Bitmap,
    val photoFile: File,
    val mask: Mask,
    val pxPerCm: Double,
    val outline: Map<String, MLine>,
    /** Points the outline could not place with confidence — sent to the AI assist too. */
    val unsure: Set<String>,
    val depth: DepthFacts,
    val warnings: List<String>,
    val capturedAt: Long,
)

class MeasureFailure(message: String) : Exception(message)

fun appVersion(ctx: Context): String = runCatching { ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: "" }.getOrDefault("")

/** Depth sensor check / accuracy check: the squared-up photo only, at the depth sensor's raw scale (no calibration applied). */
class Flat(
    val photo: Bitmap,
    val pxPerCm: Double,
    val plane: com.shopcarbon.gradingai.ar.Plane,
    val depthPoints: Int,
    val tof: Boolean,
    val depthAgeMs: Double,
    val highConfFrac: Double,
) {
    /** The same depth-quality facts a scan saves, for an accuracy check. */
    fun depthJson(ctx: Context): JSONObject = DepthFacts(
        distanceCm = plane.axisDistanceM * 100, tiltDeg = plane.tiltDeg, garmentHeightCm = 0.0,
        inlierFrac = plane.inlierFrac, planeRmsMm = plane.rmsMm, tof = tof, calibration = 1f,
        tablePxPerCm = pxPerCm, depthPoints = depthPoints, segMethod = "",
        depthAgeMs = depthAgeMs, highConfFrac = highConfFrac, inlierCount = plane.count,
        appVersion = appVersion(ctx), deviceModel = android.os.Build.MODEL ?: "",
    ).toJson()
}

object Pipeline {
    /** The same photo measured as another garment type (no new capture). */
    fun remeasure(scan: Scan, profile: Profile): Scan {
        val o = Outline.measure(scan.mask, scan.pxPerCm, profile)
        return Scan(scan.id, scan.photo, scan.photoFile, scan.mask, scan.pxPerCm, o.lines, o.unsure, scan.depth, scan.warnings, scan.capturedAt)
    }

    suspend fun flatten(b: CaptureBundle): Flat = withContext(Dispatchers.Default) {
        val src = b.yuv.toBitmap()
        val pts = b.depth?.points(step = 1, minConf = if (b.tof) 128 else 64)
        // From THIS photo's depth only, the same as a scan.
        val plane = pts?.let { PlaneFit.fit(it, iterations = 260) }
            ?: throw MeasureFailure("The depth sensor did not find the table in this photo.")
        val rect = Rectifier(plane, b.fx.toDouble(), b.fy.toDouble(), b.cx.toDouble(), b.cy.toDouble(), src.width, src.height, b.sensorOrientation)
        val flat = rect.render(src)
        src.recycle()
        Flat(flat, rect.pxPerCm, plane, pts.n, b.tof, b.depthAgeMs, b.highConfFrac)
    }

    suspend fun process(ctx: Context, b: CaptureBundle, profile: Profile, calibration: Float): Scan = withContext(Dispatchers.Default) {
        val src = b.yuv.toBitmap()
        val snap = b.depth
        val pts = snap?.points(step = 1, minConf = if (b.tof) 128 else 64)
        // The plane comes from THIS photo's depth only (no older live fit to fall back on).
        val plane = pts?.let { PlaneFit.fit(it, iterations = 260) }
            ?: throw MeasureFailure("The depth sensor did not find the table in this photo. Hold the phone level above the table and try again.")
        if (plane.tiltDeg > 20) throw MeasureFailure("The phone was tilted ${plane.tiltDeg.roundToInt()}°. Hold it level over the garment.")

        val rect = Rectifier(plane, b.fx.toDouble(), b.fy.toDouble(), b.cx.toDouble(), b.cy.toDouble(), src.width, src.height, b.sensorOrientation)
        val flat = rect.render(src)
        src.recycle()
        val cut = Segmenter.cut(flat) ?: throw MeasureFailure("The garment could not be found in the photo. Lay it on a plain surface that contrasts with it.")
        val bb = cut.mask.bbox() ?: throw MeasureFailure("The garment could not be found in the photo.")
        val warnings = mutableListOf<String>()
        val touched = cut.mask.touchedEdges(2)
        if (touched.isNotEmpty()) warnings += "garment touches the photo edge (${touched.joinToString()})"

        /* The garment's top surface sits a little above the table, so at the
           table's scale it reads a fraction too big (d / (d − h)). Its height is
           measured from the same depth reading, inside the cut-out. */
        val heights = ArrayList<Double>()
        if (snap != null && pts != null) {
            for (k in 0 until pts.n) {
                val (u, v) = rect.cameraToOut(pts.x[k].toDouble(), pts.y[k].toDouble(), pts.z[k].toDouble())
                if (cut.mask[u.roundToInt(), v.roundToInt()]) heights += plane.signedHeight(pts.x[k].toDouble(), pts.y[k].toDouble(), pts.z[k].toDouble())
            }
        }
        heights.sort()
        val hG = if (heights.size >= 30) heights[heights.size / 2].coerceIn(0.0, 0.03) else 0.0
        val pxPerCm = rect.pxPerCm * plane.d / (plane.d - hG) / calibration

        // Crop to the garment with 6 cm around it; cap the long side for the upload and the AI.
        val margin = (6 * rect.pxPerCm).roundToInt()
        val l = max(0, bb[0] - margin); val t = max(0, bb[1] - margin)
        val r = minOf(flat.width - 1, bb[2] + margin); val btm = minOf(flat.height - 1, bb[3] + margin)
        var photo = Bitmap.createBitmap(flat, l, t, r - l + 1, btm - t + 1)
        var mask = cut.mask.crop(l, t, r - l + 1, btm - t + 1)
        if (photo !== flat) flat.recycle()
        var scale = 1.0
        val longSide = max(photo.width, photo.height)
        if (longSide > 3000) {
            scale = 3000.0 / longSide
            val nw = (photo.width * scale).roundToInt(); val nh = (photo.height * scale).roundToInt()
            val small = Bitmap.createScaledBitmap(photo, nw, nh, true)
            photo.recycle(); photo = small
            mask = mask.resized(nw, nh)
        }
        val finalPxPerCm = pxPerCm * scale
        val outline = Outline.measure(mask, finalPxPerCm, profile)

        val id = UUID.randomUUID().toString()
        val dir = File(ctx.filesDir, "scans/$id").apply { mkdirs() }
        val file = File(dir, "photo.jpg")
        file.outputStream().use { photo.compress(Bitmap.CompressFormat.JPEG, 92, it) }

        Scan(
            id = id, photo = photo, photoFile = file, mask = mask, pxPerCm = finalPxPerCm, outline = outline.lines, unsure = outline.unsure,
            depth = DepthFacts(
                distanceCm = plane.axisDistanceM * 100, tiltDeg = plane.tiltDeg, garmentHeightCm = hG * 100,
                inlierFrac = plane.inlierFrac, planeRmsMm = plane.rmsMm, tof = b.tof, calibration = calibration,
                tablePxPerCm = rect.pxPerCm * scale, depthPoints = pts?.n ?: 0, segMethod = cut.method,
                depthAgeMs = b.depthAgeMs, highConfFrac = b.highConfFrac, inlierCount = plane.count,
                appVersion = appVersion(ctx), deviceModel = android.os.Build.MODEL ?: "",
            ),
            warnings = warnings, capturedAt = System.currentTimeMillis(),
        )
    }
}
