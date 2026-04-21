package com.shopcarbon.wms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Handler
import android.os.Looper
import android.util.Log
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Chainway C72E UHF — direct UART path via ScannerUtility cooperative eviction.
 *
 * On connect:
 *  1. ScannerUtility.disableFunction(ctx, FUNCTION_UHF=11) — cooperative release of /dev/ttyMT1
 *  2. Poll isUhfWorking() until false (max 2s)
 *  3. UHFInit("") / UHFOpenAndConnect("") — we now own the UART directly
 *  4. UHFInventory_EX_cnt(0,0,0) + tight UHFGetReceived_EX2 drain loop at 10ms
 *
 * On teardown:
 *  ScannerUtility.enableFunction(ctx, FUNCTION_UHF=11) — restore scanner service / hardware trigger
 */
class CarbonChainwayRfidController(private val context: Context) {

  private val executor = Executors.newSingleThreadExecutor()
  private val mainHandler = Handler(Looper.getMainLooper())

  @Volatile private var tagSink: EventChannel.EventSink? = null
  @Volatile private var lastError: String? = null

  private var uhfClass: Class<*>? = null
  private var uhfInstance: Any? = null
  private val scanning = AtomicBoolean(false)
  private val requestedPowerDbm = AtomicInteger(30)
  @Volatile private var drainThread: Thread? = null
  @Volatile private var uartOwned = false

  // Cached PathClassLoader on keyboard.apk — shared by DeviceAPI and ScannerUtility
  @Volatile private var keyboardApkLoader: ClassLoader? = null

  // Session-level EPC dedup — only reset via clearSeenEpcs() from Flutter
  private val seenEpcs = java.util.Collections.newSetFromMap(
    java.util.concurrent.ConcurrentHashMap<String, Boolean>()
  )

  @Volatile private var nativeTriggerActive = false
  private var triggerReceiver: BroadcastReceiver? = null
  private var scannerWriteReceiver: BroadcastReceiver? = null

  fun getLastError(): String? = lastError

  fun clearSeenEpcs() {
    seenEpcs.clear()
    Log.d(TAG, "seenEpcs cleared")
  }

  fun setTagSink(sink: EventChannel.EventSink?) {
    tagSink = sink
    if (sink != null) registerScannerWriteReceiver() else unregisterScannerWriteReceiver()
  }

  // ── ScannerWrite broadcast receiver (fallback EPC source when UART not owned) ─

  private fun registerScannerWriteReceiver() {
    if (scannerWriteReceiver != null) return
    val r = object : BroadcastReceiver() {
      override fun onReceive(ctx: Context?, intent: Intent?) {
        val action = intent?.action ?: return
        val epc = EPC_EXTRA_KEYS.firstNotNullOfOrNull { key ->
          intent.getStringExtra(key)?.trim()?.takeIf { it.isNotEmpty() }
        } ?: EPC_BYTE_KEYS.firstNotNullOfOrNull { key ->
          intent.getByteArrayExtra(key)?.let { String(it).trim().takeIf { s -> s.isNotEmpty() } }
        } ?: return
        Log.d(TAG, "broadcast EPC action=$action epc=$epc")
        emitEpc(epc, null)
      }
    }
    val filter = IntentFilter().apply {
      EPC_BROADCAST_ACTIONS.forEach { addAction(it) }
    }
    registerReceiver(r, filter)?.let {
      scannerWriteReceiver = it
      Log.d(TAG, "EPC broadcast receiver registered: ${EPC_BROADCAST_ACTIONS.joinToString()}")
    }
  }

  private fun unregisterScannerWriteReceiver() {
    scannerWriteReceiver?.let { safeUnregister(it); scannerWriteReceiver = null }
  }

  fun setAntennaPowerDbm(dbm: Int) {
    executor.execute {
      requestedPowerDbm.set(dbm.coerceIn(0, 30))
      applyPower()
    }
  }

  // ── Connect ─────────────────────────────────────────────────────────────────

