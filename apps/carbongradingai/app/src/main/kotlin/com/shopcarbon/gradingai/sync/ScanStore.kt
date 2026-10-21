package com.shopcarbon.gradingai.sync

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.shopcarbon.gradingai.App
import com.shopcarbon.gradingai.model.SaveResult
import com.shopcarbon.gradingai.net.ApiError
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Saves are written to the phone first (files/scans/<id>/meta.json + photo.jpg,
 * plus crotch.jpg for bottoms measured with a second, legs-spread photo)
 * and uploaded from there, so nothing measured is lost to a dropped Wi-Fi
 * connection. The scan id travels with it: the WMS recognises a retry of a
 * save that already landed and does not write it twice.
 */
object ScanStore {
    private fun dir(ctx: Context) = File(ctx.filesDir, "scans")

    fun pending(ctx: Context): List<File> =
        dir(ctx).listFiles()?.filter { File(it, "meta.json").exists() }?.sortedBy { it.lastModified() } ?: emptyList()

    /** Write the save to the phone, then try it now; on failure it waits for the background upload. */
    suspend fun save(ctx: Context, id: String, meta: JSONObject): SaveResult? {
        val d = File(dir(ctx), id).apply { mkdirs() }
        File(d, "meta.json").writeText(meta.toString())
        return try {
            upload(ctx, d)
        } catch (e: Exception) {
            schedule(ctx)
            if (e is ApiError && e.status in 400..499 && e.status != 401 && e.status != 408 && e.status != 429) throw e
            null
        }
    }

    suspend fun upload(ctx: Context, d: File): SaveResult {
        val meta = JSONObject(File(d, "meta.json").readText())
        val res = App.get(ctx).api.saveScan(meta, File(d, "photo.jpg"), File(d, "crotch.jpg").takeIf { it.exists() })
        d.deleteRecursively()
        return res
    }

    fun schedule(ctx: Context) {
        val req = OneTimeWorkRequestBuilder<UploadWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(ctx).enqueueUniqueWork("scan-upload", ExistingWorkPolicy.KEEP, req)
    }

    /** Discard a scan that was measured but not saved (its photo). */
    fun discard(ctx: Context, id: String) {
        val d = File(dir(ctx), id)
        if (!File(d, "meta.json").exists()) d.deleteRecursively()
    }
}

class UploadWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        var failed = false
        for (d in ScanStore.pending(applicationContext)) {
            try {
                ScanStore.upload(applicationContext, d)
            } catch (e: ApiError) {
                // A save the WMS refuses for good (e.g. the size was deleted) is kept aside, not retried forever.
                if (e.status in 400..499 && e.status != 401 && e.status != 408 && e.status != 429) {
                    d.renameTo(File(d.parentFile, "${d.name}.refused"))
                } else failed = true
            } catch (_: Exception) {
                failed = true
            }
        }
        return if (failed) Result.retry() else Result.success()
    }
}
