package com.shopcarbon.gradingai

import android.app.Application
import android.content.Context
import androidx.work.Configuration
import androidx.work.WorkManager
import com.shopcarbon.gradingai.auth.Vault
import com.shopcarbon.gradingai.model.AppConfig
import com.shopcarbon.gradingai.net.Api
import com.shopcarbon.gradingai.sync.ScanStore
import com.shopcarbon.gradingai.util.Prefs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.json.JSONObject

class App : Application() {
    lateinit var prefs: Prefs
        private set
    lateinit var vault: Vault
        private set
    lateinit var api: Api
        private set

    /** Work that must outlive a screen: the AI assist, saves. */
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    /** Last config from the WMS (or the copy saved on the phone when offline). */
    @Volatile var config: AppConfig? = null

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
        vault = Vault(this)
        api = Api(prefs, vault)
        WorkManager.initialize(this, Configuration.Builder().build())
        config = prefs.configJson?.let { runCatching { AppConfig.parse(JSONObject(it)) }.getOrNull() }
        if (ScanStore.pending(this).isNotEmpty()) ScanStore.schedule(this)
    }

    companion object {
        fun get(ctx: Context): App = ctx.applicationContext as App
    }
}