  fun connectAsync(onDone: (Throwable?) -> Unit) {
    Log.d(TAG, "connectAsync ENTERED")
    executor.execute {
      try {
        disconnectSync()

        // Pre-flight: only attempt direct UART if ScannerUtility can FUNCTIONALLY release it
        // AND this SoC is not MTK. MTK-based Chainway devices (C72E etc.) have ScannerUtility_mtk
        // which binds successfully (iScanner !== newActionUtility) but disableFunction() doesn't
        // actually evict /dev/ttyMT1 — the MTK UART port implementation keeps the fd open.
        // UHFInit then grabs the fd, UHFOpenAndConnect fails, and the scanner service is wedged.
        if (!canOwnUart()) {
          Log.w(TAG, "canOwnUart=false — broadcast-only path")
          connectBroadcastOnly(onDone)
          return@execute
        }

        val cls = resolveUhfClass() ?: run {
          Log.w(TAG, "DeviceAPI class not found — broadcast-only path")
          connectBroadcastOnly(onDone)
          return@execute
        }
        uhfClass = cls

        val inst = getStaticInstance(cls)
        if (inst == null) {
          Log.w(TAG, "DeviceAPI getInstance null — broadcast-only path")
          connectBroadcastOnly(onDone)
          return@execute
        }

        // ScannerUtility present — attempt cooperative UART takeover
        scannerUtilityConfigureBroadcast()
        val released = scannerUtilityReleaseUhf()
        if (!released) {
          Log.w(TAG, "ScannerUtility eviction failed — broadcast-only path")
          connectBroadcastOnly(onDone)
          return@execute
        }

        uhfInstance = inst
        uartOwned = initUart(cls, inst)
        if (!uartOwned) {
          Log.w(TAG, "initUart failed — recovering scanner and using broadcast path")
          recoverScannerService()
          connectBroadcastOnly(onDone)
          return@execute
        }

        Log.d(TAG, "UART owned — direct scan path active")
        lastError = null
        mainHandler.post { onDone(null) }
      } catch (e: Throwable) {
        lastError = e.message ?: e.javaClass.simpleName
        Log.e(TAG, "connect failed: ${e.message}", e)
        mainHandler.post { onDone(e) }
      }
    }
  }

  private fun connectBroadcastOnly(onDone: (Throwable?) -> Unit) {
    Log.d(TAG, "connectBroadcastOnly ENTERED")
    // SenitronBridge polls logcat for hqs EPC lines; hardware_barcode relay picks up
    // OUTPUT_BARCODE_RFID broadcasts. Neither touches /dev/ttyMT1.
    scannerUtilityConfigureBroadcast()
    MainActivity.startSystemScannerInventory(context, TAG)
    lastError = null
    mainHandler.post { onDone(null) }
  }

  private fun recoverScannerService() {
    // Recover system scanner after a failed UART takeover left /dev/ttyMT1 in bad state.
    // Uses exact actions confirmed registered by com.rscja.scanner on this firmware.
    Log.w(TAG, "recoverScannerService: nudging scanner service to re-init UART")
    scannerUtilityRestoreUhf()
    // Stop → short delay → start causes scanner service to rebuild its UART state machine
    runCatching { context.sendBroadcast(Intent("android.intent.action.BARCODESTOPSCAN").apply { addFlags(Intent.FLAG_INCLUDE_STOPPED_PACKAGES) }) }
    Thread.sleep(200)
    runCatching { context.sendBroadcast(Intent("android.intent.action.RESET").apply { addFlags(Intent.FLAG_INCLUDE_STOPPED_PACKAGES) }) }
    Thread.sleep(300)
    runCatching { context.sendBroadcast(Intent("android.intent.action.BARCODESTARTSCAN").apply { addFlags(Intent.FLAG_INCLUDE_STOPPED_PACKAGES) }) }
    Thread.sleep(500)
    Log.d(TAG, "recoverScannerService: done")
  }

  fun disconnectAsync() { executor.execute { disconnectSync() } }

  // ── Inventory ────────────────────────────────────────────────────────────────

  fun startInventoryFlutterResult(result: MethodChannel.Result) {
    Log.w(TAG, "startInventoryFlutterResult ENTERED uartOwned=$uartOwned uhfClass=${uhfClass?.simpleName}")
    if (scanning.getAndSet(true)) { mainHandler.post { result.success(null) }; return }
    executor.execute {
      try {
        val cls = uhfClass
        val inst = uhfInstance
        if (cls != null && inst != null && uartOwned) {
          applyPower()
          startDrainLoop(cls, inst)
          Log.d(TAG, "startInventory: direct UART drain active")
        } else {
          // UART not owned — use ScannerUtility.startScan to kick off UHF inventory,
          // then fall back to system scanner broadcast sequence.
          // SenitronBridge tails hqs:V logcat lines continuously.
          Log.w(TAG, "startInventory: UART not owned — startScan via ScannerUtility + startSystemScannerInventory")
          scannerUtilityStartUhfScan()
          MainActivity.startSystemScannerInventory(context, TAG)
        }
        mainHandler.post { result.success(null) }
      } catch (e: Exception) {
        scanning.set(false)
        lastError = e.message
        mainHandler.post { result.error("INVENTORY_FAILED", e.message, null) }
      }
    }
  }

