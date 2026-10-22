package com.shopcarbon.gradingai.model

import org.json.JSONObject

data class SizeRow(
    val customSkuId: String,
    val sku: String,
    val size: String?,
    val color: String?,
    val upc: String?,
    val lastMeasuredAt: String?,
    /** This colour's current photo on Shopify. */
    val image: String? = null,
    /** Where the newest reading came from: "app" (scanned), "guide" (Shopify size guide), "graded", "web". */
    val lastSource: String? = null,
    /** The Shopify size guide's numbers for this size (flat cm) — the result screen compares against them. */
    val guideCm: Map<String, Double> = emptyMap(),
)

enum class SizeStatus { Scanned, Guide, NotMeasured }

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
    val lastProfile: String? = null,
) {
    /** Sizes by label, every colour of one size together (one reading covers them all). */
    fun sizeLabels(): List<String> = sizes.mapNotNull { it.size?.trim()?.uppercase() }.distinct()

    /** Colours, in the product's order. */
    fun colours(): List<String> = sizes.mapNotNull { it.color?.trim() }.filter { it.isNotEmpty() }.distinct()

    /** How a size stands: scanned with the app, filled from the size guide, or not measured. */
    fun statusOf(label: String): SizeStatus {
        val rows = skusOfSize(label)
        val newest = rows.filter { it.lastMeasuredAt != null }.maxByOrNull { it.lastMeasuredAt!! } ?: return SizeStatus.NotMeasured
        // A chart (the Shopify size guide, or a graded chart) is not a scan of the garment.
        return if (newest.lastSource == "guide" || newest.lastSource == "graded") SizeStatus.Guide else SizeStatus.Scanned
    }

    /** The size after this one (wearing order), for "Next size". */
    fun nextSize(label: String): String? = sizeLabels().let { l -> l.indexOf(label).takeIf { it >= 0 }?.let { l.getOrNull(it + 1) } }

    /** The size guide's numbers for a size. */
    fun guideFor(label: String): Map<String, Double> = skusOfSize(label).firstNotNullOfOrNull { it.guideCm.takeIf { g -> g.isNotEmpty() } } ?: emptyMap()

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
                    val g = it.optJSONObject("guideCm")
                    SizeRow(
                        it.getString("customSkuId"), it.optString("sku"), it.optStringOrNull("size"), it.optStringOrNull("color"), it.optStringOrNull("upc"),
                        it.optStringOrNull("lastMeasuredAt"), it.optStringOrNull("image"), it.optStringOrNull("lastSource"),
                        g?.keys()?.asSequence()?.associateWith { k -> g.optDouble(k) }?.filterValues { v -> !v.isNaN() } ?: emptyMap(),
                    )
                },
                picked = j.optStringOrNull("picked"),
                candidates = j.optJSONArray("candidates").strings(),
                lastProfile = j.optStringOrNull("lastProfile"),
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
    /** The product's photo. */
    val image: String? = null,
)

data class NeedsCheck(val scanId: String, val name: String?, val size: String?, val flags: List<String>, val createdAt: String, val matrixId: String? = null, val photo: String? = null)

data class Queue(val measured: Int, val total: Int, val entries: List<QueueEntry>, val needsCheck: List<NeedsCheck>, val groups: Int) {
    companion object {
        fun parse(j: JSONObject): Queue {
            val p = j.optJSONObject("progress") ?: JSONObject()
            return Queue(
                measured = p.optInt("measured"),
                total = p.optInt("total"),
                entries = j.optJSONArray("entries").objects().map {
                    QueueEntry(it.optString("kind"), it.optStringOrNull("cutGroupId"), it.optString("name"), it.optString("size"), it.optInt("products", 1), it.optStringOrNull("profile"), it.getString("matrixId"), it.optStringOrNull("sampleSku"), it.optStringOrNull("image"))
                },
                needsCheck = j.optJSONArray("needsCheck").objects().map {
                    NeedsCheck(it.getString("scanId"), it.optStringOrNull("name"), it.optStringOrNull("size"), it.optJSONArray("flags").strings(), it.optString("createdAt"), it.optStringOrNull("matrixId"), it.optStringOrNull("photo"))
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

/** GET /api/grading-app/catalog — one product on the Catalog tab. */
data class CatalogRow(val matrixId: String, val name: String, val upc: String?, val vendor: String?, val image: String?, val colours: Int, val sizes: List<Pair<String, Boolean>>) {
    val measured get() = sizes.count { it.second }

    companion object {
        fun parseList(j: JSONObject): List<CatalogRow> = j.optJSONArray("rows").objects().map {
            CatalogRow(
                it.getString("matrixId"), it.optString("name", "Item"), it.optStringOrNull("upc"), it.optStringOrNull("vendor"), it.optStringOrNull("image"), it.optInt("colours"),
                it.optJSONArray("sizes").objects().map { z -> z.optString("size") to z.optBoolean("measured") },
            )
        }
    }
}
