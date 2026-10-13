package com.shopcarbon.gradingai.update

import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import com.shopcarbon.gradingai.App
import com.shopcarbon.gradingai.BuildConfig
import java.io.File

/** App updates come from the WMS releases (grading_app_releases); the phone's installer does the rest. */
object Updater {
    fun newer(latest: String?): Boolean {
        if (latest.isNullOrBlank()) return false
        val a = latest.split('.').map { it.toIntOrNull() ?: 0 }
        val b = BuildConfig.VERSION_NAME.split('.').map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(a.size, b.size)) {
            val x = a.getOrElse(i) { 0 }; val y = b.getOrElse(i) { 0 }
            if (x != y) return x > y
        }
        return false
    }

    suspend fun downloadAndInstall(ctx: Context, url: String, onProgress: (Float) -> Unit) {
        val f = File(ctx.cacheDir, "updates/CarbonGradingAI.apk")
        App.get(ctx).api.download(url, f, onProgress)
        val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.files", f)
        ctx.startActivity(
            Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }
}
