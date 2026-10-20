package com.shopcarbon.gradingai.ui

import android.content.Context
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.VibrationEffect
import android.os.VibratorManager

/**
 * Sound and vibration for the capture screen, so the phone can be held a
 * metre above the table without reading it (owner, 2026-10-20: "I barely can
 * see the screen cause it's so high").
 *   ready     — every check green: one short tick
 *   lost      — was green, a check dropped: one low tone
 *   captured  — the photo is taken: double beep + a firm buzz
 */
class Cues(ctx: Context) {
    private val tone = runCatching { ToneGenerator(AudioManager.STREAM_NOTIFICATION, 90) }.getOrNull()
    private val vib = runCatching { (ctx.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator }.getOrNull()

    private fun buzz(ms: Long) = runCatching { vib?.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE)) }

    fun ready() { runCatching { tone?.startTone(ToneGenerator.TONE_PROP_BEEP, 120) }; buzz(40) }
    fun lost() { runCatching { tone?.startTone(ToneGenerator.TONE_PROP_NACK, 180) } }
    fun captured() { runCatching { tone?.startTone(ToneGenerator.TONE_PROP_ACK, 250) }; buzz(180) }

    fun release() { runCatching { tone?.release() } }
}
