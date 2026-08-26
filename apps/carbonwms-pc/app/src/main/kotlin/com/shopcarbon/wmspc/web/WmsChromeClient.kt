package com.shopcarbon.wmspc.web

import android.net.Uri
import android.os.Message
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import com.shopcarbon.wmspc.MainActivity
import com.shopcarbon.wmspc.util.Diag

/**
 * Everything the web app needs from the "browser chrome": file chooser, camera permission,
 * confirm/alert/prompt dialogs, pop-up windows, fullscreen and console logging.
 */
class WmsChromeClient(private val a: MainActivity, private val isPopup: Boolean) : WebChromeClient() {

    override fun onShowFileChooser(
        webView: WebView,
        filePathCallback: ValueCallback<Array<Uri>>,
        fileChooserParams: FileChooserParams,
    ): Boolean {
        a.launchFileChooser(fileChooserParams, filePathCallback)
        return true
    }

    override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
        val child = a.popup.open()
        (resultMsg.obj as WebView.WebViewTransport).webView = child
        resultMsg.sendToTarget()
        return true
    }

    override fun onCloseWindow(window: WebView) {
        a.popup.close()
    }

    override fun onPermissionRequest(request: PermissionRequest) {
        a.runOnUiThread {
            val sameOrigin = request.origin.host.equals(a.originHost, ignoreCase = true)
            val wantsCamera = request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)
            if (sameOrigin && wantsCamera) {
                a.withCameraPermission { granted ->
                    if (granted) request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) else request.deny()
                }
            } else {
                request.deny()
            }
        }
    }

    override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult): Boolean {
        JsDialogs.alert(a, message, result)
        return true
    }

    override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean {
        JsDialogs.confirm(a, message, result)
        return true
    }

    override fun onJsBeforeUnload(view: WebView, url: String, message: String, result: JsResult): Boolean {
        JsDialogs.confirm(a, message, result)
        return true
    }

    override fun onJsPrompt(view: WebView, url: String, message: String, defaultValue: String?, result: JsPromptResult): Boolean {
        JsDialogs.prompt(a, message, defaultValue, result)
        return true
    }

    override fun onConsoleMessage(m: ConsoleMessage): Boolean {
        val src = m.sourceId()?.substringAfterLast('/') ?: ""
        Diag.log("console ${m.messageLevel()} $src:${m.lineNumber()} ${m.message()}")
        return true
    }

    override fun onShowCustomView(view: View, callback: CustomViewCallback) {
        a.showCustomView(view, callback)
    }

    override fun onHideCustomView() {
        a.hideCustomView()
    }

    override fun onReceivedTitle(view: WebView, title: String?) {
        if (isPopup) a.popup.onTitle(title, view.url)
    }
}