  fun stopInventoryAsync() {
    if (!scanning.getAndSet(false)) return
    drainThread?.interrupt(); drainThread = null
    val cls = uhfClass; val inst = uhfInstance
    if (cls != null && inst != null && uartOwned) {
      invokeNoArgs(cls, inst, "UHFStopGet", "stopInventoryTag", "stopInventory")
    }
    // When UART not owned: do NOT stop system scanner — keep hqs EPC stream alive
    // so SenitronBridge continues forwarding EPCs to Flutter even after trigger release.
    Log.d(TAG, "stopInventory uartOwned=$uartOwned")
  }

  fun dispose() { executor.execute { disconnectSync() } }

  // ── Native trigger ──────────────────────────────────────────────────────────

  fun enableNativeTrigger() {
    if (triggerReceiver != null) return
    nativeTriggerActive = true
    val r = object : BroadcastReceiver() {
      override fun onReceive(ctx: Context?, intent: Intent?) {
        if (intent?.action != "com.rscja.android.KEY_DOWN" || !nativeTriggerActive) return
        executor.execute {
          if (scanning.get()) {
            stopInventoryAsync()
            return@execute
          }
          val cls = uhfClass; val inst = uhfInstance
          if (cls != null && inst != null && uartOwned) {
            scanning.set(true)
            startDrainLoop(cls, inst)
          }
        }
      }
    }
    registerReceiver(r, IntentFilter("com.rscja.android.KEY_DOWN"))?.let { triggerReceiver = it }
  }

  fun disableNativeTrigger() {
    nativeTriggerActive = false
    triggerReceiver?.let { safeUnregister(it); triggerReceiver = null }
  }

  // ── Broadcast eviction fallback (when ScannerUtility not on firmware) ────────

  private val myApiId = android.os.SystemClock.elapsedRealtime()

  private fun evictUartBroadcast() {
    for (action in listOf("com.rscja.deviceapi.action.UHF_POWER_OFF", "com.rscja.action.UHF_POWER_OFF")) {
      runCatching {
        context.sendBroadcast(Intent(action).apply {
          putExtra("apiId", myApiId)
          addFlags(Intent.FLAG_INCLUDE_STOPPED_PACKAGES)
        })
      }
    }
    Thread.sleep(600)
  }

  // ── ScannerUtility cooperative eviction ──────────────────────────────────────

  // MTK SoC gate + ScannerUtility functional check combined.
  // MTK-based Chainway firmware (C72E, HC720*) has ScannerUtility_mtk that binds correctly
  // but disableFunction(FUNCTION_UHF) doesn't actually release /dev/ttyMT1. Force broadcast-only
  // on MTK until we have an empirical probe (UartCapabilityProbe) to verify per firmware build.
  private fun canOwnUart(): Boolean {
    val hw = android.os.Build.HARDWARE ?: ""
    val board = android.os.Build.BOARD ?: ""
    val isMtk = hw.startsWith("mt", ignoreCase = true) || board.startsWith("mt", ignoreCase = true)
    if (isMtk) {
      Log.i(TAG, "MTK SoC detected (HARDWARE=$hw BOARD=$board) — forcing broadcast-only RFID mode")
      return false
    }
    return scannerUtilityFunctional()
  }

  // Cached per process lifetime — probe is expensive and deterministic.
  @Volatile private var scannerUtilityFunctionalCache: Boolean? = null

  private fun scannerUtilityFunctional(): Boolean {
    scannerUtilityFunctionalCache?.let { return it }
    val result = probeScannerUtilityFunctional()
    scannerUtilityFunctionalCache = result
    return result
  }

