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
        Log.d(TAG, "RX action=$action extras=${intent.extras?.keySet()?.joinToString() ?: "<none>"}")
        var epc = EPC_EXTRA_KEYS.firstNotNullOfOrNull { key ->
          intent.getStringExtra(key)?.let { extractHexCandidate(it) }
        } ?: EPC_BYTE_KEYS.firstNotNullOfOrNull { key ->
          intent.getByteArrayExtra(key)?.let { extractHexCandidateFromBytes(it) }
        }
        // Some scanner firmware/builds use unknown extra keys. Fallback: inspect all extras.
        if (epc.isNullOrBlank()) {
          val extras = intent.extras
          if (extras != null) {
            for (key in extras.keySet()) {
              val v = extras.get(key) ?: continue
              when (v) {
                is String -> {
                  val s = extractHexCandidate(v)
                  if (s.isNotEmpty()) {
                    epc = s
                    break
                  }
                }
                is ByteArray -> {
                  val s = runCatching { extractHexCandidateFromBytes(v) }.getOrDefault("")
                  if (s.isNotEmpty()) {
                    epc = s
                    break
                  }
                }
              }
            }
          }
        }
        val epcValue = epc
        if (epcValue.isNullOrBlank()) {
          val extrasDump = buildString {
            val extras = intent.extras
            if (extras == null) {
              append("<none>")
            } else {
              for (key in extras.keySet()) {
                val value = extras.get(key)
                append(key).append("=")
                append(
                  when (value) {
                    is ByteArray -> "byte[${value.size}]"
                    else -> value?.toString() ?: "null"
                  }
                ).append("; ")
              }
            }
          }
          Log.w(TAG, "broadcast EPC parse miss action=$action extras=$extrasDump")
          return
        }
        Log.d(TAG, "broadcast EPC action=$action epc=$epcValue")
        emitEpc(epcValue, null)
      }
    }
    val filter = IntentFilter().apply {
      EPC_BROADCAST_ACTIONS.forEach { addAction(it) }
      // com.rscja.android.ScannerWrite is a file-copy notification, never carries EPC data.
      // Intentionally excluded from filter to avoid noise.
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
    Log.d(TAG, "connectAsync ENTERED uartOwned=$uartOwned")
    executor.execute {
      try {
        // If UART already owned, nothing to do.
        if (uartOwned) {
          Log.d(TAG, "connectAsync: UART already owned — skipping reconnect")
          mainHandler.post { onDone(null) }
          return@execute
        }

        // Do NOT teardown on reconnect — UHFCloseAndDisconnect releases /dev/ttyMT1
        // back to the scanner service, after which UHFInit always returns -1.
        // Only dispose() tears down; here we just attempt to (re)acquire.

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

        // ScannerUtility present — attempt direct UART takeover without eviction.
        // On MTK C72E, disableFunction() is a no-op stub that doesn't release /dev/ttyMT1.
        // Calling it wakes the scanner service. Instead, configure broadcast routing first
        // (non-destructive), then attempt UART open directly — if the scanner service is
        // idle the port is available; if not, we fall back to broadcast.
        scannerUtilityConfigureBroadcast()

        uhfInstance = inst
        uartOwned = initUart(cls, inst)
        if (!uartOwned) {
          Log.w(TAG, "initUart failed — broadcast-only path (scanner service holds UART)")
          connectBroadcastOnly(onDone)
          return@execute
        }

        Log.d(TAG, "UART owned — direct scan path active")
        lastError = null
        // Auto-start drain loop immediately — don't wait for Flutter startInventory call.
        scanning.set(true)
        applyPower()
        startDrainLoop(cls, inst)
        Log.d(TAG, "drain loop auto-started after UART acquire")
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
    Log.d(TAG, "startInventoryFlutterResult uartOwned=$uartOwned scanning=${scanning.get()}")
    executor.execute {
      try {
        if (uartOwned) {
          // legacy UART path — unreachable after canOwnUart=false, kept for safety
          val cls = uhfClass; val inst = uhfInstance
          if (cls != null && inst != null && !scanning.getAndSet(true)) {
            applyPower()
            startDrainLoop(cls, inst)
          }
        } else {
          // Broadcast-only: arm the firmware's continuous UHF inventory.
          scannerUtilityStartUhfScan()
          scanning.set(true)
          Log.d(TAG, "startInventory: broadcast-only arm sent")
        }
        mainHandler.post { result.success(null) }
      } catch (e: Exception) {
        lastError = e.message
        mainHandler.post { result.error("INVENTORY_FAILED", e.message, null) }
      }
    }
  }

  fun stopInventoryAsync() {
    if (!scanning.getAndSet(false)) return
    // Interrupt drain thread immediately — do NOT queue through executor to avoid backlog delay.
    drainThread?.interrupt(); drainThread = null
    // UHFStopGet may block briefly on UART; run off main thread so UI responds instantly.
    val cls = uhfClass; val inst = uhfInstance
    if (cls != null && inst != null && uartOwned) {
      executor.execute { invokeNoArgs(cls, inst, "UHFStopGet", "stopInventoryTag", "stopInventory") }
    }
    // Never send STOP_BARCODE_RFID / CLOSE_BARCODE_RFID / DISABLE broadcasts —
    // they trigger the scanner service to reconfigure itself and churn ScannerWrite
    // config file copies, which pollute the broadcast stream and can reset UART state.
    Log.d(TAG, "stopInventory uartOwned=$uartOwned")
  }

  fun dispose() { executor.execute { disconnectSync() } }

  // ── Native trigger ──────────────────────────────────────────────────────────

  fun enableNativeTrigger() {
    if (triggerReceiver != null) return
    nativeTriggerActive = true
    val r = object : BroadcastReceiver() {
      override fun onReceive(ctx: Context?, intent: Intent?) {
        if (!nativeTriggerActive) return
        val action = intent?.action ?: return
        if (action != "com.rscja.android.KEY_DOWN") return
        val cls = uhfClass; val inst = uhfInstance
        if (cls != null && inst != null && uartOwned && !scanning.getAndSet(true)) {
          executor.execute {
            applyPower()
            startDrainLoop(cls, inst)
            Log.d(TAG, "native trigger: drain loop restarted")
          }
        } else if (!uartOwned) {
          executor.execute {
            scannerUtilityStartUhfScan()
            Log.d(TAG, "native trigger: broadcast-only re-arm")
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

  private fun canOwnUart(): Boolean = false

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
      val inst = runCatching { cls.getMethod("getScannerInerface").invoke(null) }
        .onFailure { Log.w(TAG, "getScannerInerface failed: ${it.message}") }
        .getOrNull() ?: return

      // setOutputMode(ctx, 1) = broadcast mode (0 = keyboard wedge)
      runCatching {
        cls.getMethod("setOutputMode", Context::class.java, Int::class.javaPrimitiveType)
          .invoke(inst, context, 1)
        Log.d(TAG, "ScannerUtility.setOutputMode(ctx, 1) — broadcast mode")
      }.onFailure { Log.w(TAG, "setOutputMode failed: ${it.message}") }

      // setScanResultBroadcastRFID — firmware differs by build; try multiple known routes.
      // getMethod() itself throws NoSuchMethodException on some MTK builds — wrap it.
      val setRoute = runCatching {
        cls.getMethod(
          "setScanResultBroadcastRFID",
          Context::class.java,
          String::class.java,
          String::class.java,
        )
      }.onFailure { Log.w(TAG, "setScanResultBroadcastRFID method not found: ${it.message}") }
        .getOrNull()
      if (setRoute != null) {
        runCatching {
          setRoute.invoke(inst, context, "com.scanner.broadcast", "data")
          Log.d(TAG, "ScannerUtility.setScanResultBroadcastRFID -> com.scanner.broadcast / data")
        }.onFailure { Log.w(TAG, "setScanResultBroadcastRFID failed: ${it.message}") }
      }

      // setUHFMode(ctx, 1) — put scanner service into UHF continuous inventory mode
      // Mode 0 = single scan, 1 = continuous. Must be called before trigger press.
      runCatching {
        cls.getMethod("setUHFMode", Context::class.java, Int::class.javaPrimitiveType)
          .invoke(inst, context, 1)
        Log.d(TAG, "ScannerUtility.setUHFMode(ctx, 1)")
      }.onFailure { Log.w(TAG, "setUHFMode failed: ${it.message}") }

      // setRFIDEncodingFormat(ctx, 0) — raw EPC hex output (format 5 = unknown/broken)
      runCatching {
        cls.getMethod("setRFIDEncodingFormat", Context::class.java, Int::class.javaPrimitiveType)
          .invoke(inst, context, 0)
        Log.d(TAG, "ScannerUtility.setRFIDEncodingFormat(ctx, 0)")
      }.onFailure { Log.w(TAG, "setRFIDEncodingFormat failed: ${it.message}") }

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

      // NOTE: do NOT call enableFunction(ctx, FUNCTION_UHF) here.
      // It wakes the scanner service which immediately re-acquires /dev/ttyMT1,
      // causing all subsequent UHFOpenAndConnect calls to time out (-98).

    } catch (e: Throwable) {
      Log.w(TAG, "scannerUtilityConfigureBroadcast error: ${e.message}", e)
    }
  }

  private fun scannerUtilityStartUhfScan() {
    try {
      val cls = resolveScannerUtilityClass() ?: return
      val inst = runCatching { cls.getMethod("getScannerInerface").invoke(null) }.getOrNull() ?: return
      val functionId = runCatching { cls.getField("FUNCTION_UHF").getInt(null) }.getOrElse { FUNCTION_UHF }
      // startScan(ctx, functionId) — triggers a UHF scan cycle via ScannerUtility
      runCatching {
        cls.getMethod("startScan", Context::class.java, Int::class.javaPrimitiveType)
          .invoke(inst, context, functionId)
        Log.d(TAG, "ScannerUtility.startScan(ctx, $functionId) — UHF scan started")
      }.onFailure { Log.w(TAG, "startScan($functionId) failed: ${it.message}") }
    } catch (e: Throwable) {
      Log.w(TAG, "scannerUtilityStartUhfScan error: ${e.message}")
    }
    // Firmware broadcasts that start continuous UHF inventory on C72E MTK.
    // OPEN_BARCODE_RFID + CONTINUOUS_SCAN_RFID puts the scanner into the same
    // keep-scanning mode the vendor app uses — unlike startScan() which is one-shot
    // when scanner_Continuous=false in KeyboardHelperParam.xml.
    for (action in UHF_START_ACTIONS) {
      runCatching {
        context.sendBroadcast(Intent(action).apply {
          setPackage("com.rscja.scanner")
          addFlags(Intent.FLAG_INCLUDE_STOPPED_PACKAGES)
        })
        context.sendBroadcast(Intent(action).apply {
          addFlags(Intent.FLAG_INCLUDE_STOPPED_PACKAGES)
        })
        Log.d(TAG, "UHF start broadcast -> $action")
      }
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
    // Retry up to 3 times with 300ms gaps — scanner service can reacquire the port
    // within milliseconds after another app releases it, so immediate retry often wins.
    for (attempt in 1..3) {
      if (attempt > 1) {
        Log.d(TAG, "initUart retry $attempt after 300ms")
        Thread.sleep(300)
      }
      if (initUartOnce(cls, inst)) return true
    }
    return false
  }

  private fun initUartOnce(cls: Class<*>, inst: Any): Boolean {
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
        val r = timedInvoke(1500) { (mOpen.invoke(inst, *args) as? Number)?.toInt() ?: -1 }
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

    // UHFGetReceived_EX2 signature: int UHFGetReceived_EX2(byte[]) — must pass ByteArray not CharArray
    val mGet = cls.methods.firstOrNull { it.name == "UHFGetReceived_EX2" }
    mGet?.isAccessible = true
    val buf = ByteArray(256)

    val t = Thread {
      Log.d(TAG, "drain loop started, mGet=${mGet?.name}")
      var total = 0
      var empty = 0
      while (scanning.get()) {
        try {
          if (mGet != null) {
            buf.fill(0)
            val cnt = runCatching { (mGet.invoke(inst, buf) as? Number)?.toInt() ?: -1 }.getOrElse { -1 }
            if (cnt > 0) {
              empty = 0
              val epc = parseEpcFromBytes(buf)
              if (epc != null && seenEpcs.add(epc)) {
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

  private fun parseEpcFromBytes(buf: ByteArray): String? {
    // UHFGetReceived_EX2 buffer layout (Chainway MTK UART protocol):
    //   byte 0    : total data length in bytes (e.g. 0x0E = 14)
    //   bytes 1-2 : PC word (EPC header, e.g. 0x3000 = 96-bit, 0x3400 = 96-bit + extended)
    //   bytes 3.. : EPC bytes — length = (PC[0] >> 3) * 2 bytes, typically 12 bytes for EPC-96
    //   trailing  : RSSI / antenna / CRC bytes
    if (buf.isEmpty() || buf[0] == 0.toByte()) return null
    val totalLen = buf[0].toInt() and 0xFF
    if (totalLen < 3 || totalLen + 1 > buf.size) return null
    val pc = ((buf[1].toInt() and 0xFF) shl 8) or (buf[2].toInt() and 0xFF)
    // PC word bits [15:11] = EPC length in words (2 bytes each)
    val epcWords = (pc shr 11) and 0x1F
    val epcBytes = if (epcWords > 0) epcWords * 2 else 12  // default 12 bytes (EPC-96)
    val epcStart = 3
    val epcEnd = epcStart + epcBytes
    if (epcEnd > totalLen + 1 || epcEnd > buf.size) return null
    val epc = buf.slice(epcStart until epcEnd).joinToString("") { "%02X".format(it.toInt() and 0xFF) }
    return if (epc.length >= 16) epc else null
  }

  // ── Class resolution ─────────────────────────────────────────────────────────

  fun resolveUhfClass(): Class<*>? {
    Log.d(TAG, "resolveUhfClass ENTERED")
    // Delete any cached DEX from previous installs — the old bundled chainway_uhf.dex
    // had an internal 400ms broadcast loop that spams START_BARCODE_RFID indefinitely.
    runCatching {
      val cached = java.io.File(context.applicationContext.cacheDir, "chainway_uhf.dex")
      if (cached.exists()) { cached.delete(); Log.d(TAG, "deleted stale chainway_uhf.dex from cache") }
    }
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

    // Bundled DEX fallback removed — it contained a broken internal broadcast loop.

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
    // Do not hard-drop duplicate sightings here; Count screen uses repeated sightings
    // to mark defective duplicate behavior (xN). Higher layers still own quantity logic.
    Log.d(TAG, "EPC: $up")
    val sink = tagSink ?: return
    mainHandler.post { sink.success(mapOf("epc" to up, "rssi" to (rssi ?: 0))) }
  }

  private fun extractHexCandidate(raw: String): String {
    val s = raw.trim().uppercase()
    if (s.isEmpty()) return ""
    if (s == "BARCODECODE" || s == "SCANNERDATA" || s == "SCAN_DATA") return ""
    if (s.contains("/") || s.contains(".XML")) return ""
    // Return the longest hex run of at least 16 chars.
    // Format 5 wraps the EPC with RSSI/antenna bytes — pick the EPC out of the middle.
    // EPC-96 = 24 chars. 16-char floor avoids matching random short hex inside noise.
    return Regex("[0-9A-F]{16,}").findAll(s)
      .map { it.value }
      .maxByOrNull { it.length }
      ?: ""
  }

  private fun extractHexCandidateFromBytes(bytes: ByteArray): String {
    if (bytes.isEmpty()) return ""
    // 1) Try UTF payload first.
    val utf = runCatching { String(bytes, Charsets.UTF_8) }.getOrDefault("")
    extractHexCandidate(utf).takeIf { it.isNotEmpty() }?.let { return it }
    // 2) Treat payload as raw EPC bytes.
    val rawHex = bytes.joinToString("") { "%02X".format(it.toInt() and 0xFF) }
    return extractHexCandidate(rawHex)
  }

  companion object {
    private const val TAG = "CarbonChainway"
    private const val FUNCTION_UHF = 11

    const val SCANNER_WRITE_EPC_ACTION = "com.shopcarbon.wms.RFID_EPC"
    const val SCANNER_WRITE_EPC_KEY = "epc"
    const val SCANNER_OUTPUT_RFID_ACTION = "com.rscja.scanner.action.OUTPUT_BARCODE_RFID"
    // On C72E MTK, "barcodeCode" can be emitted literally as a placeholder string.
    // "scannerdata" carries the actual EPC payload.
    const val SCANNER_OUTPUT_RFID_KEY = "scannerdata"
    private val RFID_BROADCAST_ROUTES = listOf(
      SCANNER_OUTPUT_RFID_ACTION to SCANNER_OUTPUT_RFID_KEY,
      SCANNER_OUTPUT_RFID_ACTION to "barcodeCode",
      "android.intent.action.scanner.RFID" to "scannerdata",
      "android.intent.action.scanner.RFID" to "epc",
      SCANNER_WRITE_EPC_ACTION to SCANNER_WRITE_EPC_KEY,
    )

    private val EPC_BROADCAST_ACTIONS = setOf(
      "com.scanner.broadcast",
      "com.shopcarbon.wms.RFID_EPC",
      "android.intent.action.scanner.RFID",
      "com.rscja.scanner.action.OUTPUT_BARCODE_RFID",
      "android.intent.action.BARCODEOUTPUT",
    )

    // Broadcast actions that start continuous UHF inventory on C72E MTK firmware.
    // Sent to both com.rscja.scanner package and system-wide so the scanner service
    // receives them regardless of which receiver is active.
    private val UHF_START_ACTIONS = listOf(
      "android.intent.action.OPEN_BARCODE_RFID",
      "android.intent.action.CONTINUOUS_SCAN_RFID",
      "com.rscja.scanner.action.START_BARCODE_RFID",
    )

    private val UHF_STOP_ACTIONS = listOf(
      "android.intent.action.STOP_BARCODE_RFID",
      "android.intent.action.CLOSE_BARCODE_RFID",
      "com.rscja.scanner.action.STOP_BARCODE_RFID",
    )

    private val EPC_EXTRA_KEYS = arrayOf(
      SCANNER_WRITE_EPC_KEY, "epc", "EPC", "scannerdata", "SCAN_DATA", "data",
      "barcode_string", "BARCODE_STRING", "scan_data", "barcodeCode", "data_result",
    )
    private val EPC_BYTE_KEYS = arrayOf("scannerdata", "SCAN_DATA", "data", "barcode")
  }
}
