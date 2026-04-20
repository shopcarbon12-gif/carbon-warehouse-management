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
 * Chainway C72E UHF scanning.
 * Primary path: reflection on DeviceAPI (UHFInventory_EX_cnt + UHFGetReceived_EX2 drain loop).
 * Supplementary path: SCAN_RESULT_BROADCAST from com.rscja.scanner to catch any extra tags.
 */
class CarbonChainwayRfidController(
  private val context: Context,
) {
  private val executor = Executors.newSingleThreadExecutor()
  private val mainHandler = Handler(Looper.getMainLooper())

  @Volatile private var tagSink: EventChannel.EventSink? = null
  private var uhfClass: Class<*>? = null
  private var uhfInstance: Any? = null
  private val scanning = AtomicBoolean(false)
  private val requestedPowerDbm = AtomicInteger(30)
  @Volatile private var lastError: String? = null
  @Volatile private var keepAliveThread: Thread? = null

  private val ACTION_RFID_ENABLE  = "android.intent.action.ENABLE_FUNCTION_BARCODE_RFID"
  private val ACTION_RFID_DISABLE = "android.intent.action.DISABLE_FUNCTION_BARCODE_RFID"
  private val ACTION_RFID_START   = "android.intent.action.START_BARCODE_RFID"
  private val ACTION_RFID_STOP    = "android.intent.action.STOP_BARCODE_RFID"
  private val ACTION_RESULT       = "android.intent.action.OUTPUT_BARCODE_RFID"
  private val ACTION_RESULT2      = "android.intent.action.SCAN_RESULT_BROADCAST"

  private var scanReceiver: BroadcastReceiver? = null
  @Volatile private var pollThread: Thread? = null

  fun getLastError(): String? = lastError

  fun setTagSink(sink: EventChannel.EventSink?) {
    tagSink = sink
  }

  fun setAntennaPowerDbm(dbm: Int) {
    executor.execute {
      requestedPowerDbm.set(dbm.coerceIn(0, 30))
      tryApplyChainwayPower()
    }
  }

  fun resolveUhfClass(): Class<*>? {
    val names = listOf(
      "com.rscja.deviceapi.DeviceAPI",
      "com.rscja.deviceapi.RFIDWithUHFUART",
      "com.rscja.deviceapi.module.RFIDWithUHFUART",
      "com.rscja.deviceapi.RFIDWithUHF",
    )
    for (n in names) {
      try { return Class.forName(n) } catch (_: Throwable) {}
    }
    for (pkg in listOf("com.rscja.scanner", "com.rscja.secapp", "com.rscja.deviceapi")) {
      try {
        val pkgCtx = context.createPackageContext(pkg,
          Context.CONTEXT_INCLUDE_CODE or Context.CONTEXT_IGNORE_SECURITY)
        val cl = pkgCtx.classLoader
        for (className in names) {
          try {
            val cls = cl.loadClass(className)
            Log.d("CarbonChainway", "createPackageContext classloader loaded '$className' from pkg=$pkg")
            return cls
          } catch (_: Throwable) {}
        }
      } catch (_: Throwable) {}
    }
    return null
  }

  fun connectAsync(onDone: (Throwable?) -> Unit) {
    executor.execute {
      try {
        disconnectSync()
        val cls = resolveUhfClass()
        Log.d("CarbonChainway", "resolveUhfClass -> ${cls?.name ?: "null"}")
        if (cls != null) {
          uhfClass = cls
          Log.d("CarbonChainway", "UHF class methods: ${cls.methods.map { it.name }.distinct().sorted()}")
          val inst = getStaticInstance(cls, context.applicationContext)
          if (inst != null) {
            uhfInstance = inst
            invokeInit(cls, inst)
            Log.d("CarbonChainway", "UHF init succeeded")
          }
        }
        lastError = null
        mainHandler.post { onDone(null) }
      } catch (e: Throwable) {
        Log.e("CarbonChainway", "connect failed: ${e.message}", e)
        lastError = e.message ?: e.javaClass.simpleName
        mainHandler.post { onDone(e) }
      }
    }
  }

  fun disconnectAsync() {
    executor.execute { disconnectSync() }
  }

  fun startInventoryFlutterResult(result: MethodChannel.Result) {
    if (scanning.getAndSet(true)) {
      mainHandler.post { result.success(null) }
      return
    }
    executor.execute {
      try {
        tryApplyChainwayPower()
        val cls = uhfClass
        val inst = uhfInstance
        if (cls == null || inst == null) {
          scanning.set(false)
          mainHandler.post { result.error("NOT_CONNECTED", "UHF not initialized", null) }
          return@execute
        }

        // Find inventory method
        val mInv = cls.methods.firstOrNull { it.name == "UHFInventory_EX_cnt" }
          ?: cls.methods.firstOrNull { it.name == "UHFInventory_EX" }
          ?: cls.methods.firstOrNull { it.name == "UHFInventory" }
        mInv?.isAccessible = true

        // Find read method
        val mGet = cls.methods.firstOrNull { it.name == "UHFGetReceived_EX2" }
        mGet?.isAccessible = true

        // Build inventory args: UHFInventory_EX_cnt(char, char, char) = ('\xFF', '\x00', '\x00')
        val invArgs: Array<Any?> = if (mInv != null) {
          var charIdx = 0
          mInv.parameterTypes.map { t ->
            when {
              t == java.lang.Character.TYPE -> {
                val v = if (charIdx == 0) '\u00FF' else '\u0000'
                charIdx++
                java.lang.Character(v)
              }
              t == java.lang.Integer.TYPE -> java.lang.Integer(0)
              else -> null
            }
          }.toTypedArray()
        } else arrayOf()

        // Register broadcast receiver FIRST so we don't miss early results
        mainHandler.post { registerScanReceiver() }

        // Enable RFID function then start — avoids triggering 2D laser
        sendScannerBroadcast(ACTION_RFID_ENABLE)
        Thread.sleep(200)
        sendScannerBroadcast(ACTION_RFID_START)
        Log.d("CarbonChainway", "sent ENABLE_FUNCTION_BARCODE_RFID + START_BARCODE_RFID")

        // Keep-alive: re-send START_BARCODE_RFID every 400ms so inventory keeps running
        val ka = Thread {
          try {
            Thread.sleep(1500)
            while (scanning.get()) {
              sendScannerBroadcast(ACTION_RFID_START)
              Thread.sleep(2000)
            }
          } catch (_: InterruptedException) {}
          Log.d("CarbonChainway", "keepAlive thread exited")
        }
        ka.isDaemon = true
        ka.name = "chainway-ka"
        ka.start()
        keepAliveThread = ka

        // Also kick off reflection inventory as fallback
        if (mInv != null) {
          val ok = runCatching { mInv.invoke(inst, *invArgs) as? Boolean ?: true }.getOrElse { false }
          Log.d("CarbonChainway", "${mInv.name}() -> $ok (reflection fallback)")
        }

        // Start fast drain poll thread
        val drainThread = Thread {
          var emptyStreak = 0
          var totalEmitted = 0
          while (scanning.get()) {
            try {
              var gotAny = false
              if (mGet != null) {
                // Drain all available tags in tight loop
                var drainCount = 0
                while (drainCount < 500 && scanning.get()) {
                  val buf = CharArray(256)
                  val cnt = runCatching { (mGet.invoke(inst, buf) as? Int) ?: -1 }.getOrElse { -1 }
                  if (cnt < 0) break // queue empty
                  drainCount++
                  emptyStreak = 0
                  gotAny = true
                  // Decode: buf contains raw bytes as chars. Each call = one tag.
                  // EPC is 12 bytes starting at offset 0 (for standard 96-bit EPC).
                  val bytes = buf.map { it.code and 0xFF }
                  val hex24 = bytes.take(12).joinToString("") { "%02X".format(it) }
                  if (hex24.matches(Regex("[0-9A-F]{24}")) && hex24.count { it != '0' } > 2) {
                    emitEpc(hex24, null)
                    totalEmitted++
                    if (totalEmitted % 10 == 0) Log.d("CarbonChainway", "poll: emitted $totalEmitted tags so far")
                  } else {
                    // Try ASCII interpretation (some firmware returns hex string in ASCII)
                    val ascii = buf.takeWhile { it.code in 0x30..0x46 }.joinToString("") { it.toString() }
                    if (ascii.length >= 24 && ascii.matches(Regex("[0-9A-F]{24,}"))) {
                      emitEpc(ascii.take(24), null)
                      totalEmitted++
                    }
                  }
                }
                if (!gotAny) emptyStreak++
              } else {
                // No drain method — rely solely on broadcast receiver
                Thread.sleep(100)
                continue
              }

              // Re-trigger inventory when queue drains
              if (mInv != null && (emptyStreak == 1 || emptyStreak % 10 == 0)) {
                runCatching { mInv.invoke(inst, *invArgs) }
                if (emptyStreak == 1) Log.d("CarbonChainway", "poll: queue empty, re-triggered inventory")
              }

              Thread.sleep(if (gotAny) 10 else 30)
            } catch (_: InterruptedException) { break }
            catch (e: Exception) { Log.w("CarbonChainway", "poll error: ${e.message}") }
          }
          Log.d("CarbonChainway", "poll thread exited, total emitted=$totalEmitted")
        }
        drainThread.isDaemon = true
        drainThread.name = "chainway-drain"
        drainThread.start()
        pollThread = drainThread

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
    keepAliveThread?.interrupt()
    keepAliveThread = null
    sendScannerBroadcast(ACTION_RFID_STOP)
    sendScannerBroadcast(ACTION_RFID_DISABLE)
    unregisterScanReceiver()
    pollThread?.interrupt()
    pollThread = null
    // Call UHFStopGet to stop hardware inventory
    val cls = uhfClass
    val inst = uhfInstance
    if (cls != null && inst != null) {
      cls.methods.firstOrNull { it.name == "UHFStopGet" && it.parameterCount == 0 }?.let { m ->
        m.isAccessible = true; runCatching { m.invoke(inst) }
      }
    }
    Log.d("CarbonChainway", "stopInventory")
  }

  fun dispose() {
    executor.execute { disconnectSync() }
  }

  private fun registerScanReceiver() {
    unregisterScanReceiver()
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(ctx: Context?, intent: Intent?) {
        if (intent == null || !scanning.get()) return
        val action = intent.action ?: return
        Log.d("CarbonChainway", "broadcast: action=$action")
        handleScanBroadcast(intent)
      }
    }
    val filter = IntentFilter().apply {
      addAction(ACTION_RESULT)   // OUTPUT_BARCODE_RFID
      addAction(ACTION_RESULT2)  // SCAN_RESULT_BROADCAST
      addAction("com.rscja.scanner.action.OUTPUT_BARCODE_RFID")
      addAction("android.intent.action.SCAN_RFID_RESULT")
      addAction("android.intent.action.BARCODEOUTPUT")
    }
    context.registerReceiver(receiver, filter)
    scanReceiver = receiver
  }

  private fun unregisterScanReceiver() {
    val r = scanReceiver ?: return
    try { context.unregisterReceiver(r) } catch (_: Exception) {}
    scanReceiver = null
  }

  private fun handleScanBroadcast(intent: Intent) {
    val extras = intent.extras
    if (extras == null) {
      Log.d("CarbonChainway", "  bcast: no extras on ${intent.action}")
      return
    }
    for (key in extras.keySet()) {
      Log.d("CarbonChainway", "  bcast extra '$key'='${extras.get(key)}'")
    }
    val candidates = listOf(
      "barcodeCode", "barcodeData", "barcodeStringData", "scan_result",
      "SCAN_BARCODE_RESULT", "barcode_string", "value", "data",
      "barcode", "CODE", "code", "epc", "EPC", "result", "RESULT",
    )
    for (key in candidates) {
      val v = extras.getString(key)
      if (!v.isNullOrBlank()) { processRawEpc(v.trim()); return }
    }
    // Fallback: longest string extra
    var best = ""
    for (key in extras.keySet()) {
      val v = extras.getString(key)
      if (!v.isNullOrBlank() && v.length > best.length) best = v
    }
    if (best.isNotBlank()) processRawEpc(best.trim())
  }

  private fun processRawEpc(raw: String) {
    val upper = raw.uppercase().replace(Regex("[^0-9A-F]"), "")
    if (upper.length < 24) return
    val epc = upper.take(24)
    if (epc.count { it != '0' } <= 2) return
    emitEpc(epc, null)
  }

  private fun sendScannerBroadcast(action: String) {
    try {
      val i = Intent(action).apply { addFlags(Intent.FLAG_INCLUDE_STOPPED_PACKAGES) }
      context.sendBroadcast(i)
      Log.d("CarbonChainway", "sent broadcast: $action")
    } catch (e: Exception) { Log.w("CarbonChainway", "sendBroadcast $action failed: ${e.message}") }
  }

  private fun disconnectSync() {
    scanning.set(false)
    keepAliveThread?.interrupt()
    keepAliveThread = null
    pollThread?.interrupt()
    pollThread = null
    sendScannerBroadcast(ACTION_RFID_STOP)
    sendScannerBroadcast(ACTION_RFID_DISABLE)
    unregisterScanReceiver()
    val cls = uhfClass
    val inst = uhfInstance
    if (cls != null && inst != null) {
      for (name in listOf("UHFStopGet", "UHFCloseAndDisconnect", "UHFFree")) {
        cls.methods.firstOrNull { it.name == name && it.parameterCount == 0 }?.let { m ->
          m.isAccessible = true; runCatching { m.invoke(inst) }
        }
      }
    }
    uhfClass = null
    uhfInstance = null
  }

  private fun getStaticInstance(cls: Class<*>, appCtx: Context): Any? {
    runCatching {
      val m = cls.getMethod("getInstance", Context::class.java)
      val inst = m.invoke(null, appCtx)
      if (inst != null) { Log.d("CarbonChainway", "getInstance -> ${inst.javaClass.simpleName}"); return inst }
    }
    runCatching {
      val m = cls.getMethod("getInstance")
      val inst = m.invoke(null)
      if (inst != null) { Log.d("CarbonChainway", "getInstance -> ${inst.javaClass.simpleName}"); return inst }
    }
    for (libName in listOf("DeviceAPI", "rscja_deviceapi", "uhfapi")) {
      runCatching { System.loadLibrary(libName) }
    }
    runCatching {
      val ctor = cls.getDeclaredConstructor().apply { isAccessible = true }
      val inst = ctor.newInstance()
      if (inst != null) { Log.d("CarbonChainway", "newInstance() succeeded: ${inst.javaClass.simpleName}"); return inst }
    }
    return null
  }

  private fun tryApplyChainwayPower() {
    val cls = uhfClass ?: return
    val inst = uhfInstance ?: return
    val p = requestedPowerDbm.get().coerceIn(0, 30)
    val m = cls.methods.firstOrNull { it.name in setOf("UHFSetPower", "setPower", "SetPower", "setOutputPower") && it.parameterCount == 1 }
      ?.also { it.isAccessible = true } ?: return
    val arg: Any = if (m.parameterTypes[0] == java.lang.Character.TYPE) java.lang.Character(p.toChar()) else java.lang.Integer(p)
    runCatching { m.invoke(inst, arg) }
    Log.d("CarbonChainway", "${m.name}($p) applied")
  }

  private fun invokeInit(cls: Class<*>, inst: Any) {
    val ctx = context.applicationContext
    val rCls = inst.javaClass
    rCls.methods.filter { it.name.startsWith("UHF") }.forEach { m ->
      Log.d("CarbonChainway", "method ${m.name} params=${m.parameterTypes.map { it.simpleName }}")
    }
    fun find(vararg names: String): java.lang.reflect.Method? {
      for (name in names) rCls.methods.firstOrNull { it.name == name }?.let { it.isAccessible = true; return it }
      return null
    }

    val mInit = find("UHFInit") ?: run {
      find("init")?.let { it.isAccessible = true; runCatching { it.invoke(inst, ctx) } }
      return
    }

    Log.d("CarbonChainway", "Found UHFInit params=${mInit.parameterTypes.map { it.simpleName }}")
    for (uart in listOf("/dev/ttyMT1", "/dev/ttyMT0", "/dev/ttyMT2", "")) {
      val args = mInit.parameterTypes.map { t ->
        when {
          t == Context::class.java -> ctx
          t == String::class.java -> uart
          t == Int::class.javaPrimitiveType || t == java.lang.Integer.TYPE -> 0
          else -> null
        }
      }.toTypedArray()
      val ok = runCatching { mInit.invoke(inst, *args) as? Boolean ?: true }.getOrElse { false }
      Log.d("CarbonChainway", "UHFInit(${if (uart.isEmpty()) "\"\"" else "'$uart'"}) -> $ok")
      if (ok) break
    }

    val mOpen = find("UHFOpenAndConnect") ?: return
    Log.d("CarbonChainway", "Found UHFOpenAndConnect params=${mOpen.parameterTypes.map { it.simpleName }}")
    for (uart in listOf("/dev/ttyMT1", "/dev/ttyMT0", "")) {
      val args = mOpen.parameterTypes.map { t -> if (t == String::class.java) uart else null }.toTypedArray()
      val ok = runCatching { mOpen.invoke(inst, *args) as? Boolean ?: true }.getOrElse { false }
      Log.d("CarbonChainway", "UHFOpenAndConnect -> $ok")
      if (ok) { Log.d("CarbonChainway", "init() succeeded"); break }
    }
  }

  private fun emitEpc(hex: String, rssi: Int?) {
    val sink = tagSink ?: return
    val stripped = hex.uppercase().replace(Regex("[^0-9A-F]"), "")
    val up = when {
      stripped.length == 24 -> stripped
      stripped.length < 24 -> stripped.padEnd(24, '0')
      else -> stripped.take(24)
    }
    if (stripped.isEmpty() || up.count { it != '0' } <= 2) {
      Log.w("CarbonChainway", "emitEpc: rejected low-entropy epc='$up'")
      return
    }
    Log.d("CarbonChainway", "emitEpc len=${stripped.length}->${up.length} hex='$up'")
    val payload = mapOf("epc" to up, "rssi" to (rssi ?: -55))
    mainHandler.post { sink.success(payload) }
  }
}
