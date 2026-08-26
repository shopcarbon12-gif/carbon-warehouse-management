package com.shopcarbon.wmspc.web

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.text.InputType
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.Toast
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.shopcarbon.wmspc.R

/**
 * Native replacements for window.alert / confirm / prompt. The web app gates every destructive
 * action on confirm() and reports results (incl. one-time passwords) through alert(), so each
 * JsResult is answered exactly once, including when the dialog is dismissed.
 */
object JsDialogs {

    fun alert(a: Activity, message: String, result: JsResult) {
        var done = false
        val finish = { if (!done) { done = true; result.confirm() } }
        MaterialAlertDialogBuilder(a)
            .setMessage(message)
            .setPositiveButton(R.string.dialog_ok) { _, _ -> finish() }
            .setNeutralButton(R.string.dialog_copy) { _, _ -> copy(a, message); finish() }
            .setOnDismissListener { finish() }
            .show()
    }

    fun confirm(a: Activity, message: String, result: JsResult) {
        var done = false
        MaterialAlertDialogBuilder(a)
            .setMessage(message)
            .setPositiveButton(R.string.dialog_ok) { _, _ -> if (!done) { done = true; result.confirm() } }
            .setNegativeButton(R.string.dialog_cancel) { _, _ -> if (!done) { done = true; result.cancel() } }
            .setOnDismissListener { if (!done) { done = true; result.cancel() } }
            .show()
    }

    fun prompt(a: Activity, message: String, defaultValue: String?, result: JsPromptResult) {
        var done = false
        val input = EditText(a).apply {
            setText(defaultValue ?: "")
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            setSelectAllOnFocus(true)
        }
        val pad = (20 * a.resources.displayMetrics.density).toInt()
        val container = FrameLayout(a).apply {
            setPadding(pad, pad / 2, pad, 0)
            addView(input, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
        }
        MaterialAlertDialogBuilder(a)
            .setMessage(message)
            .setView(container)
            .setPositiveButton(R.string.dialog_ok) { _, _ -> if (!done) { done = true; result.confirm(input.text.toString()) } }
            .setNegativeButton(R.string.dialog_cancel) { _, _ -> if (!done) { done = true; result.cancel() } }
            .setOnDismissListener { if (!done) { done = true; result.cancel() } }
            .show()
        input.requestFocus()
    }

    private fun copy(a: Activity, text: String) {
        val cm = a.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("CarbonWMS", text))
        Toast.makeText(a, R.string.copied, Toast.LENGTH_SHORT).show()
    }
}