  private fun probeScannerUtilityFunctional(): Boolean {
    // Chainway ScannerUtility binds to com.rscja.scanner at runtime via AIDL.
    // If the bind fails (wrong firmware, wrong service), iScanner stays as the
    // sentinel newActionUtility placeholder — every method silently no-ops.
    // Probe via reflection: iScanner !== newActionUtility (reference identity).
    return try {
      val cls = resolveScannerUtilityClass() ?: return false.also {
        Log.w(TAG, "ScannerUtility class not found — not functional")
      }
      val inst = cls.getMethod("getScannerInerface").invoke(null) ?: return false.also {
        Log.w(TAG, "getScannerInerface() returned null — not functional")
      }
      val iScannerField = runCatching {
        cls.getDeclaredField("iScanner").apply { isAccessible = true }
      }.getOrNull() ?: return false.also {
        Log.w(TAG, "iScanner field not found — not functional")
      }
      val stubField = runCatching {
        cls.getDeclaredField("newActionUtility").apply { isAccessible = true }
      }.getOrNull()

      val iScanner = iScannerField.get(inst)
      val stub = stubField?.get(inst)
      Log.d(TAG, "ScannerUtility probe: iScanner=${iScanner?.javaClass?.name} stub=${stub?.javaClass?.name}")

      val functional = iScanner != null && (stub == null || iScanner !== stub)
      Log.d(TAG, "ScannerUtility functional=$functional")
      functional
    } catch (e: Throwable) {
      Log.w(TAG, "ScannerUtility functional probe error: ${e.message}")
      false
    }
  }

  private fun resolveScannerUtilityClass(): Class<*>? {
    // 1. Bundled AAR (preferred — always present regardless of firmware)
    runCatching {
      val cls = Class.forName("com.rscja.scanner.utility.ScannerUtility")
      Log.d(TAG, "ScannerUtility loaded from bundled AAR")
      return cls
    }
    // 2. PathClassLoader on keyboard.apk (firmware that ships it)
    keyboardApkLoader?.let { loader ->
      runCatching {
        val cls = loader.loadClass("com.rscja.scanner.utility.ScannerUtility")
        Log.d(TAG, "ScannerUtility loaded from keyboard.apk")
        return cls
      }
    }
    Log.w(TAG, "ScannerUtility not found in bundled AAR or keyboard.apk")
    return null
  }

  private fun scannerUtilityConfigureBroadcast() {
    // On MTK C72E, enableFunction/disableFunction/setUHFMode are no-ops — the native MTK
    // implementation is a skeleton that doesn't affect /dev/ttyMT1 or scanner_target.
    // Only configure what demonstrably sticks: output mode + broadcast routing.
    try {
      val cls = resolveScannerUtilityClass() ?: return
      val inst = cls.getMethod("getScannerInerface").invoke(null) ?: return

      // setOutputMode(ctx, 1) = broadcast mode (0 = keyboard wedge)
      runCatching {
        cls.getMethod("setOutputMode", Context::class.java, Int::class.javaPrimitiveType)
          .invoke(inst, context, 1)
        Log.d(TAG, "ScannerUtility.setOutputMode(ctx, 1) — broadcast mode")
      }.onFailure { Log.w(TAG, "setOutputMode failed: ${it.message}") }

      // setScanResultBroadcastRFID — route RFID EPCs to our registered receiver
      runCatching {
        cls.getMethod("setScanResultBroadcastRFID", Context::class.java, String::class.java, String::class.java)
          .invoke(inst, context, SCANNER_WRITE_EPC_ACTION, SCANNER_WRITE_EPC_KEY)
        Log.d(TAG, "ScannerUtility.setScanResultBroadcastRFID → $SCANNER_WRITE_EPC_ACTION / $SCANNER_WRITE_EPC_KEY")
      }.onFailure { Log.w(TAG, "setScanResultBroadcastRFID failed: ${it.message}") }

      // setContinuousScanRFID — multi-tag continuous mode
      runCatching {
        cls.getMethod("setContinuousScanRFID", Context::class.java, Boolean::class.javaPrimitiveType)
          .invoke(inst, context, true)
        Log.d(TAG, "ScannerUtility.setContinuousScanRFID(true)")
      }.onFailure { Log.w(TAG, "setContinuousScanRFID failed: ${it.message}") }

      // setContinuousScanIntervalTimeRFID — no delay between reads
      runCatching {
        cls.getMethod("setContinuousScanIntervalTimeRFID", Context::class.java, Int::class.javaPrimitiveType)
          .invoke(inst, context, 0)
        Log.d(TAG, "ScannerUtility.setContinuousScanIntervalTimeRFID(0)")
      }.onFailure { Log.w(TAG, "setContinuousScanIntervalTimeRFID failed: ${it.message}") }

    } catch (e: Throwable) {
      Log.w(TAG, "scannerUtilityConfigureBroadcast error: ${e.message}", e)
    }
  }

