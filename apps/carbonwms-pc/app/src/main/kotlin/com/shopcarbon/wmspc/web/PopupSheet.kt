package com.shopcarbon.wmspc.web

import android.view.LayoutInflater
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.TextView
import androidx.core.view.isVisible
import com.shopcarbon.wmspc.MainActivity
import com.shopcarbon.wmspc.R

/**
 * Full-screen sheet hosting a child WebView for window.open / target=_blank.
 * Same-origin pages (transfer-slip print page) render here with Close/Print;
 * off-origin navigations are handed to the system browser and the sheet closes.
 * Supports the "open blank tab, then set location" pattern used by the catalog matrix modal.
 */
class PopupSheet(private val a: MainActivity, private val container: ViewGroup) {
    private val host: FrameLayout
    private val title: TextView
    private var child: WebView? = null

    val isOpen: Boolean get() = container.isVisible
    fun current(): WebView? = child

    init {
        val v = LayoutInflater.from(a).inflate(R.layout.view_popup, container, false)
        container.addView(v)
        host = v.findViewById(R.id.popup_host)
        title = v.findViewById(R.id.popup_title)
        v.findViewById<ImageButton>(R.id.popup_close).setOnClickListener { close() }
        v.findViewById<ImageButton>(R.id.popup_print).setOnClickListener { child?.let { PrintBridge.print(a, it) } }
    }

    fun open(): WebView {
        close()
        val w = WebView(a)
        WebViewConfig.apply(w, a)
        w.addJavascriptInterface(NativeBridge(a) { w }, NativeBridge.NAME)
        w.webViewClient = WmsWebViewClient(a, isPopup = true)
        w.webChromeClient = WmsChromeClient(a, isPopup = true)
        w.setDownloadListener(DownloadBridge(a))
        host.addView(w, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        child = w
        title.text = ""
        container.isVisible = true
        return w
    }

    fun close() {
        child?.let {
            host.removeView(it)
            it.destroy()
        }
        child = null
        container.isVisible = false
    }

    fun onTitle(t: String?, url: String?) {
        title.text = t?.takeIf { it.isNotBlank() } ?: url ?: ""
    }
}
