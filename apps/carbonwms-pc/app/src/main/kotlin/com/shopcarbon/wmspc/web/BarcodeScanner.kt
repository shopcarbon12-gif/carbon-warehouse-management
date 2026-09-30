package com.shopcarbon.wmspc.web

import com.google.android.gms.common.moduleinstall.ModuleInstall
import com.google.android.gms.common.moduleinstall.ModuleInstallRequest
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.shopcarbon.wmspc.MainActivity
import com.shopcarbon.wmspc.util.Diag

/**
 * Barcode scanning for the web app: `window.CarbonWMSPC.scanBarcode()`.
 *
 * Uses Google's code scanner rather than a camera preview of our own. It reads
 * every 1D and 2D symbology (the Carbon hang tag, a supplier's QR, a Data
 * Matrix), auto-zooms onto a small or creased label, and runs inside Google
 * Play services — so the shell needs no camera permission for it and there is
 * no preview surface to fight the WebView for.
 *
 * The scanner module is delivered by Play services and may not be on the device
 * yet; the first call asks for it explicitly so the operator gets "installing"
 * rather than an opaque failure.
 */
object BarcodeScanner {

    /** `done(ok, text)` — text is the barcode on success, otherwise a reason to show. */
    fun scan(a: MainActivity, done: (Boolean, String) -> Unit) {
        val options = GmsBarcodeScannerOptions.Builder()
            .enableAutoZoom() // small hang-tag codes without making the operator lean in
            .build()
        val scanner = GmsBarcodeScanning.getClient(a, options)

        fun start() {
            scanner.startScan()
                .addOnSuccessListener { barcode ->
                    val text = barcode.rawValue?.trim().orEmpty()
                    Diag.log("scan ok (${text.length} chars)")
                    if (text.isEmpty()) done(false, "That code could not be read — try again.")
                    else done(true, text)
                }
                .addOnCanceledListener {
                    Diag.log("scan cancelled")
                    done(false, "")
                }
                .addOnFailureListener { e ->
                    Diag.log("scan failed: $e")
                    done(false, "Scanner unavailable on this device (${e.message ?: "unknown error"}).")
                }
        }

        /* Make sure the scanner module is present. If the request itself fails we
           still try to scan — on most devices the module is already installed and
           refusing here would be worse than letting startScan report the truth. */
        runCatching {
            ModuleInstall.getClient(a)
                .installModules(ModuleInstallRequest.newBuilder().addApi(scanner).build())
                .addOnSuccessListener { start() }
                .addOnFailureListener { e ->
                    Diag.log("scanner module install failed: $e")
                    start()
                }
        }.onFailure {
            Diag.log("module install request threw: $it")
            start()
        }
    }
}
