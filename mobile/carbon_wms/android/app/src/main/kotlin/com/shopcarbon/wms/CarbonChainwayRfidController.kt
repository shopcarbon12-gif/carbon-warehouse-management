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

  fun getLastError(): String? = lastError

  fun clearSeenEpcs() {
    seenEpcs.clear()
    Log.d(TAG, "seenEpcs cleared")
  }

  fun setTagSink(sink: EventChannel.EventSink?) { tagSink = sink }

  fun setAntennaPowerDbm(dbm: Int) {
    executor.execute {
      requestedPowerDbm.set(dbm.coerceIn(0, 30))
      applyPower()
    }
  }

  // ── Connect ─────────────────────────────────────────────────────────────────

  fun connectAsync(onDone: (Throwable?) -> Unit) {
    executor.execute {
      try {
        disconnectSync()
        val cls = resolveUhfClass() ?: throw RuntimeException("DeviceAPI class not found")
        uhfClass = cls
        Log.d(TAG, "UHF class: ${cls.name}")

        // Cooperative UART eviction — try ScannerUtility first, fall back to broadcast eviction
        val released = scannerUtilityReleaseUhf()
        if (!released) {
          Log.w(TAG, "ScannerUtility unavailable — falling back to broadcast eviction")
          evictUartBroadcast()
        }

        val inst = getStaticInstance(cls)
        if (inst == null) {
          Log.w(TAG, "DeviceAPI getInstance returned null — will use SenitronBridge logcat path")
          lastError = null
          mainHandler.post { onDone(null) }
          return@execute
        }

        uhfInstance = inst
        uartOwned = initUart(cls, inst)
        if (!uartOwned) {
          Log.w(TAG, "UHFInit failed — will use SenitronBridge logcat path")
        } else {
          Log.d(TAG, "UART owned — direct scan path active")
        }
        lastError = null
        mainHandler.post { onDone(null) }
      } catch (e: Throwable) {
        lastError = e.message ?: e.javaClass.simpleName
        Log.e(TAG, "connect failed: ${e.message}", e)
        mainHandler.post { onDone(e) }
      }
    }
  }

  fun disconnectAsync() { executor.execute { disconnectSync() } }

  // ── Inventory ────────────────────────────────────────────────────────────────

  fun startInventoryFlutterResult(result: MethodChannel.Result) {
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
          Log.w(TAG, "startInventory: UART not owned — system scanner RFID mode")
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
    } else {
      MainActivity.stopSystemScannerInventory(context, TAG)
    }
    Log.d(TAG, "stopInventory")
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
      Log.w(TAG, "UHFOpenAndConnect failed all paths"); return false
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
  }
}
