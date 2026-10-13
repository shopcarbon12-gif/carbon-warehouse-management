package com.shopcarbon.gradingai.util

import android.content.Context
import android.content.SharedPreferences
import com.shopcarbon.gradingai.BuildConfig

/** Plain (non-secret) settings. Secrets live in [com.shopcarbon.gradingai.auth.Vault]. */
class Prefs(ctx: Context) {
    private val sp: SharedPreferences = ctx.getSharedPreferences("grading", Context.MODE_PRIVATE)

    /** WMS origin; overridable in Settings for a LAN dev box. */
    var origin: String
        get() = sp.getString("origin", null)?.takeIf { it.isNotBlank() } ?: BuildConfig.WMS_ORIGIN
        set(v) = sp.edit().putString("origin", v.trim().trimEnd('/')).apply()

    /** "cm" | "in" | "both". */
    var units: String
        get() = sp.getString("units", "cm") ?: "cm"
        set(v) = sp.edit().putString("units", v).apply()

    /**
     * Scale correction from the calibration check: true length = measured × factor.
     * 1.0 until the operator measures a known object and accepts the correction.
     */
    var calibration: Float
        get() = sp.getFloat("calibration", 1f).takeIf { it in 0.9f..1.1f } ?: 1f
        set(v) = sp.edit().putFloat("calibration", v).apply()

    var calibratedAt: Long
        get() = sp.getLong("calibratedAt", 0L)
        set(v) = sp.edit().putLong("calibratedAt", v).apply()

    /**
     * Test mode: lets the app run on a phone without a time-of-flight sensor
     * (ARCore's depth-from-motion instead). Scans are saved for review only and
     * never written to the item — the scale is not trustworthy.
     */
    var testMode: Boolean
        get() = sp.getBoolean("testMode", false)
        set(v) = sp.edit().putBoolean("testMode", v).apply()

    var autoCapture: Boolean
        get() = sp.getBoolean("autoCapture", true)
        set(v) = sp.edit().putBoolean("autoCapture", v).apply()

    /** Unlock the app with the fingerprint (or the phone's PIN) when it opens. */
    var biometricLock: Boolean
        get() = sp.getBoolean("biometricLock", false)
        set(v) = sp.edit().putBoolean("biometricLock", v).apply()

    /** Points the operator removed for a product — the other sizes usually need the same ones. */
    fun skippedFor(matrixId: String): Set<String> = sp.getStringSet("skip.$matrixId", emptySet()) ?: emptySet()
    fun setSkippedFor(matrixId: String, keys: Set<String>) = sp.edit().putStringSet("skip.$matrixId", keys).apply()

    /** Last config JSON, so the app opens offline with the last known lists. */
    var configJson: String?
        get() = sp.getString("configJson", null)
        set(v) = sp.edit().putString("configJson", v).apply()
}