  private fun scannerUtilityStartUhfScan() {
    try {
      val cls = resolveScannerUtilityClass() ?: return
      val inst = cls.getMethod("getScannerInerface").invoke(null) ?: return
      val functionId = runCatching { cls.getField("FUNCTION_UHF").getInt(null) }.getOrElse { FUNCTION_UHF }
      // startScan(ctx, functionId) — directly triggers a UHF scan cycle via the scanner service
      runCatching {
        cls.getMethod("startScan", Context::class.java, Int::class.javaPrimitiveType)
          .invoke(inst, context, functionId)
        Log.d(TAG, "ScannerUtility.startScan(ctx, $functionId) — UHF scan started")
      }.onFailure { Log.w(TAG, "startScan($functionId) failed: ${it.message}") }
    } catch (e: Throwable) {
      Log.w(TAG, "scannerUtilityStartUhfScan error: ${e.message}")
    }
  }

  private fun scannerUtilityReleaseUhf(): Boolean {
    return try {
      val cls = resolveScannerUtilityClass() ?: return false

      val declaredFunctionUhf = runCatching { cls.getField("FUNCTION_UHF").getInt(null) }.getOrElse { -1 }
      if (declaredFunctionUhf != FUNCTION_UHF) {
        Log.w(TAG, "FUNCTION_UHF mismatch: expected $FUNCTION_UHF got $declaredFunctionUhf — using declared value")
      }
      val functionId = if (declaredFunctionUhf > 0) declaredFunctionUhf else FUNCTION_UHF

      val inst = cls.getMethod("getScannerInerface").invoke(null)
        ?: run { Log.w(TAG, "ScannerUtility.getScannerInerface() returned null"); return false }

      val disableFn = cls.getMethod("disableFunction", Context::class.java, Int::class.javaPrimitiveType)
      val isWorkingFn = cls.getMethod("isUhfWorking", Context::class.java)

      Log.d(TAG, "ScannerUtility.disableFunction(ctx, $functionId)")
      disableFn.invoke(inst, context, functionId)

      // Poll until UHF is released (max 2s)
      var waited = 0
      while (waited < 2000) {
        val busy = isWorkingFn.invoke(inst, context) as? Boolean ?: false
        if (!busy) {
          Log.d(TAG, "ScannerUtility: UHF released after ${waited}ms")
          return true
        }
        Thread.sleep(50); waited += 50
      }
      Log.w(TAG, "ScannerUtility: isUhfWorking still true after 2s")
      false
    } catch (e: Throwable) {
      Log.w(TAG, "scannerUtilityReleaseUhf error: ${e.message}", e)
      false
    }
  }

  private fun scannerUtilityRestoreUhf() {
    try {
      val cls = resolveScannerUtilityClass() ?: return
      val inst = runCatching { cls.getMethod("getScannerInerface").invoke(null) }.getOrNull() ?: return
      val enableFn = runCatching { cls.getMethod("enableFunction", Context::class.java, Int::class.javaPrimitiveType) }.getOrNull() ?: return
      val functionId = runCatching { cls.getField("FUNCTION_UHF").getInt(null) }.getOrElse { FUNCTION_UHF }
      enableFn.invoke(inst, context, functionId)
      Log.d(TAG, "ScannerUtility.enableFunction(ctx, $functionId) — UHF restored")
    } catch (e: Throwable) {
      Log.w(TAG, "scannerUtilityRestoreUhf error: ${e.message}")
    }
  }

  // ── UART init ───────────────────────────────────────────────────────────────

