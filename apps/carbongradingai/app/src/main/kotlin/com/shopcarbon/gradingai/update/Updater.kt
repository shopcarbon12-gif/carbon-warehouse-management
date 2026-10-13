package com.shopcarbon.gradingai.update

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log
import com.shopcarbon.gradingai.App
import com.shopcarbon.gradingai.BuildConfig
import com.shopcarbon.gradingai.model.AppRelease
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.security.MessageDigest

/**
 * Over-the-air updates from the WMS (grading_app_releases → config.app).
 *
 * The app checks on start and on every return to it; a newer release is
 * downloaded in the background, checked against its published SHA-1, and
 * installed through PackageInstaller with "no user action required" (Android
 * 12+). Android still asks once — the first time this app installs over a
 * copy it did not install itself — after which updates go in silently.
 */
object Updater {
    /** What the update is doing, for the banner on the home screen. */
    val note = androidx.compose.runtime.mutableStateOf<String?>(null)
    @Volatile var state: String? = null
        private set
    @Volatile private var busy = false

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

    /** Download, verify and install `rel` if it is newer. Safe to call often; one at a time. */
    suspend fun run(ctx: Context, rel: AppRelease?, onState: (String?) -> Unit = {}): Boolean {
        if (rel == null || !newer(rel.latestVersion) || busy) return false
        busy = true
        try {
            fun say(s: String?) { state = s; note.value = s; onState(s) }
            say("Downloading update ${rel.latestVersion}…")
            val f = File(ctx.cacheDir, "updates/CarbonGradingAI-${rel.latestVersion}.apk")
            App.get(ctx).api.download(rel.downloadUrl, f) { p -> say("Downloading update ${rel.latestVersion}… ${(p * 100).toInt()}%") }
            if (rel.sha1 != null && sha1(f) != rel.sha1.lowercase()) {
                f.delete(); say("The update did not download correctly — it will try again."); return false
            }
            say("Installing update ${rel.latestVersion}…")
            withContext(Dispatchers.IO) { install(ctx, f) }
            return true
        } catch (e: Exception) {
            state = "Update failed: ${e.message}"; note.value = state; onState(state); return false
        } finally { busy = false }
    }

    private fun install(ctx: Context, apk: File) {
        val installer = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(ctx.packageName)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val id = installer.createSession(params)
        installer.openSession(id).use { s ->
            s.openWrite("base.apk", 0, apk.length()).use { out -> apk.inputStream().use { it.copyTo(out) }; s.fsync(out) }
            val pi = PendingIntent.getBroadcast(
                ctx, id, Intent(ctx, InstallResultReceiver::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
            )
            s.commit(pi.intentSender)
        }
    }

    private fun sha1(f: File): String {
        val md = MessageDigest.getInstance("SHA-1")
        f.inputStream().use { inp -> val buf = ByteArray(64 * 1024); while (true) { val n = inp.read(buf); if (n < 0) break; md.update(buf, 0, n) } }
        return md.digest().joinToString("") { "%02x".format(it) }
    }
}

/** PackageInstaller's answer: show Android's confirmation when it needs one. */
class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) else intent.getParcelableExtra(Intent.EXTRA_INTENT)
                confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)?.let { ctx.startActivity(it) }
            }
            PackageInstaller.STATUS_SUCCESS -> Log.i("Updater", "update installed")
            else -> Log.w("Updater", "install status $status: ${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)}")
        }
    }
}
