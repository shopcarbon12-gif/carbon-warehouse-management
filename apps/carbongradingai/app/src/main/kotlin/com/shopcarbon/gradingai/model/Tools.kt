package com.shopcarbon.gradingai.model

import org.json.JSONObject

/* ───────── Catalog tab: CarbonWMS's own catalog (GET /api/inventory/catalog?view=grid) ───────── */

/** One custom SKU (a colour + size) of a CarbonWMS product, with its stock at this location. */
data class WmsSku(
    val customSkuId: String,
    val sku: String,
    val color: String?,
    val size: String?,
    val upc: String?,
    /** Live tags at this location. */
    val onHand: Int,
    val bin: String?,
    val price: String?,
    val image: String?,
)

/** A CarbonWMS product (matrix) with its rows as the catalog lists them. */
data class WmsProduct(
    val matrixId: String,
    val name: String,
    val upc: String?,
    val vendor: String?,
    val category: String?,
    val skus: List<WmsSku>,
) {
    val image get() = skus.firstNotNullOfOrNull { it.image }
    val onHand get() = skus.sumOf { it.onHand }
    val colours get() = skus.mapNotNull { it.color }.distinct()
    val sizes get() = skus.mapNotNull { it.size }.distinct()
    val price get() = skus.mapNotNull { it.price?.toDoubleOrNull() }.maxOrNull()

    companion object {
        /** Grid rows → products, in the catalog's own order (rows of one product may sit on two pages; [merge] joins them). */
        fun group(j: JSONObject): List<WmsProduct> {
            val by = LinkedHashMap<String, MutableList<JSONObject>>()
            for (r in j.optJSONArray("rows").objects()) by.getOrPut(r.getString("matrix_id")) { mutableListOf() }.add(r)
            return by.map { (id, rows) ->
                val f = rows.first()
                WmsProduct(
                    id, f.optString("name", "Item"), f.optStringOrNull("matrix_upc"), f.optStringOrNull("vendor"), f.optStringOrNull("category"),
                    rows.map {
                        WmsSku(
                            it.getString("custom_sku_id"), it.optString("sku"), it.optStringOrNull("color"), it.optStringOrNull("size"),
                            it.optStringOrNull("sku_upc"), it.optInt("active_epc_count"),
                            it.optStringOrNull("pinned_bin_code") ?: it.optStringOrNull("bin_location"),
                            it.optStringOrNull("retail_price"), it.optStringOrNull("shopify_image_url"),
                        )
                    },
                )
            }
        }

        fun merge(a: List<WmsProduct>, b: List<WmsProduct>): List<WmsProduct> {
            val out = LinkedHashMap<String, WmsProduct>()
            for (p in a + b) out[p.matrixId] = out[p.matrixId]?.let { it.copy(skus = (it.skus + p.skus).distinctBy { s -> s.customSkuId }) } ?: p
            return out.values.toList()
        }
    }
}

data class WmsCatalogPage(val products: List<WmsProduct>, val rows: Int, val total: Int)

/* ───────── Social tab: CarbonCast (GET /api/marketing/...) ───────── */

data class SocialMedia(val position: Int, val kind: String, val url: String, val coverUrl: String?)
data class SocialTag(val mediaPosition: Int, val label: String)
data class SocialTarget(val provider: String, val status: String, val permalink: String?, val error: String?)

data class SocialPost(
    val id: String,
    val title: String,
    val format: String,
    val caption: String,
    val hashtags: List<String>,
    val scheduledAt: String?,
    val status: String,
    val note: String?,
    val approvedBy: String?,
    val media: List<SocialMedia>,
    val tags: List<SocialTag>,
    val targets: List<SocialTarget>,
) {
    /** The picture for lists: the first image, or a video's cover. */
    val thumb get() = media.firstOrNull()?.let { if (it.kind == "video") it.coverUrl else it.url }
    val locked get() = status in setOf("publishing", "published", "partly_published")

    companion object {
        fun parse(p: JSONObject) = SocialPost(
            p.getString("id"), p.optString("title"), p.optString("format", "image"), p.optString("caption"),
            p.optJSONArray("hashtags")?.let { a -> (0 until a.length()).map { a.optString(it) } }.orEmpty(),
            p.optStringOrNull("scheduledAt"), p.optString("status", "draft"), p.optStringOrNull("note"), p.optStringOrNull("approvedBy"),
            p.optJSONArray("media").objects().map { SocialMedia(it.optInt("position"), it.optString("kind", "image"), it.optString("url"), it.optStringOrNull("coverUrl")) },
            p.optJSONArray("tags").objects().map { SocialTag(it.optInt("mediaPosition"), it.optString("label")) },
            p.optJSONArray("targets").objects().map { SocialTarget(it.optString("provider"), it.optString("status"), it.optStringOrNull("permalink"), it.optStringOrNull("error")) },
        )

        fun parseList(j: JSONObject): List<SocialPost> = j.optJSONArray("posts").objects().map(::parse)
    }
}

/** Best hour each weekday (0 = Sunday), Eastern, from Instagram's followers-online. */
data class BestHour(val weekday: Int, val hour: Int)
