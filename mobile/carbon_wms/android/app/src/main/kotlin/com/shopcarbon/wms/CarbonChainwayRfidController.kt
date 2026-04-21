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
 * Chainway C72E UHF — direct UART path (Senitron-equivalent).
 *
 * On connect:
 *  1. Broadcast UHF_POWER_OFF → com.rscja.scanner releases /dev/ttyMT1 (cooperative Chainway SDK protocol)
 *  2. UHFInit("") → UHFOpenAndConnect("") — we now own the UART directly
 *  3. UHFInventory_EX_cnt(0,0,6) + tight UHFGetReceived_EX2 drain loop at 10ms
 *
 * Zero broadcasts to com.rscja.scanner — those were crashing it (SIGABRT observed in logcat).
 */
class CarbonChainwayRfidController(private val context: Context) {

  private val executor = Executors.newSingleThreadExecutor()
  private val mainHandler = Handler(Looper.getMainLooper())

  @Volatile var tagSink: EventChannel.EventSink? = null
  @Volatile private var lastError: String? = null

  private var uhfClass: Class<*>? = null
  private var uhfInstance: Any? = null
  private val scanning = AtomicBoolean(false)
  private val requestedPowerDbm = AtomicInteger(30)
  @Volatile private var drainThread: Thread? = null
  @Volatile private var uartOwned = false

  // Session-level EPC dedup — cleared on disconnect / screen reset.
  private val seenEpcs = java.util.Collections.newSetFromMap(
    java.util.concurrent.ConcurrentHashMap<String, Boolean>()
  )

  // Native trigger (KEY_DOWN → toggle inventory)
  @Volatile private var nativeTriggerActive = false
  private var triggerReceiver: BroadcastReceiver? = null
  private var uhfPowerOffReceiver: BroadcastReceiver? = null

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
        Log.d(TAG, "UHF methods: ${cls.methods.map { it.name }.distinct().sorted()}")
        val inst = getStaticInstance(cls) ?: throw RuntimeException("DeviceAPI getInstance failed")
        uhfInstance = inst

        // Evict com.rscja.scanner from UART then take over
        val ok = evictAndInit(cls, inst)
        uartOwned = ok
        if (!ok) Log.w(TAG, "UART takeover failed — no EPCs will be scanned")
        else Log.d(TAG, "UART owned — direct scan path active")

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
        val cls = uhfClass ?: throw RuntimeException("not connected")
        val inst = uhfInstance ?: throw RuntimeException("not connected")

        if (!uartOwned) {
          // Last-chance: retry UART takeover
          uartOwned = evictAndInit(cls, inst)
          if (!uartOwned) throw RuntimeException("UART takeover failed")
        }

