package com.shopcarbon.gradingai.measure

import android.os.Build
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateMap
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

/** Which photo a line is on: the main one, or the legs-spread crotch photo of a pair of bottoms. */
enum class Photo { MAIN, CROTCH }

/**
 * The second photo of a pair of bottoms, legs spread so the crotch lies flat
 * (owner, 2026-10-20). Only the crotch points come from it — the rise and the
 * inseams, which all end at the crotch seam point — at its own depth scale.
 */
class CrotchPart(val scan: Scan, keys: Set<String>) {
    val lines: SnapshotStateMap<String, MLine> = mutableStateMapOf<String, MLine>().apply { putAll(scan.outline.filterKeys { it in keys }) }
    var ai by mutableStateOf<AiState>(AiState.Idle)
    var aiLines: Map<String, MLine> = emptyMap()
    /** How far apart the AI's two placements put each point (cm). */
    var spreadCm: Map<String, Double> = emptyMap()
    var job: Job? = null
}

/**
 * One garment on the result screen: the lines (outline first, AI assist
 * replacing the seam-based ones when it answers), every drag the operator
 * makes (each becomes training data), and the save.
 */
class MeasureSession(
    val target: MeasureTarget,
    val scan: Scan,
    private val testPhone: Boolean,
    initiallyRemoved: Set<String> = emptySet(),
    /** A crotch photo will follow: the main photo's AI leaves the crotch points to it. */
    crotchPlanned: Boolean = false,
) {
    val profile get() = target.profile
    val lines = mutableStateMapOf<String, MLine>().apply { putAll(scan.outline) }
    /** Points left out of this save (owner: "not all measurements will always be required"). */
    val removed = mutableStateListOf<String>().apply { addAll(initiallyRemoved.filter { k -> target.profile.points.any { it.key == k } }) }
    var ai by mutableStateOf<AiState>(AiState.Idle)
        private set
    var crotch by mutableStateOf<CrotchPart?>(null)
        private set
    private var crotchPlanned = crotchPlanned
    private var aiLines: Map<String, MLine> = emptyMap()
    private var aiModel: String? = null
    private var aiCost: Double? = null
    private var aiJob: Job? = null
    private val undo = ArrayDeque<Pair<Map<String, MLine>, Map<String, MLine>?>>()
    var labelFlag by mutableStateOf(target.labelFlag)
    val canUndo get() = undo.isNotEmpty()

    /** The crotch points this type takes from the second photo. */
    val crotchKeys: Set<String> get() = profile.crotchKeys.filter { k -> profile.points.any { it.key == k } }.toSet()

    fun cm(): Map<String, Double> = pointsCm(profile, listOfNotNull(kept() to scan.pxPerCm, crotch?.let { keptCrotch() to it.scan.pxPerCm }))

    /** Every point's value, left-out ones included (for the rows and the photo labels). */
    fun allCm(): Map<String, Double> = pointsCm(profile, listOfNotNull(lines.toMap() to scan.pxPerCm, crotch?.let { it.lines.toMap() to it.scan.pxPerCm }))

    /** The main photo's lines that will be saved. */
    fun kept(): Map<String, MLine> = lines.filterKeys { it !in removed }
    fun keptCrotch(): Map<String, MLine> = crotch?.lines?.filterKeys { it !in removed } ?: emptyMap()

    fun linesOf(which: Photo): SnapshotStateMap<String, MLine>? = if (which == Photo.MAIN) lines else crotch?.lines

    /** Leave a point (or an L/R pair) out, or bring it back; remembered for the product's other sizes. */
    fun toggleRemoved(app: App, keys: List<String>) {
        if (keys.all { it in removed }) removed.removeAll(keys) else keys.forEach { if (it !in removed) removed.add(it) }
        app.prefs.setSkippedFor(target.lookup.matrixId, removed.toSet())
    }

    /** The same photo(s), measured as another garment type. */
    fun switchTo(app: App, other: Profile): MeasureSession {
        cancelAi()
        val c = crotch
        val keepCrotch = c != null && other.crotchKeys.isNotEmpty()
        val next = MeasureSession(target.copy(profile = other), Pipeline.remeasure(scan, other), testPhone, app.prefs.skippedFor(target.lookup.matrixId), crotchPlanned = keepCrotch)
        next.labelFlag = labelFlag
        next.startAi(app)
        if (keepCrotch) next.attachCrotch(app, Pipeline.remeasure(c!!.scan, other))
        return next
    }

    fun startAi(app: App) {
        val cfg = app.config
        // The seam points, plus anything the outline was unsure of on this photo — not the ones left out,
        // and not the crotch points when the crotch photo gives them.
        val skip = if (crotchPlanned || crotch != null) crotchKeys else emptySet()
        val keys = (profile.aiKeys + scan.unsure).distinct().filter { k -> profile.points.any { it.key == k } && k !in removed && k !in skip }
        if (cfg?.aiEnabled != true) { ai = AiState.Off("AI assist is off on the WMS — place the seam points by hand."); return }
        if (keys.isEmpty()) { ai = AiState.Off("This garment has no seam points for the AI."); return }
        ai = AiState.Running(System.currentTimeMillis())
        aiJob = app.scope.launch {
            try {
                val res = app.api.assist(scan.photoFile, profile.id, scan.pxPerCm, keys)
                val got = parseAiLines(res)
                aiLines = got
                aiModel = res.optString("model").takeIf { it.isNotBlank() }
                aiCost = (aiCost ?: 0.0) + (if (res.isNull("costUsd")) 0.0 else res.optDouble("costUsd"))
                // A line the operator already moved stays where they put it.
                for ((k, v) in got) if (lines[k]?.moved != true) lines[k] = v
                ai = AiState.Done(got.size, res.optLong("ms"), res.optString("remarks"))
            } catch (e: Exception) {
                ai = AiState.Failed(e.message ?: "AI assist failed")
            }
        }
    }

    /**
     * The crotch photo arrived: its crotch points replace the main photo's, and
     * the AI places the crotch twice on it — two answers that disagree are
     * flagged rather than trusted (owner, 2026-10-20).
     */
    fun attachCrotch(app: App, second: Scan) {
        crotch?.job?.cancel()
        val keys = crotchKeys
        val part = CrotchPart(second, keys)
        crotch = part
        crotchPlanned = false
        for (k in keys) lines.remove(k)
        startCrotchAi(app, part)
    }

    /** No crotch photo after all: the crotch points are placed on the main photo. */
    fun skipCrotch(app: App) {
        crotchPlanned = false
        val keys = crotchKeys.filter { it !in removed }
        if (keys.isEmpty() || app.config?.aiEnabled != true) return
        app.scope.launch {
            try {
                val res = app.api.assist(scan.photoFile, profile.id, scan.pxPerCm, keys)
                for ((k, v) in parseAiLines(res)) if (lines[k]?.moved != true) lines[k] = v
                aiCost = (aiCost ?: 0.0) + (if (res.isNull("costUsd")) 0.0 else res.optDouble("costUsd"))
            } catch (_: Exception) { /* the outline's lines stay; the operator can move them */ }
        }
    }

    fun startCrotchAi(app: App) { crotch?.let { startCrotchAi(app, it) } }

    private fun startCrotchAi(app: App, part: CrotchPart) {
        val keys = crotchKeys.filter { it !in removed }
        if (app.config?.aiEnabled != true) { part.ai = AiState.Off("AI assist is off on the WMS — place the crotch by hand."); return }
        if (keys.isEmpty()) { part.ai = AiState.Off("No crotch points to place."); return }
        part.ai = AiState.Running(System.currentTimeMillis())
        part.job = app.scope.launch {
            try {
                val res = app.api.assist(part.scan.photoFile, profile.id, part.scan.pxPerCm, keys, repeat = 2)
                val got = parseAiLines(res)
                part.aiLines = got
                val sp = res.optJSONObject("spreadCm")
                part.spreadCm = sp?.keys()?.asSequence()?.associateWith { sp.optDouble(it) } ?: emptyMap()
                aiModel = aiModel ?: res.optString("model").takeIf { it.isNotBlank() }
                aiCost = (aiCost ?: 0.0) + (if (res.isNull("costUsd")) 0.0 else res.optDouble("costUsd"))
                for ((k, v) in got) if (part.lines[k]?.moved != true) part.lines[k] = v
                part.ai = AiState.Done(got.size, res.optLong("ms"), res.optString("remarks"))
            } catch (e: Exception) {
                part.ai = AiState.Failed(e.message ?: "AI assist failed")
            }
        }
    }

    private fun parseAiLines(res: JSONObject): Map<String, MLine> {
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
        return got
    }

    fun cancelAi() { aiJob?.cancel(); crotch?.job?.cancel() }

    fun beginEdit() { undo.addLast(lines.toMap() to crotch?.lines?.toMap()); if (undo.size > 40) undo.removeFirst() }

    fun moveEnd(which: Photo, key: String, index: Int, to: Pt) {
        val set = linesOf(which) ?: return
        val l = set[key] ?: return
        set[key] = l.copy(pts = l.pts.mapIndexed { i, p -> if (i == index) to else p }, source = "manual", moved = true)
    }

    fun undo() {
        val (main, c) = undo.removeLastOrNull() ?: return
        lines.clear(); lines.putAll(main)
        crotch?.let { part -> if (c != null) { part.lines.clear(); part.lines.putAll(c) } }
    }

    /** Things the review screen should look at, decided on the phone. */
    fun flags(app: App): List<String> {
        val out = mutableListOf<String>()
        if (testPhone) out += "test phone: no time-of-flight depth sensor — not written to the item"
        out += scan.warnings
        crotch?.scan?.warnings?.forEach { out += "crotch photo: $it" }
        val cmNow = cm()
        out += pairWarnings(profile, cmNow, app.config?.capture?.pairLimitCm ?: 1f)
        fun label(k: String) = profile.points.firstOrNull { it.key == k }?.label ?: k
        for ((k, a) in aiLines) {
            if (k in removed) continue
            val o = scan.outline[k] ?: continue
            val d = abs(a.lengthPx() - o.lengthPx()) / scan.pxPerCm
            if (d > 3) out += "AI and outline differ on ${label(k)} by ${Units.cm(d)} cm"
        }
        crotch?.let { c ->
            for ((k, d) in c.spreadCm) if (k !in removed && d > 1.5) out += "AI unsure of the crotch: its two placements differ by ${Units.cm(d)} cm on ${label(k)}"
            if (c.ai !is AiState.Done && crotchKeys.any { it !in removed }) out += "crotch not placed by the AI (outline guess) — check the front rise and inseam"
        }
        // Seam points the AI was asked for but never answered: the outline's guess was saved instead.
        if (ai !is AiState.Done && ai !is AiState.Off) {
            val missing = profile.aiKeys.filter { it !in removed && it !in crotchKeys && it in lines && it !in aiLines }
            if (missing.isNotEmpty()) out += "not placed by the AI (outline guess): ${missing.joinToString { label(it) }}"
        }
        labelFlag?.let { out += it }
        return out
    }

    fun meta(app: App): JSONObject {
        fun linesJson(m: Map<String, MLine>) = JSONObject().apply { m.forEach { (k, v) -> put(k, v.toJson()) } }
        val iso = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
        val c = crotch
        return JSONObject()
            .put("id", scan.id)
            .put("customSkuId", target.sku.customSkuId)
            .put("profile", profile.id)
            .put("view", "front")
            .put("pointsCm", JSONObject().apply { cm().forEach { (k, v) -> put(k, v) } })
            .put("lines", linesJson(kept()))
            .put("skipped", JSONArray(removed.toList()))
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
            .put("crotch", if (c == null) JSONObject.NULL else JSONObject()
                .put("pxPerCm", c.scan.pxPerCm)
                .put("photoW", c.scan.photo.width)
                .put("photoH", c.scan.photo.height)
                .put("lines", linesJson(keptCrotch()))
                .put("aiLines", if (c.aiLines.isEmpty()) JSONObject.NULL else linesJson(c.aiLines))
                .put("outlineLines", linesJson(c.scan.outline.filterKeys { it in crotchKeys }))
                .put("depth", c.scan.depth.toJson()))
    }
}
