package com.shopcarbon.gradingai.measure

/**
 * Reads a care label: the size printed on it, and the fabric percentages
 * against the WMS's fabric line.
 *
 * Fibres are compared by what they are, not how they are spelled: a label
 * says "spandex", "Lycra", "elastano" or — read by the phone, or misprinted —
 * "elestane", and the WMS says "Elastane"; all one fibre (S25, 2026-10-13: a
 * matching label was flagged "differs" over that one letter). Labels list the
 * same fibre in several languages; one percentage per fibre is kept.
 */
object LabelCheck {
    data class Result(val summary: String, val flag: String?, val sizeOnLabel: String?)

    /** Canonical fibre → the names it goes by on labels (English, Spanish, French, German, Italian, brands). */
    private val FIBRES: Map<String, List<String>> = mapOf(
        "cotton" to listOf("cotton", "algodon", "coton", "baumwolle", "cotone", "algodao"),
        "polyester" to listOf("polyester", "poliester", "polyestere", "poliestere"),
        "elastane" to listOf("elastane", "spandex", "lycra", "elastano", "elasthan", "elastan", "elasthanne", "elastam"),
        "viscose" to listOf("viscose", "viscosa", "rayon", "viskose"),
        "nylon" to listOf("nylon", "polyamide", "poliamida", "polyamid", "poliammide"),
        "modal" to listOf("modal"),
        "lyocell" to listOf("lyocell", "tencel"),
        "linen" to listOf("linen", "lino", "lin", "leinen", "flax"),
        "wool" to listOf("wool", "lana", "laine", "wolle"),
        "acrylic" to listOf("acrylic", "acrilico", "acrylique", "polyacryl"),
        "silk" to listOf("silk", "seda", "soie", "seide", "seta"),
        "cashmere" to listOf("cashmere", "cachemire", "kaschmir"),
        "polyurethane" to listOf("polyurethane", "poliuretano", "polyurethan", "pu"),
        "acetate" to listOf("acetate", "acetato", "acetat"),
        "leather" to listOf("leather", "cuero", "cuir", "leder"),
    )

    private val ACCENTS = mapOf('á' to 'a', 'é' to 'e', 'í' to 'i', 'ó' to 'o', 'ú' to 'u', 'ã' to 'a', 'ç' to 'c', 'è' to 'e', 'ê' to 'e', 'ü' to 'u', 'ö' to 'o', 'ä' to 'a', 'ñ' to 'n')

    private fun plain(w: String) = w.lowercase().map { ACCENTS[it] ?: it }.joinToString("").filter { it in 'a'..'z' }

    private fun distance(a: String, b: String): Int {
        val d = IntArray(b.length + 1) { it }
        for (i in 1..a.length) {
            var prev = d[0]; d[0] = i
            for (j in 1..b.length) {
                val cur = d[j]
                d[j] = minOf(d[j] + 1, d[j - 1] + 1, prev + if (a[i - 1] == b[j - 1]) 0 else 1)
                prev = cur
            }
        }
        return d[b.length]
    }

    /** The fibre a word names, allowing a misread letter or two on longer words. */
    fun fibre(word: String): String? {
        val w = plain(word)
        if (w.length < 2) return null
        var best: String? = null; var bestD = Int.MAX_VALUE
        for ((canon, names) in FIBRES) for (n in names) {
            val dd = distance(w, n)
            if (dd < bestD) { bestD = dd; best = canon }
        }
        val allowed = when { w.length <= 3 -> 0; w.length <= 6 -> 1; else -> 2 }
        return if (bestD <= allowed) best else null
    }

    /** "95% COTTON 5% SPANDEX" → {cotton=95, elastane=5}. Unknown words are kept under their own spelling. */
    fun fibres(text: String): Map<String, Int> {
        val out = LinkedHashMap<String, Int>()
        for (m in Regex("(\\d{1,3})\\s*%\\s*([\\p{L}]+)").findAll(text)) {
            val pct = m.groupValues[1].toInt()
            val name = fibre(m.groupValues[2]) ?: plain(m.groupValues[2])
            if (name.isNotEmpty() && name !in out) out[name] = pct
        }
        return out
    }

    fun compare(text: String, sizes: List<String>, chosen: String?, wmsFabric: String?): Result {
        val up = text.uppercase()
        val tokens = Regex("[A-Z0-9]+").findAll(up).map { it.value }.toSet()
        val onLabel = sizes.filter { it in tokens }.sortedByDescending { it.length }
        val notes = mutableListOf<String>()
        var flag: String? = null
        val labelSize = onLabel.firstOrNull()
        when {
            labelSize == null -> notes += "No size found on the label."
            chosen != null && labelSize != chosen -> { notes += "Label says $labelSize — you picked $chosen."; flag = "care label says $labelSize, measured as $chosen" }
            else -> notes += "Size $labelSize matches."
        }
        val label = fibres(text)
        if (label.isNotEmpty()) {
            val wms = fibres(wmsFabric.orEmpty())
            val read = label.entries.joinToString { "${it.value}% ${it.key}" }
            when {
                wms.isEmpty() -> notes += "Fabric on label: $read (none in the WMS)."
                wms == label -> notes += "Fabric matches the WMS."
                else -> { notes += "Fabric on label ($read) differs from the WMS ($wmsFabric)."; flag = flag ?: "care label fabric differs from WMS: $read" }
            }
        }
        return Result(notes.joinToString(" "), flag, labelSize)
    }
}