        applyPower()
        startDrainLoop(cls, inst)
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
    if (cls != null && inst != null) invokeNoArgs(cls, inst, "UHFStopGet", "stopInventory", "stopInventoryTag")
    // No broadcasts to com.rscja.scanner — those crash it (SIGABRT observed in logcat).
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
        executor.execute { if (scanning.get()) stopInventoryAsync() else startDrainLoop(uhfClass ?: return@execute, uhfInstance ?: return@execute) }
      }
    }
    registerReceiver(r, IntentFilter("com.rscja.android.KEY_DOWN"))?.let { triggerReceiver = it }
  }

  fun disableNativeTrigger() {
    nativeTriggerActive = false
    triggerReceiver?.let { safeUnregister(it); triggerReceiver = null }
  }

  // ── UART eviction (Senitron h3/c.java T()+S()+n0()+h0()) ───────────────────

  private fun evictAndInit(cls: Class<*>, inst: Any): Boolean {
    val myApiId = android.os.SystemClock.elapsedRealtime()

    // Step 1: broadcast UHF_POWER_OFF — com.rscja.scanner's BroadcastReceiver calls UHFFree()
    Log.d(TAG, "evict: broadcasting UHF_POWER_OFF apiId=$myApiId")
    try {
      context.sendBroadcast(Intent("com.rscja.deviceapi.action.UHF_POWER_OFF").apply {
        putExtra("apiId", myApiId)
        addFlags(Intent.FLAG_INCLUDE_STOPPED_PACKAGES)
      })
    } catch (e: Exception) { Log.w(TAG, "UHF_POWER_OFF broadcast failed: ${e.message}") }
    Thread.sleep(400) // wait for com.rscja.scanner to release UART

    // Step 2: register our own UHF_POWER_OFF receiver so we yield gracefully when asked
    if (uhfPowerOffReceiver == null) {
      val r = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context?, intent: Intent?) {
          val incoming = intent?.getLongExtra("apiId", -1L) ?: -1L
          if (incoming == myApiId) return // our own, ignore
          Log.d(TAG, "UHF_POWER_OFF from other app — releasing UART")
          executor.execute {
            uartOwned = false
            invokeNoArgs(cls, inst, "UHFFree", "UHFCloseAndDisconnect")
          }
        }
      }
      registerReceiver(r, IntentFilter("com.rscja.deviceapi.action.UHF_POWER_OFF"))
        ?.let { uhfPowerOffReceiver = it }
    }

    // Step 3: UHFInit
    val mInit = cls.methods.firstOrNull { it.name == "UHFInit" } ?: run {
      Log.w(TAG, "UHFInit method not found"); return false
    }
    mInit.isAccessible = true
    val appCtx = context.applicationContext
    val uartPaths = listOf("", "/dev/ttyMT1", "/dev/ttyMT0")
    var initOk = false
    for (uart in uartPaths) {
      val args = mInit.parameterTypes.map { t -> when {
        t == Context::class.java -> appCtx
        t == String::class.java -> uart
        t == Int::class.javaPrimitiveType || t == java.lang.Integer.TYPE -> 0
        else -> null
      }}.toTypedArray()
      val r = timedInvoke(5000) { (mInit.invoke(inst, *args) as? Number)?.toInt() ?: 0 }
      Log.d(TAG, "UHFInit('$uart') -> $r")
      if (r == 0) { initOk = true; break }
    }
    if (!initOk) { Log.w(TAG, "UHFInit failed all paths"); return false }

    // Step 4: UHFOpenAndConnect
    val mOpen = cls.methods.firstOrNull { it.name == "UHFOpenAndConnect" }
    if (mOpen != null) {
      mOpen.isAccessible = true
      for (uart in uartPaths) {
        val args = mOpen.parameterTypes.map { t -> if (t == String::class.java) uart else null }.toTypedArray()
        val r = timedInvoke(5000) { (mOpen.invoke(inst, *args) as? Number)?.toInt() ?: 0 }
        Log.d(TAG, "UHFOpenAndConnect('$uart') -> $r")
        if (r >= 0) { Log.d(TAG, "UART takeover complete"); return true }
      }
      Log.w(TAG, "UHFOpenAndConnect failed all paths"); return false
    }

    // No UHFOpenAndConnect — UHFInit alone may be sufficient on some firmware
    Log.d(TAG, "UHFOpenAndConnect not found — UHFInit-only path"); return true
  }

  // ── Drain loop (Senitron p3/b.java inner class `a`) ─────────────────────────

  private fun startDrainLoop(cls: Class<*>, inst: Any) {
    // UHFInventory_EX_cnt(0, 0, 6) — start continuous inventory
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

    // Try startInventory(0,0,6) as high-level wrapper
    cls.methods.firstOrNull { it.name == "startInventory" && it.parameterCount == 3 }?.let { m ->
      m.isAccessible = true
      runCatching { m.invoke(inst, 0, 0, 6) }
      Log.d(TAG, "startInventory(0,0,6) called")
    }

    if (mInv != null) {
      val r = runCatching { mInv.invoke(inst, *invArgs) }.getOrNull()
      Log.d(TAG, "${mInv.name}() -> $r")
    }

    // UHFGetReceived_EX2 drain
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
            // Clear buffer
            buf.fill('\u0000')
            val cnt = runCatching { (mGet.invoke(inst, buf) as? Number)?.toInt() ?: -1 }.getOrElse { -1 }
            if (cnt > 0) {
              empty = 0
              val epc = parseEpcFromBuf(buf)
              if (epc != null) {
                emitEpc(epc, null)
                if (++total % 10 == 0) Log.d(TAG, "drain: $total EPCs emitted")
              }
              // No sleep — drain as fast as possible like Senitron (10ms only when empty)
            } else {
              empty++
              // Re-trigger inventory every ~20 empty polls (~200ms)
              if (empty % 20 == 0 && mInv != null) {
                runCatching { mInv.invoke(inst, *invArgs) }
              }
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
    // buf[] from UHFGetReceived_EX2:
    // Senitron reads: buf[0] = tag count field, buf[1..N] = raw EPC bytes
    // Try raw bytes → hex. Find last non-zero byte to determine EPC length.
    val bytes = buf.map { it.code and 0xFF }
    val lastNz = bytes.take(64).indexOfLast { it != 0 }
    if (lastNz < 1) return null
    val hex = bytes.take(lastNz + 1).joinToString("") { "%02X".format(it) }
    val clean = hex.replace(Regex("[^0-9A-F]"), "")
    return if (clean.length >= 4) clean else null
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  fun resolveUhfClass(): Class<*>? {
    val primary = "com.rscja.team.mtk.deviceapi.DeviceAPI"
    val fallbacks = listOf(
      "com.rscja.deviceapi.DeviceAPI",
      "com.rscja.deviceapi.RFIDWithUHFUART",
      "com.rscja.deviceapi.RFIDWithUHF",
    )
    // 1. Bundled DEX
    try {
      val appCtx = context.applicationContext
      val dexFile = java.io.File(appCtx.cacheDir, "chainway_uhf.dex")
      if (!dexFile.exists()) {
        appCtx.assets.open("chainway_uhf.dex").use { i -> dexFile.outputStream().use { o -> i.copyTo(o) } }
      }
      val optDir = appCtx.getDir("dex_opt", android.content.Context.MODE_PRIVATE)
      val cl = dalvik.system.DexClassLoader(dexFile.absolutePath, optDir.absolutePath, null, appCtx.classLoader)
      val cls = cl.loadClass(primary)
      Log.d(TAG, "DexClassLoader: loaded $primary")
      return cls
    } catch (e: Throwable) { Log.w(TAG, "DexClassLoader failed: ${e.message}") }
    // 2. System class loader
    for (n in listOf(primary) + fallbacks) {
      try { return Class.forName(n).also { Log.d(TAG, "Class.forName: $n") } } catch (_: Throwable) {}
    }
    return null
  }

  private fun getStaticInstance(cls: Class<*>): Any? {
    val appCtx = context.applicationContext
    runCatching { cls.getMethod("getInstance", Context::class.java).invoke(null, appCtx)?.let { return it } }
    runCatching { cls.getMethod("getInstance").invoke(null)?.let { return it } }
    for (lib in listOf("DeviceAPI", "rscja_deviceapi", "uhfapi")) runCatching { System.loadLibrary(lib) }
    runCatching { cls.getDeclaredConstructor().apply { isAccessible = true }.newInstance()?.let { return it } }
    return null
  }

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
    seenEpcs.clear()
    uhfPowerOffReceiver?.let { safeUnregister(it); uhfPowerOffReceiver = null }
    val cls = uhfClass; val inst = uhfInstance
    if (cls != null && inst != null) {
      // Only stop/free the native SDK — no broadcasts to com.rscja.scanner.
      invokeNoArgs(cls, inst, "UHFStopGet", "UHFCloseAndDisconnect", "UHFFree", "stopInventory")
    }
    uartOwned = false
    uhfClass = null; uhfInstance = null
  }

  private fun emitEpc(hex: String, rssi: Int?) {
    val up = hex.uppercase().replace(Regex("[^0-9A-F]"), "")
    if (up.length < 4) return
    if (!seenEpcs.add(up)) return
    Log.d(TAG, "EPC: $up")
    val sink = tagSink ?: return
    mainHandler.post { sink.success(mapOf("epc" to up, "rssi" to (rssi ?: 0))) }
  }

  companion object {
    private const val TAG = "CarbonChainway"
  }
}
