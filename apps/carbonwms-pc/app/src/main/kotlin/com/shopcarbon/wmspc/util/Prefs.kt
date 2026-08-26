package com.shopcarbon.wmspc.util

import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import com.shopcarbon.wmspc.BuildConfig
import java.util.UUID

object Prefs {
    private lateinit var sp: SharedPreferences

    fun init(ctx: Context) {
        sp = ctx.getSharedPreferences("carbonwms_pc", Context.MODE_PRIVATE)
    }

    /** Server origin the shell mirrors. Default = BuildConfig.WMS_ORIGIN; overridable from Diagnostics. */
    var origin: String
        get() = sp.getString("origin", null)?.takeIf { it.isNotBlank() } ?: BuildConfig.WMS_ORIGIN
        set(value) {
            val v = value.trim().trimEnd('/')
            sp.edit().putString("origin", v.takeIf { it.isNotBlank() && it != BuildConfig.WMS_ORIGIN }).apply()
        }

    fun originHost(): String? = Uri.parse(origin).host

    /** Owner decision D2: screen stays on while the app is open (toggle in Diagnostics). */
    var keepScreenOn: Boolean
        get() = sp.getBoolean("keep_screen_on", true)
        set(value) = sp.edit().putBoolean("keep_screen_on", value).apply()

    /** Stable per-install id used for the (dormant) OTA status check. */
    val installId: String
        get() {
            sp.getString("install_id", null)?.let { return it }
            val id = UUID.randomUUID().toString()
            sp.edit().putString("install_id", id).apply()
            return id
        }
}