  private fun initUart(cls: Class<*>, inst: Any): Boolean {
    val appCtx = context.applicationContext
    val uartPaths = listOf("", "/dev/ttyMT1", "/dev/ttyMT0", "/dev/ttyMT2")

    val mInit = cls.methods.firstOrNull { it.name == "UHFInit" } ?: run {
      Log.w(TAG, "UHFInit method not found"); return false
    }
    mInit.isAccessible = true
    var initOk = false
    for (uart in uartPaths) {
      val args = mInit.parameterTypes.map { t -> when {
        t == Context::class.java -> appCtx
        t == String::class.java -> uart
        t == Int::class.javaPrimitiveType || t == java.lang.Integer.TYPE -> 0
        else -> null
      }}.toTypedArray()
      val r = timedInvoke(5000) { (mInit.invoke(inst, *args) as? Number)?.toInt() ?: -1 }
      Log.d(TAG, "UHFInit('$uart') -> $r")
      if (r == 0) { initOk = true; break }
    }
    if (!initOk) { Log.w(TAG, "UHFInit failed all paths"); return false }

    val mOpen = cls.methods.firstOrNull { it.name == "UHFOpenAndConnect" }
    if (mOpen != null) {
      mOpen.isAccessible = true
      for (uart in uartPaths) {
        val args = mOpen.parameterTypes.map { t -> if (t == String::class.java) uart else null }.toTypedArray()
        val r = timedInvoke(5000) { (mOpen.invoke(inst, *args) as? Number)?.toInt() ?: -1 }
        Log.d(TAG, "UHFOpenAndConnect('$uart') -> $r")
        if (r >= 0) { Log.d(TAG, "UART takeover complete via UHFOpenAndConnect"); return true }
      }
      // All paths failed — release via UHFFree only (UHFCloseAndDisconnect is called internally).
      // Double-closing causes inconsistent kernel port state on some Chainway firmware.
      Log.w(TAG, "UHFOpenAndConnect failed all paths — releasing via UHFFree")
      invokeNoArgs(cls, inst, "UHFFree")
      System.gc()
      Thread.sleep(50)
      return false
    }

    Log.d(TAG, "UHFOpenAndConnect not found — UHFInit-only path OK"); return true
  }

  // ── Drain loop ──────────────────────────────────────────────────────────────

  private fun startDrainLoop(cls: Class<*>, inst: Any) {
    val mInv = cls.methods.firstOrNull { it.name == "UHFInventory_EX_cnt" }
      ?: cls.methods.firstOrNull { it.name == "UHFInventory_EX" }
      ?: cls.methods.firstOrNull { it.name == "UHFInventory" }
    mInv?.isAccessible = true

    val invArgs: Array<Any?> = if (mInv != null) {
      var ci = 0
      mInv.parameterTypes.map { t -> when {
        t == java.lang.Character.TYPE -> java.lang.Character(if (ci++ == 0) '\u0000' else '\u0000')
        t == java.lang.Integer.TYPE -> java.lang.Integer(0)
        else -> null
      }}.toTypedArray()
    } else arrayOf()

    cls.methods.firstOrNull { it.name == "startInventory" && it.parameterCount == 3 }?.let { m ->
      m.isAccessible = true
      runCatching { m.invoke(inst, 0, 0, 6) }
      Log.d(TAG, "startInventory(0,0,6) called")
    }

    if (mInv != null) {
      val r = runCatching { mInv.invoke(inst, *invArgs) }.getOrNull()
      Log.d(TAG, "${mInv.name}() -> $r")
    }

    val mGet = cls.methods.firstOrNull { it.name == "UHFGetReceived_EX2" }
    mGet?.isAccessible = true
    val buf = CharArray(256)

    val t = Thread {
      Log.d(TAG, "drain loop started, mGet=${mGet?.name}")
      var total = 0
      var empty = 0
      while (scanning.get()) {
        try {
          if (mGet != null) {
            buf.fill('\u0000')
            val cnt = runCatching { (mGet.invoke(inst, buf) as? Number)?.toInt() ?: -1 }.getOrElse { -1 }
            if (cnt > 0) {
              empty = 0
              val epc = parseEpcFromBuf(buf)
              if (epc != null) {
                emitEpc(epc, null)
                if (++total % 10 == 0) Log.d(TAG, "drain: $total EPCs emitted")
              }
            } else {
              empty++
              if (empty % 20 == 0 && mInv != null) runCatching { mInv.invoke(inst, *invArgs) }
              android.os.SystemClock.sleep(10)
            }
          } else {
            android.os.SystemClock.sleep(50)
          }
        } catch (_: InterruptedException) { break }
        catch (e: Exception) { Log.w(TAG, "drain err: ${e.message}") }
      }
      Log.d(TAG, "drain loop exited, total=$total")
    }
    t.isDaemon = true; t.name = "chainway-drain"; t.start()
    drainThread = t
  }

