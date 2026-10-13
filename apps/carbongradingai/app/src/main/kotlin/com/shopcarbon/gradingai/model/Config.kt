package com.shopcarbon.gradingai.model

import org.json.JSONArray
import org.json.JSONObject

/** One point of measure, as the WMS defines it (lib/size-grading/grading-app-profiles.ts). */
data class PointDef(
    val key: String,
    val letter: String,
    val label: String,
    val rule: String,
    val pairOf: String?,
    val side: String?,
    val hard: Boolean,
    val bend: Boolean,
)

data class GuideExample(val image: String, val label: String)

data class GuideImage(val image: String, val lines: Map<String, List<Pair<Float, Float>>>, val examples: List<GuideExample>)

data class Profile(
    val id: String,
    val label: String,
    val family: String,
    val silhouette: String,
    val points: List<PointDef>,
    val lay: String,
    val aiKeys: List<String>,
    val guide: GuideImage?,
)

data class CaptureParams(
    val distanceCm: ClosedFloatingPointRange<Float>,
    val idealDistanceCm: ClosedFloatingPointRange<Float>,
    val maxTiltDeg: Float,
    val holdStillMs: Long,
    val pairLimitCm: Float,
)

data class AppRelease(val latestVersion: String, val downloadUrl: String, val sha1: String?, val notes: String?)

data class AppConfig(
    val profiles: List<Profile>,
    val aiEnabled: Boolean,
    val aiModel: String?,
    val capture: CaptureParams,
    val supportedModels: List<String>,
    val modelNames: Map<String, String>,
    val dropbox: Boolean,
    val dropboxFolder: String,
    val app: AppRelease?,
    val studioLink: String,
    val seoLink: String,
    val reviewLink: String,
    val cutGroupsLink: String,
    val email: String?,
) {
    fun profile(id: String?): Profile? = profiles.firstOrNull { it.id == id }

    companion object {
        fun parse(j: JSONObject): AppConfig {
            val profiles = j.optJSONArray("profiles").objects().map { p ->
                Profile(
                    id = p.getString("id"),
                    label = p.optString("label"),
                    family = p.optString("family"),
                    silhouette = p.optString("silhouette", "tee"),
                    points = p.optJSONArray("points").objects().map { x ->
                        PointDef(
                            key = x.getString("key"), letter = x.optString("letter"), label = x.optString("label"),
                            rule = x.optString("rule"), pairOf = x.optStringOrNull("pairOf"), side = x.optStringOrNull("side"),
                            hard = x.optBoolean("hard"), bend = x.optBoolean("bend"),
                        )
                    },
                    lay = p.optString("lay"),
                    aiKeys = p.optJSONArray("aiKeys").strings(),
                    guide = p.optJSONObject("guide")?.let { g ->
                        val lines = mutableMapOf<String, List<Pair<Float, Float>>>()
                        g.optJSONObject("lines")?.let { l ->
                            for (k in l.keys()) {
                                val arr = l.getJSONArray(k)
                                lines[k] = (0 until arr.length()).map { i -> arr.getJSONArray(i).let { it.getDouble(0).toFloat() to it.getDouble(1).toFloat() } }
                            }
                        }
                        GuideImage(g.optString("image"), lines, g.optJSONArray("examples").objects().map { GuideExample(it.optString("image"), it.optString("label")) })
                    },
                )
            }
            val c = j.optJSONObject("capture") ?: JSONObject()
            fun range(name: String, a: Float, b: Float) = c.optJSONArray(name)?.let { it.getDouble(0).toFloat()..it.getDouble(1).toFloat() } ?: a..b
            val ai = j.optJSONObject("ai") ?: JSONObject()
            val dev = j.optJSONObject("devices") ?: JSONObject()
            val names = mutableMapOf<String, String>()
            dev.optJSONObject("names")?.let { n -> for (k in n.keys()) names[k] = n.getString(k) }
            val links = j.optJSONObject("links") ?: JSONObject()
            val st = j.optJSONObject("storage") ?: JSONObject()
            return AppConfig(
                profiles = profiles,
                aiEnabled = ai.optBoolean("enabled"),
                aiModel = ai.optStringOrNull("model"),
                capture = CaptureParams(
                    distanceCm = range("distanceCm", 60f, 120f),
                    idealDistanceCm = range("idealDistanceCm", 70f, 110f),
                    maxTiltDeg = c.optDouble("maxTiltDeg", 8.0).toFloat(),
                    holdStillMs = c.optLong("holdStillMs", 1200),
                    pairLimitCm = c.optDouble("pairLimitCm", 1.0).toFloat(),
                ),
                supportedModels = dev.optJSONArray("supported").strings().ifEmpty { listOf("SM-N975", "SM-N976", "SM-G986", "SM-G988") },
                modelNames = names,
                dropbox = st.optBoolean("dropbox"),
                dropboxFolder = st.optString("dropboxFolder"),
                app = j.optJSONObject("app")?.let { AppRelease(it.getString("latestVersion"), it.getString("downloadUrl"), it.optStringOrNull("sha1"), it.optStringOrNull("notes")) },
                studioLink = links.optString("studio", "/inventory/catalog?matrix={matrixId}&mtab=studio"),
                seoLink = links.optString("seo", "/inventory/catalog?matrix={matrixId}&mtab=seo"),
                reviewLink = links.optString("review", "/inventory/size-grading/review"),
                cutGroupsLink = links.optString("cutGroups", "/inventory/size-grading/cut-groups"),
                email = j.optJSONObject("user")?.optStringOrNull("email"),
            )
        }
    }
}

fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }
fun JSONArray?.strings(): List<String> = if (this == null) emptyList() else (0 until length()).mapNotNull { opt(it) as? String }
fun JSONObject.optStringOrNull(k: String): String? = if (isNull(k) || !has(k)) null else optString(k).takeIf { it.isNotEmpty() }
