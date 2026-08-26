package com.shopcarbon.wmspc.web

import android.content.ContentValues
import android.content.Context
import android.os.Environment
import android.provider.MediaStore
import com.shopcarbon.wmspc.util.Diag

/** Writes bytes produced in the page (blob: exports) into the public Downloads collection. */
object Downloads {
    fun saveBytes(ctx: Context, name: String, mime: String, bytes: ByteArray): Boolean = runCatching {
        val resolver = ctx.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return false
        resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: return false
        values.clear()
        values.put(MediaStore.Downloads.IS_PENDING, 0)
        resolver.update(uri, values, null, null)
        Diag.log("saved ${bytes.size} bytes → Downloads/$name ($mime)")
        true
    }.onFailure { Diag.log("saveBytes failed: $it") }.getOrDefault(false)
}