  private fun parseEpcFromBuf(buf: CharArray): String? {
    val bytes = buf.map { it.code and 0xFF }
    val lastNz = bytes.take(64).indexOfLast { it != 0 }
    if (lastNz < 0) return null
    val hex = bytes.take(lastNz + 1).joinToString("") { "%02X".format(it) }
    val clean = hex.replace(Regex("[^0-9A-F]"), "")
    return if (clean.isNotEmpty()) clean else null
  }

  // ── Class resolution ─────────────────────────────────────────────────────────

  fun resolveUhfClass(): Class<*>? {
    Log.d(TAG, "resolveUhfClass ENTERED")
    val classNames = listOf(
      "com.rscja.deviceapi.DeviceAPI",
      "com.rscja.team.mtk.deviceapi.DeviceAPI",
      "com.rscja.deviceapi.RFIDWithUHFUART",
      "com.rscja.deviceapi.RFIDWithUHF",
    )
    val nativeLibPath = "/vendor/lib:/vendor/lib64:/system/lib:/system/lib64"
    val optDir = context.applicationContext.getDir("dex_opt", android.content.Context.MODE_PRIVATE)

    for (n in classNames) {
      try { return Class.forName(n).also { Log.d(TAG, "Class.forName(system): $n") } } catch (_: Throwable) {}
    }

    val scannerApkPaths = listOf(
      "/system/app/keyboard/keyboard.apk",
      "/system/app/Scanner/Scanner.apk",
      "/system/priv-app/Scanner/Scanner.apk",
    )
    for (apkPath in scannerApkPaths) {
      if (!java.io.File(apkPath).exists()) continue
      try {
        val cl = dalvik.system.PathClassLoader(apkPath, nativeLibPath, ClassLoader.getSystemClassLoader())
        for (n in classNames) {
          try {
            val cls = cl.loadClass(n)
            Log.d(TAG, "PathClassLoader($apkPath): $n")
            // Cache this loader for ScannerUtility use
            keyboardApkLoader = cl
            // Probe ScannerUtility presence
            runCatching {
              val su = cl.loadClass("com.rscja.scanner.utility.ScannerUtility")
              val fuhf = su.getField("FUNCTION_UHF").getInt(null)
              Log.i(TAG, "ScannerUtility found in $apkPath, FUNCTION_UHF=$fuhf")
            }.onFailure { Log.w(TAG, "ScannerUtility not found in $apkPath: ${it.message}") }
            return cls
          } catch (_: Throwable) {}
        }
      } catch (e: Throwable) { Log.w(TAG, "PathClassLoader($apkPath) failed: ${e.message}") }
    }

    try {
      val appCtx = context.applicationContext
      val dexFile = java.io.File(appCtx.cacheDir, "chainway_uhf.dex")
      if (!dexFile.exists()) {
        appCtx.assets.open("chainway_uhf.dex").use { i -> dexFile.outputStream().use { o -> i.copyTo(o) } }
      }
      val cl = dalvik.system.DexClassLoader(dexFile.absolutePath, optDir.absolutePath, nativeLibPath, appCtx.classLoader)
      for (n in classNames) {
        try { return cl.loadClass(n).also { Log.d(TAG, "DexClassLoader(bundled): $n") } } catch (_: Throwable) {}
      }
    } catch (e: Throwable) { Log.w(TAG, "DexClassLoader(bundled) failed: ${e.message}") }

    return null
  }

