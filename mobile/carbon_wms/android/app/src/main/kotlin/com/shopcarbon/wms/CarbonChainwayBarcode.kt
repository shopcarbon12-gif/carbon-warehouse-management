package com.shopcarbon.wms

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.rscja.barcode.BarcodeDecoder
import com.rscja.barcode.BarcodeFactory
import com.rscja.deviceapi.entity.BarcodeEntity
import io.flutter.plugin.common.MethodChannel
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Direct Chainway barcode SDK bridge — bypasses com.rscja.scanner / broadcast routing.
 *
 *  - [BarcodeFactory.getInstance].getBarcodeDecoder() returns a singleton-ish [BarcodeDecoder]
 *    bound to the device's 2D engine (Newland N1/N2/N3 on C72E etc).
 *  - [BarcodeDecoder.open] grabs the same UART (/dev/ttyMT1) on MTK C72E that UHF uses.
 *    Cooperative eviction is therefore required: caller must ensure UHF is disconnected
 *    before [open], and conversely must call [close] before any UHF connect.
 *
 * Decoded text reaches Flutter via the existing `carbon_wms/rfid` MethodChannel as a
 * `barcode.onDecode` *call-from-platform* (handled in Dart via `setMethodCallHandler`),
 * carrying `{ barcode: String, symbology: Int, decodeTime: Int }`.
 */
class CarbonChainwayBarcode(
  private val context: Context,
) {
  private val mainHandler = Handler(Looper.getMainLooper())

  @Volatile private var decoder: BarcodeDecoder? = null
  private val opened = AtomicBoolean(false)
  private val scanning = AtomicBoolean(false)

  // Reference to the same MethodChannel that owns "carbon_wms/rfid", set by MainActivity
  // after construction. Decode events become `invokeMethod("barcode.onDecode", ...)` calls
  // from platform → Flutter, mirroring the pattern Senitron-style reference apps use.
  @Volatile private var channel: MethodChannel? = null

  fun bindMethodChannel(c: MethodChannel) {
    channel = c
  }

  /** Idempotent. Returns true if the decoder is open after this call. */
  fun open(): Boolean {
    if (opened.get()) return true
    val d = decoder ?: runCatching {
      BarcodeFactory.getInstance().barcodeDecoder
    }.onFailure {
      Log.w(TAG, "BarcodeFactory.getBarcodeDecoder() threw: ${it.message}")
    }.getOrNull() ?: return false
    decoder = d
    val ok = runCatching { d.open(context.applicationContext) }
      .onFailure { Log.w(TAG, "decoder.open failed: ${it.message}") }
      .getOrDefault(false)
    if (ok) {
      opened.set(true)
      runCatching {
        d.setDecodeCallback { entity: BarcodeEntity? ->
          handleDecode(entity)
        }
        Log.i(TAG, "BarcodeDecoder opened + callback set")
      }.onFailure { Log.w(TAG, "setDecodeCallback failed: ${it.message}") }
    } else {
      Log.w(TAG, "BarcodeDecoder.open(ctx) returned false — engine unavailable")
    }
    return ok
  }

  /** Idempotent. Stops any in-flight scan and releases the engine + UART. */
  fun close() {
    if (!opened.get()) return
    if (scanning.getAndSet(false)) {
      runCatching { decoder?.stopScan() }
        .onFailure { Log.w(TAG, "decoder.stopScan on close failed: ${it.message}") }
    }
    runCatching { decoder?.close() }
      .onFailure { Log.w(TAG, "decoder.close failed: ${it.message}") }
    opened.set(false)
    Log.i(TAG, "BarcodeDecoder closed (UART released)")
  }

  /** Fire the laser. Lazily opens if not yet opened. Returns true if scan was issued. */
  fun startScan(): Boolean {
    if (!opened.get() && !open()) return false
    if (scanning.get()) return true
    val ok = runCatching { decoder?.startScan() ?: false }
      .onFailure { Log.w(TAG, "decoder.startScan failed: ${it.message}") }
      .getOrDefault(false)
    if (ok) scanning.set(true)
    Log.d(TAG, "decoder.startScan -> $ok")
    return ok
  }

  /** Stop an in-flight scan (no-op if not scanning). */
  fun stopScan(): Boolean {
    if (!opened.get()) return true
    if (!scanning.getAndSet(false)) return true
    runCatching { decoder?.stopScan() }
      .onFailure { Log.w(TAG, "decoder.stopScan failed: ${it.message}") }
    return true
  }

  fun isOpen(): Boolean = opened.get()

  fun dispose() {
    close()
    decoder = null
    channel = null
  }

  private fun handleDecode(entity: BarcodeEntity?) {
    // Decode callback fires on the SDK's worker thread; clear the scanning latch so
    // a subsequent KEY_DOWN can re-arm without an explicit stopScan call.
    scanning.set(false)
    if (entity == null) return
    if (entity.resultCode != BarcodeDecoder.DECODE_SUCCESS) {
      Log.d(TAG, "decode resultCode=${entity.resultCode} (non-success)")
      return
    }
    val data = entity.barcodeData?.trim().orEmpty()
    if (data.isEmpty()) return
    val payload = mapOf(
      "barcode" to data,
      "symbology" to entity.barcodeSymbology,
      "decodeTime" to entity.decodeTime,
    )
    Log.d(TAG, "decode ok len=${data.length} sym=${entity.barcodeSymbology}")
    val ch = channel
    if (ch == null) {
      Log.w(TAG, "no MethodChannel bound — drop decode")
      return
    }
    mainHandler.post { ch.invokeMethod("barcode.onDecode", payload) }
  }

  private companion object {
    const val TAG = "CarbonChainwayBarcode"
  }
}
