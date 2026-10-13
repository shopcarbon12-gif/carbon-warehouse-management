package com.shopcarbon.gradingai.model

import org.json.JSONObject

data class SizeRow(
    val customSkuId: String,
    val sku: String,
    val size: String?,
    val color: String?,
    val upc: String?,
    val lastMeasuredAt: String?,
)

data class CutGroup(val id: String, val name: String, val profile: String?, val products: Int)

/** GET /api/grading-app/lookup — one product, its sizes, its cut and how to measure it. */
data class Lookup(
    val matrixId: String,
    val name: String,
    val upc: String?,
    val vendor: String?,
    val category: String?,
    val subcategory: String?,
    val fabric: String?,
    val care: String?,
    val image: String?,
    val profileId: String?,
    val profileWhy: String,
    val measurable: Boolean,
    val cutGroup: CutGroup?,
    val sizes: List<SizeRow>,
    val picked: String?,
    val candidates: List<String>,
) {
    /** Sizes by label, every colour of one size together (one reading covers them all). */
    fun sizeLabels(): List<String> = sizes.mapNotNull { it.size?.trim()?.uppercase() }.distinct()

    fun skusOfSize(label: String): List<SizeRow> = sizes.filter { it.size?.trim()?.uppercase() == label }

    companion object {
        fun parse(j: JSONObject): Lookup {
            val item = j.getJSONObject("item")
            val profile = j.optJSONObject("profile") ?: JSONObject()
            val cg = j.optJSONObject("cutGroup")
            return Lookup(
                matrixId = item.getString("matrixId"),
                name = item.optString("name", "Item"),
                upc = item.optStringOrNull("upc"),
                vendor = item.optStringOrNull("vendor"),
                category = item.optStringOrNull("category"),
                subcategory = item.optStringOrNull("subcategory"),
                fabric = item.optStringOrNull("fabric"),
                care = item.optStringOrNull("care"),
                image = item.optStringOrNull("image"),
                profileId = profile.optStringOrNull("id"),
                profileWhy = profile.optString("why"),
                measurable = profile.optBoolean("measurable", true),
                cutGroup = cg?.let { CutGroup(it.getString("id"), it.optString("name"), it.optStringOrNull("profile"), it.optInt("products")) },
                sizes = j.optJSONArray("sizes").objects().map {
                    SizeRow(it.getString("customSkuId"), it.optString("sku"), it.optStringOrNull("size"), it.optStringOrNull("color"), it.optStringOrNull("upc"), it.optStringOrNull("lastMeasuredAt"))
                },
                picked = j.optStringOrNull("picked"),
                candidates = j.optJSONArray("candidates").strings(),
            )
        }
    }
}

data class QueueEntry(
    val kind: String,
    val cutGroupId: String?,
    val name: String,
    val size: String,
    val products: Int,
    val profile: String?,
    val matrixId: String,
    val sampleSku: String?,
)

data class NeedsCheck(val scanId: String, val name: String?, val size: String?, val flags: List<String>, val createdAt: String)

data class Queue(val measured: Int, val total: Int, val entries: List<QueueEntry>, val needsCheck: List<NeedsCheck>, val groups: Int) {
    companion object {
        fun parse(j: JSONObject): Queue {
            val p = j.optJSONObject("progress") ?: JSONObject()
            return Queue(
                measured = p.optInt("measured"),
                total = p.optInt("total"),
                entries = j.optJSONArray("entries").objects().map {
                    QueueEntry(it.optString("kind"), it.optStringOrNull("cutGroupId"), it.optString("name"), it.optString("size"), it.optInt("products", 1), it.optStringOrNull("profile"), it.getString("matrixId"), it.optStringOrNull("sampleSku"))
                },
                needsCheck = j.optJSONArray("needsCheck").objects().map {
                    NeedsCheck(it.getString("scanId"), it.optStringOrNull("name"), it.optStringOrNull("size"), it.optJSONArray("flags").strings(), it.optString("createdAt"))
                },
                groups = j.optInt("groups"),
            )
        }
    }
}

data class SizeCheckRow(val key: String, val label: String, val fromSize: String, val toSize: String, val deltaCm: Double, val flag: Boolean, val note: String?)

/** POST /api/grading-app/scans result. */
data class SaveResult(
    val scanId: String,
    val size: String?,
    val sameProduct: Int,
    val cutGroupName: String?,
    val cutGroupProducts: Int,
    val total: Int,
    val colors: List<String>,
    val sizeCheck: List<SizeCheckRow>,
    val flags: List<String>,
    val status: String,
    val dropbox: String,
) {
    companion object {
        fun parse(j: JSONObject): SaveResult {
            val a = j.optJSONObject("appliedTo") ?: JSONObject()
            val cg = a.optJSONObject("cutGroup")
            return SaveResult(
                scanId = j.getString("scanId"),
                size = j.optStringOrNull("size"),
                sameProduct = a.optInt("sameProduct"),
                cutGroupName = cg?.optString("name"),
                cutGroupProducts = cg?.optInt("products") ?: 0,
                total = a.optInt("total"),
                colors = j.optJSONArray("colors").strings(),
                sizeCheck = j.optJSONArray("sizeCheck").objects().map {
                    SizeCheckRow(it.optString("key"), it.optString("label"), it.optString("fromSize"), it.optString("toSize"), it.optDouble("deltaCm"), it.optString("status") == "flag", it.optStringOrNull("note"))
                },
                flags = j.optJSONArray("flags").strings(),
                status = j.optString("status"),
                dropbox = j.optString("dropbox"),
            )
        }
    }
}