  private fun getStaticInstance(cls: Class<*>): Any? {
    val appCtx = context.applicationContext
    for (libPath in listOf("/vendor/lib/libDeviceAPI.so", "/vendor/lib64/libDeviceAPI.so", "/system/lib/libDeviceAPI.so")) {
      runCatching { System.load(libPath); Log.d(TAG, "loaded $libPath") }
    }
    for (lib in listOf("DeviceAPI", "rscja_deviceapi", "uhfapi")) runCatching { System.loadLibrary(lib) }
    runCatching { cls.getMethod("getInstance", Context::class.java).invoke(null, appCtx)?.let { Log.d(TAG, "getInstance(ctx) ok"); return it } }
    runCatching { cls.getMethod("getInstance").invoke(null)?.let { Log.d(TAG, "getInstance() ok"); return it } }
    runCatching { cls.getDeclaredConstructor().apply { isAccessible = true }.newInstance()?.let { Log.d(TAG, "constructor() ok"); return it } }
    return null
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private fun applyPower() {
    val cls = uhfClass ?: return; val inst = uhfInstance ?: return
    val p = requestedPowerDbm.get().coerceIn(0, 30)
    val m = cls.methods.firstOrNull { it.name in setOf("UHFSetPower", "setPower", "SetPower", "setOutputPower") && it.parameterCount == 1 }
      ?.also { it.isAccessible = true } ?: return
    val arg: Any = if (m.parameterTypes[0] == java.lang.Character.TYPE) java.lang.Character(p.toChar()) else java.lang.Integer(p)
    runCatching { m.invoke(inst, arg) }
    Log.d(TAG, "${m.name}($p) applied")
  }

  private fun invokeNoArgs(cls: Class<*>, inst: Any, vararg names: String) {
    for (name in names) {
      cls.methods.firstOrNull { it.name == name && it.parameterCount == 0 }?.let { m ->
        m.isAccessible = true; runCatching { m.invoke(inst) }; Log.d(TAG, "$name() invoked")
      }
    }
  }

  private fun timedInvoke(timeoutMs: Long, block: () -> Int): Int {
    val exec = Executors.newSingleThreadExecutor()
    val f = exec.submit<Int> { runCatching(block).getOrElse { -99 } }
    return try { f.get(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS) }
    catch (e: java.util.concurrent.TimeoutException) { f.cancel(true); -98 }
    catch (_: Exception) { -97 }
    finally { exec.shutdownNow() }
  }

  private fun registerReceiver(r: BroadcastReceiver, filter: IntentFilter): BroadcastReceiver? {
    return try {
      if (android.os.Build.VERSION.SDK_INT >= 33) {
        context.registerReceiver(r, filter, Context.RECEIVER_EXPORTED)
      } else {
        @Suppress("DEPRECATION") context.registerReceiver(r, filter)
      }
      r
    } catch (e: Exception) { Log.w(TAG, "registerReceiver failed: ${e.message}"); null }
  }

  private fun safeUnregister(r: BroadcastReceiver) {
    try { context.unregisterReceiver(r) } catch (_: Exception) {}
  }

  private fun disconnectSync() {
    disableNativeTrigger()
    unregisterScannerWriteReceiver()
    scanning.set(false)
    drainThread?.interrupt(); drainThread = null
    val cls = uhfClass; val inst = uhfInstance
    if (cls != null && inst != null) {
      invokeNoArgs(cls, inst, "UHFStopGet", "UHFCloseAndDisconnect", "UHFFree", "stopInventory")
    }
    if (uartOwned) {
      // Restore UHF to system scanner service so hardware trigger works again
      scannerUtilityRestoreUhf()
    }
    uartOwned = false
    uhfClass = null; uhfInstance = null
    // seenEpcs intentionally NOT cleared — dedup persists across start/stop cycles
  }

  private fun emitEpc(hex: String, rssi: Int?) {
    val up = hex.uppercase().replace(Regex("[^0-9A-F]"), "")
    if (up.isEmpty()) return
    if (!seenEpcs.add(up)) return
    Log.d(TAG, "EPC: $up")
    val sink = tagSink ?: return
    mainHandler.post { sink.success(mapOf("epc" to up, "rssi" to (rssi ?: 0))) }
  }

  companion object {
    private const val TAG = "CarbonChainway"
    private const val FUNCTION_UHF = 11

    const val SCANNER_WRITE_EPC_ACTION = "com.shopcarbon.wms.RFID_EPC"
    const val SCANNER_WRITE_EPC_KEY = "epc"

    // All broadcast actions that may carry an EPC from the scanner service.
    // android.intent.action.scanner.RFID is the firmware's own default (from KeyboardHelperParam.xml
    // scanner_etBroadcastRFID field — confirmed on C72E MTK after trigger press).
    private val EPC_BROADCAST_ACTIONS = setOf(
      SCANNER_WRITE_EPC_ACTION,
      "com.rscja.android.ScannerWrite",
      "android.intent.action.scanner.RFID",   // C72E MTK firmware default
      "com.rscja.scanner.action.OUTPUT_BARCODE_RFID",
      "android.intent.action.BARCODEOUTPUT",
    )

    private val EPC_EXTRA_KEYS = arrayOf(
      SCANNER_WRITE_EPC_KEY, "epc", "EPC", "scannerdata", "SCAN_DATA", "data",
      "barcode_string", "BARCODE_STRING", "scan_data", "barcodeCode", "data_result",
    )
    private val EPC_BYTE_KEYS = arrayOf("scannerdata", "SCAN_DATA", "data", "barcode")
  }
}
