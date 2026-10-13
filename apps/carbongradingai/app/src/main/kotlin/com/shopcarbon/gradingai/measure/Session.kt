package com.shopcarbon.gradingai.measure

import android.os.Build
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.shopcarbon.gradingai.App
import com.shopcarbon.gradingai.BuildConfig
import com.shopcarbon.gradingai.model.Lookup
import com.shopcarbon.gradingai.model.Profile
import com.shopcarbon.gradingai.model.SizeRow
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.math.abs

/** What is being measured: the product, the size in hand (one SKU stands for every colour), and how. */
data class MeasureTarget(val lookup: Lookup, val sizeLabel: String, val sku: SizeRow, val profile: Profile, val labelFlag: String? = null)

sealed class AiState {
    data object Idle : AiState()
    data class Off(val why: String) : AiState()
    data class Running(val startedAt: Long) : AiState()
    data class Done(val placed: Int, val ms: Long, val remarks: String) : AiState()
    data class Failed(val message: String) : AiState()
}

/**
 * One garment on the result screen: the lines (outline first, AI assist
 * replacing the seam-based ones when it answers), every drag the operator
 * makes (each becomes training data), and the save.
 */
class MeasureSession(val target: MeasureTarget, val scan: Scan, private val testPhone: Boolean) {
    val profile get() = target.profile
    val lines = mutableStateMapOf<String, MLine>().apply { putAll(scan.outline) }
    var ai by mutableStateOf<AiState>(AiState.Idle)
        private set
    private var aiLines: Map<String, MLine> = emptyMap()
    private var aiModel: String? = null
    private var aiCost: Double? = null
    private var aiJob: Job? = null
    private val undo = ArrayDeque<Map<String, MLine>>()
    var labelFlag by mutableStateOf(target.labelFlag)
    val canUndo get() = undo.isNotEmpty()

    fun cm(): Map<String, Double> = pointsCm(profile, lines, scan.pxPerCm)

    fun startAi(app: App) {
        val cfg = app.config
        // The seam points, plus anything the outline was unsure of on this photo.
        val keys = (profile.aiKeys + scan.unsure).distinct().filter { k -> profile.points.any { it.key == k } }
        if (cfg?.aiEnabled != true) { ai = AiState.Off("AI assist is off on the WMS — place the seam points by hand."); return }
        if (keys.isEmpty()) { ai = AiState.Off("This garment has no seam points for the AI."); return }
        ai = AiState.Running(System.currentTimeMillis())
        aiJob = app.scope.launch {
            try {
                val res = app.api.assist(scan.photoFile, profile.id, scan.pxPerCm, keys)
                val got = LinkedHashMap<String, MLine>()
                val l = res.optJSONObject("lines") ?: JSONObject()
                for (k in l.keys()) {
                    val o = l.optJSONObject(k) ?: continue
                    val a = o.getJSONObject("a"); val b = o.getJSONObject("b")
                    val pa = Pt(a.getDouble("x").toFloat(), a.getDouble("y").toFloat())
                    val pb = Pt(b.getDouble("x").toFloat(), b.getDouble("y").toFloat())
                    val bend = profile.points.firstOrNull { it.key == k }?.bend == true
                    got[k] = MLine(if (bend) listOf(pa, Pt((pa.x + pb.x) / 2, (pa.y + pb.y) / 2), pb) else listOf(pa, pb), source = "ai")
                }
                aiLines = got
                aiModel = res.optString("model").takeIf { it.isNotBlank() }
                aiCost = if (res.isNull("costUsd")) null else res.optDouble("costUsd")
                // A line the operator already moved stays where they put it.
                for ((k, v) in got) if (lines[k]?.moved != true) lines[k] = v
                ai = AiState.Done(got.size, res.optLong("ms"), res.optString("remarks"))
            } catch (e: Exception) {
                ai = AiState.Failed(e.message ?: "AI assist failed")
            }
        }
    }

    fun cancelAi() { aiJob?.cancel() }

    fun beginEdit() { undo.addLast(lines.toMap()); if (undo.size > 40) undo.removeFirst() }

    fun moveEnd(key: String, index: Int, to: Pt) {
        val l = lines[key] ?: return
        lines[key] = l.copy(pts = l.pts.mapIndexed { i, p -> if (i == index) to else p }, source = "manual", moved = true)
    }

    fun undo() { undo.removeLastOrNull()?.let { prev -> lines.clear(); lines.putAll(prev) } }

    /** Things the review screen should look at, decided on the phone. */
    fun flags(app: App): List<String> {
        val out = mutableListOf<String>()
        if (testPhone) out += "test phone: no time-of-flight depth sensor — not written to the item"
        out += scan.warnings
        val cmNow = cm()
        out += pairWarnings(profile, cmNow, app.config?.capture?.pairLimitCm ?: 1f)
        for ((k, a) in aiLines) {
            val o = scan.outline[k] ?: continue
            val d = abs(a.lengthPx() - o.lengthPx()) / scan.pxPerCm
            if (d > 3) out += "AI and outline differ on ${profile.points.firstOrNull { it.key == k }?.label ?: k} by ${Units.cm(d)} cm"
        }
        labelFlag?.let { out += it }
        return out
    }

    fun meta(app: App): JSONObject {
        fun linesJson(m: Map<String, MLine>) = JSONObject().apply { m.forEach { (k, v) -> put(k, v.toJson()) } }
        val iso = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
        return JSONObject()
            .put("id", scan.id)
            .put("customSkuId", target.sku.customSkuId)
            .put("profile", profile.id)
            .put("view", "front")
            .put("pointsCm", JSONObject().apply { cm().forEach { (k, v) -> put(k, v) } })
            .put("lines", linesJson(lines))
            .put("aiLines", if (aiLines.isEmpty()) JSONObject.NULL else linesJson(aiLines))
            .put("outlineLines", linesJson(scan.outline))
            .put("pxPerCm", scan.pxPerCm)
            .put("photoW", scan.photo.width)
            .put("photoH", scan.photo.height)
            .put("depth", scan.depth.toJson())
            .put("device", JSONObject().put("model", Build.MODEL).put("manufacturer", Build.MANUFACTURER).put("android", Build.VERSION.RELEASE).put("sdk", Build.VERSION.SDK_INT))
            .put("appVersion", BuildConfig.VERSION_NAME)
            .put("aiModel", aiModel ?: JSONObject.NULL)
            .put("aiCostUsd", aiCost ?: JSONObject.NULL)
            .put("capturedAt", iso.format(Date(scan.capturedAt)))
            .put("flags", JSONArray(flags(app)))
    }
}
