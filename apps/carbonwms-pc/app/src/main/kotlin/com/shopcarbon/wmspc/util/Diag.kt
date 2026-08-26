package com.shopcarbon.wmspc.util

import android.content.Context
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** In-memory ring log (shown/shared from Diagnostics) + last-crash capture. */
object Diag {
    private const val TAG = "CarbonWMSPC"
    private const val MAX_LINES = 300
    private val lines = ArrayDeque<String>()
    private var crashFile: File? = null
    private val fmt = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)

    fun init(ctx: Context) {
        crashFile = File(ctx.filesDir, "last-crash.txt")
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            runCatching {
                crashFile?.writeText("${Date()}\n${Log.getStackTraceString(error)}\n\n--- log ---\n${dump()}")
            }
            previous?.uncaughtException(thread, error)
        }
    }

    fun log(msg: String) {
        Log.i(TAG, msg)
        synchronized(lines) {
            lines.addLast("${fmt.format(Date())} $msg")
            while (lines.size > MAX_LINES) lines.removeFirst()
        }
    }

    fun dump(): String = synchronized(lines) { lines.joinToString("\n") }

    fun lastCrash(): String? = crashFile?.takeIf { it.exists() }?.readText()
}
