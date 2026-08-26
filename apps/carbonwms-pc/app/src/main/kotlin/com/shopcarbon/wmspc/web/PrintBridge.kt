package com.shopcarbon.wmspc.web

import android.app.Activity
import android.content.Context
import android.print.PrintAttributes
import android.print.PrintManager
import android.webkit.WebView
import com.shopcarbon.wmspc.util.Diag

/** window.print() → Android print framework (any Wi-Fi/USB printer, or Save as PDF). */
object PrintBridge {
    fun print(a: Activity, web: WebView) {
        runCatching {
            val pm = a.getSystemService(Context.PRINT_SERVICE) as PrintManager
            val name = "CarbonWMS ${web.title.orEmpty()}".trim()
            pm.print(name, web.createPrintDocumentAdapter(name), PrintAttributes.Builder().build())
            Diag.log("print job: $name")
        }.onFailure { Diag.log("print failed: $it") }
    }
}
