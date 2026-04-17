package com.shopcarbon.wms

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Chainway UHF via reflection so the app compiles without vendor JARs.
 * Drop `DeviceAPI*.jar` (and native `.so` from Chainway) into `android/app/libs/`.
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
  private var pollThread: Thread? = null

  /** Output power in dBm (0–30); applied via reflection when DeviceAPI exposes setPower. */
  private val requestedPowerDbm = AtomicInteger(30)
  @Volatile private var lastError: String? = null

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
    // Standard class-path names (works when vendor JAR is bundled or on some devices)
    val names =
      listOf(
        "com.rscja.deviceapi.DeviceAPI",
        "com.rscja.deviceapi.RFIDWithUHFUART",
        "com.rscja.deviceapi.module.RFIDWithUHFUART",
        "com.rscja.deviceapi.RFIDWithUHF",
        "com.rscja.deviceapi.RFIDWithUHFRLM",
        "com.rscja.deviceapi.module.RFIDWithUHFRLM",
        "com.rscja.deviceapi.RFIDWithUHFUsbToUart",
        "com.rscja.deviceapi.RFIDWithUHFABR",
      )
    for (n in names) {
      try {
        return Class.forName(n)
      } catch (_: Throwable) {
        /* next */
      }
    }

    // Chainway C72E / C-series: DeviceAPI class lives in com.rscja.scanner (keyboard.apk).
    // libDeviceAPI.so is already loaded in com.rscja.scanner's classloader (ClassLoader 0x2f7).
    // We must reuse that exact classloader — creating a new DexClassLoader fails with
    // UnsatisfiedLinkError "already opened by ClassLoader 0x2f7; can't open in ClassLoader 0xY".
    // Strategy: get the scanner's Context via createPackageContext, then use its classloader.
    val scannerPkgs = listOf("com.rscja.scanner", "com.rscja.secapp", "com.rscja.deviceapi")
    for (pkg in scannerPkgs) {
      try {
        val pkgCtx = context.createPackageContext(
          pkg,
          Context.CONTEXT_INCLUDE_CODE or Context.CONTEXT_IGNORE_SECURITY
        )
        val cl = pkgCtx.classLoader
        for (className in names) {
          try {
            val cls = cl.loadClass(className)
            Log.d("CarbonChainway", "createPackageContext classloader loaded '$className' from pkg=$pkg")
            return cls
          } catch (_: Throwable) { /* try next name */ }
        }
      } catch (_: Throwable) { /* pkg not found */ }
    }

    // Fallback: DexClassLoader (may hit the "already opened" issue if scanner is running,
    // but try anyway for devices where scanner isn't a separate process)
    val scannerApkPaths = listOf(
      "/system/app/keyboard/keyboard.apk",
      "/system/priv-app/keyboard/keyboard.apk",
      "/system/app/ScanManager/ScanManager.apk",
      "/system/priv-app/ScanManager/ScanManager.apk",
    )
    val optimizedDir = context.codeCacheDir.absolutePath
    val parentCl = context.classLoader
    for (apkPath in scannerApkPaths) {
      if (!java.io.File(apkPath).exists()) continue
      for (className in names) {
        try {
          val dcl = dalvik.system.DexClassLoader(apkPath, optimizedDir, null, parentCl)
          val cls = dcl.loadClass(className)
          Log.d("CarbonChainway", "DexClassLoader loaded '$className' from $apkPath")
          return cls
        } catch (_: Throwable) {
          /* try next */
        }
      }
    }
    return null
  }

  fun connectAsync(onDone: (Throwable?) -> Unit) {
    executor.execute {
      try {
        disconnectSync()
        val cls = resolveUhfClass()
        Log.d("CarbonChainway", "resolveUhfClass -> ${cls?.name ?: "null"}")
        if (cls == null) error("Chainway DeviceAPI class not found. Add vendor JAR + .so from Chainway to app/libs/.")
        uhfClass = cls
        // Log all methods immediately so we can inspect even if getInstance fails
        val methods = cls.methods.map { it.name }.distinct().sorted()
        Log.d("CarbonChainway", "UHF class methods: $methods")
        val ctors = cls.declaredConstructors.map { "${it.name}(${it.parameterTypes.map{p->p.simpleName}})" }
        Log.d("CarbonChainway", "UHF class constructors: $ctors")
        val inst = getStaticInstance(cls, context.applicationContext)
        Log.d("CarbonChainway", "getInstance -> ${inst?.javaClass?.simpleName ?: "null"}")
        if (inst == null) error("Chainway UHF getInstance() not found.")
        uhfInstance = inst
        invokeInit(cls, inst)
        Log.d("CarbonChainway", "init() succeeded")
        lastError = null
        mainHandler.post { onDone(null) }
      } catch (e: Throwable) {
        Log.e("CarbonChainway", "connect failed: ${e.message}", e)
        lastError = e.message ?: e.javaClass.simpleName
        disconnectSync()
        mainHandler.post { onDone(e) }
      }
    }
  }

  fun disconnectAsync() {
    executor.execute { disconnectSync() }
  }

  fun startInventoryFlutterResult(result: MethodChannel.Result) {
    executor.execute {
      try {
        val cls = uhfClass ?: run {
          mainHandler.post { result.error("NOT_CONNECTED", "Chainway not connected", null) }
          return@execute
        }
        val inst = uhfInstance ?: run {
          mainHandler.post { result.error("NOT_CONNECTED", "Chainway not connected", null) }
          return@execute
        }
        tryApplyChainwayPower()
        // DeviceAPI (C72E): UHFInventory_EX_cnt(int) is the continuous inventory method
        val mInv = runCatching { cls.getMethod("UHFInventory_EX_cnt", Int::class.javaPrimitiveType) }.getOrNull()
          ?: runCatching { cls.getMethod("UHFInventory") }.getOrNull()
          ?: runCatching { cls.getMethod("UHFInventory_EX") }.getOrNull()
          ?: runCatching { cls.getMethod("startInventoryTag") }.getOrNull()
          ?: runCatching { cls.getMethod("startInventoryTag", Int::class.javaPrimitiveType, Int::class.javaPrimitiveType) }.getOrNull()
        if (mInv == null) {
          mainHandler.post { result.error("INVENTORY_FAILED", "No start inventory method on Chainway class", null) }
          return@execute
        }
        val ok = when (mInv.parameterCount) {
          0 -> mInv.invoke(inst) as? Boolean ?: true
          1 -> mInv.invoke(inst, 0) as? Boolean ?: true
          2 -> mInv.invoke(inst, 0, 0) as? Boolean ?: true
          else -> mInv.invoke(inst) as? Boolean ?: true
        }
        Log.d("CarbonChainway", "${mInv.name}() -> $ok")
        if (ok == false) {
          mainHandler.post { result.error("INVENTORY_FAILED", "${mInv.name} returned false", null) }
          return@execute
        }
        scanning.set(true)
        pollThread =
          Thread {
            while (scanning.get()) {
              try {
                readBufferOnce(cls, inst)
                Thread.sleep(45)
              } catch (_: InterruptedException) {
                break
              } catch (_: Exception) {
                /* ignore single frame */
              }
            }
          }.also { it.start() }
        mainHandler.post { result.success(null) }
      } catch (e: Exception) {
        lastError = e.message ?: e.javaClass.simpleName
        mainHandler.post { result.error("INVENTORY_FAILED", e.message ?: "chainway_start", null) }
      }
    }
  }

  fun stopInventoryAsync() {
    executor.execute {
      scanning.set(false)
      pollThread?.interrupt()
      pollThread = null
      val cls = uhfClass
      val inst = uhfInstance
      if (cls != null && inst != null) {
        runCatching { cls.getMethod("UHFStopGet").invoke(inst) }
        runCatching { cls.getMethod("UHFCloseAndDisconnect").invoke(inst) }
        runCatching { cls.getMethod("stopInventory").invoke(inst) }
      }
    }
  }

  fun dispose() {
    executor.execute { disconnectSync() }
  }

  private fun disconnectSync() {
    scanning.set(false)
    pollThread?.interrupt()
    pollThread = null
    val cls = uhfClass
    val inst = uhfInstance
    if (cls != null && inst != null) {
      // DeviceAPI stop sequence (C72E confirmed methods)
      runCatching { cls.getMethod("UHFStopGet").invoke(inst) }
      runCatching { cls.getMethod("UHFCloseAndDisconnect").invoke(inst) }
      runCatching { cls.getMethod("UHFFree").invoke(inst) }
      // Generic fallbacks
      runCatching { cls.getMethod("stopInventory").invoke(inst) }
      runCatching { cls.getMethod("free").invoke(inst) }
      runCatching { cls.getMethod("close").invoke(inst) }
    }
    uhfClass = null
    uhfInstance = null
  }

  private fun getStaticInstance(cls: Class<*>, appCtx: Context): Any? {
    // Singleton factory: getInstance(Context)
    runCatching {
      val m = cls.getMethod("getInstance", Context::class.java)
      val inst = m.invoke(null, appCtx)
      if (inst != null) return inst
    }
    // Singleton factory: getInstance()
    runCatching {
      val m = cls.getMethod("getInstance")
      val inst = m.invoke(null)
      if (inst != null) return inst
    }
    // Static INSTANCE field
    runCatching {
      val inst = cls.getDeclaredField("INSTANCE").apply { isAccessible = true }.get(null)
      if (inst != null) return inst
    }
    // DeviceAPI on C72E has a no-arg constructor — load native lib first so <clinit> doesn't crash
    val nativeLibNames = listOf("DeviceAPI", "rscja_deviceapi", "uhfapi", "RFIDWithUHF")
    for (libName in nativeLibNames) {
      runCatching { System.loadLibrary(libName) }
    }
    // Direct instantiation — DeviceAPI on C72E is not a singleton, just construct it
    runCatching {
      val ctor = cls.getDeclaredConstructor().apply { isAccessible = true }
      val inst = ctor.newInstance()
      if (inst != null) {
        Log.d("CarbonChainway", "newInstance() succeeded: ${inst.javaClass.simpleName}")
        return inst
      }
    }.onFailure { e -> Log.w("CarbonChainway", "newInstance() failed: ${e.javaClass.simpleName}: ${e.message}") }
    // DeviceAPI may require Context in constructor
    runCatching {
      val ctor = cls.getDeclaredConstructor(Context::class.java).apply { isAccessible = true }
      val inst = ctor.newInstance(appCtx)
      if (inst != null) {
        Log.d("CarbonChainway", "newInstance(Context) succeeded")
        return inst
      }
    }.onFailure { e -> Log.w("CarbonChainway", "newInstance(Context) failed: ${e.javaClass.simpleName}: ${e.message}") }
    return null
  }

  /** Best-effort: common Chainway UHF APIs use `UHFSetPower(int)` in dBm (often 0–30). */
  private fun tryApplyChainwayPower() {
    val cls = uhfClass ?: return
    val inst = uhfInstance ?: return
    val p = requestedPowerDbm.get().coerceIn(0, 30)
    // C72E DeviceAPI confirmed method is UHFSetPower
    val names = listOf("UHFSetPower", "setPower", "SetPower", "setOutputPower", "SetOutputPower")
    for (name in names) {
      val m = runCatching { cls.getMethod(name, Int::class.javaPrimitiveType) }.getOrNull() ?: continue
      runCatching { m.invoke(inst, p) }
      Log.d("CarbonChainway", "$name($p) applied")
      return
    }
  }

  private fun invokeInit(cls: Class<*>, inst: Any) {
    val ctx = context.applicationContext
    // Use inst's actual runtime class for method lookups (the loaded class may differ from cls)
    val rCls = inst.javaClass
    Log.d("CarbonChainway", "invokeInit cls=${cls.name} rCls=${rCls.name} same=${cls==rCls}")
    // Step 1: RFID_init (hardware init, optional — C72E may or may not need it)
    rCls.methods.firstOrNull { it.name == "RFID_init" && it.parameterCount == 0 }?.let { m ->
      m.isAccessible = true
      runCatching {
        val ok = m.invoke(inst) as? Boolean ?: true
        Log.d("CarbonChainway", "RFID_init() -> $ok")
      }.onFailure { Log.w("CarbonChainway", "RFID_init invoke failed: ${it.message}") }
    }
    // Step 2: DeviceAPI (C72E) pattern: UHFInit() then UHFOpenAndConnect()
    // Note: getMethod/getDeclaredMethod fail when the method's declaring class is loaded by a
    // different classloader. Use cls.methods[] (which includes inherited) and match by name.
    fun findMethodByName(vararg names: String): java.lang.reflect.Method? {
      for (name in names) {
        // First try public API (works when declaring class is in same classloader hierarchy)
        runCatching { rCls.getMethod(name) }.getOrNull()?.let { return it }
        // Then scan all public methods including those from parent classes in other classloaders
        rCls.methods.firstOrNull { it.name == name && it.parameterCount == 0 }?.also {
          it.isAccessible = true
          Log.d("CarbonChainway", "Found $name via cls.methods[] scan")
          return it
        }
      }
      return null
    }
    val mUhfInit = findMethodByName("UHFInit", "uhfInit")
    if (mUhfInit != null) {
      val ok = runCatching { mUhfInit.invoke(inst) as? Boolean ?: true }.getOrElse { e ->
        Log.w("CarbonChainway", "UHFInit invoke failed: ${e.message}")
        true // continue anyway
      }
      Log.d("CarbonChainway", "UHFInit() -> $ok")
      if (!ok) Log.w("CarbonChainway", "UHFInit returned false, continuing anyway")
      // Try UHFOpenAndConnect or UHFOpenAndConnect_Ex
      val mOpen = findMethodByName("UHFOpenAndConnect")
        ?: rCls.methods.firstOrNull { it.name == "UHFOpenAndConnect_Ex" }?.also { it.isAccessible = true }
      if (mOpen != null) {
        val openOk = runCatching {
          if (mOpen.parameterCount == 0) mOpen.invoke(inst) as? Boolean ?: true
          else mOpen.invoke(inst, "") as? Boolean ?: true
        }.getOrElse { e -> Log.w("CarbonChainway", "${mOpen.name} invoke failed: ${e.message}"); false }
        Log.d("CarbonChainway", "${mOpen.name} -> $openOk")
        if (openOk == false) error("${mOpen.name} returned false")
      }
      return
    }
    // Standard init(Context) or init()
    val mCtx = rCls.methods.firstOrNull { it.name == "init" && it.parameterCount == 1 && it.parameterTypes[0].isAssignableFrom(ctx.javaClass) }
    if (mCtx != null) {
      mCtx.isAccessible = true
      val ok = mCtx.invoke(inst, ctx) as? Boolean ?: true
      Log.d("CarbonChainway", "init(Context) -> $ok")
      if (!ok) error("Chainway init(Context) returned false")
      return
    }
    val mNo = rCls.methods.firstOrNull { it.name == "init" && it.parameterCount == 0 }
    if (mNo != null) {
      mNo.isAccessible = true
      val ok = mNo.invoke(inst) as? Boolean ?: true
      Log.d("CarbonChainway", "init() -> $ok")
      if (!ok) error("Chainway init() returned false")
      return
    }
    // No init methods found — but we have a valid instance, so log and continue without erroring
    // (DeviceAPI on C72E may initialize lazily or via UHFInit which might not be found via reflection)
    Log.w("CarbonChainway", "No init method found on ${rCls.name}, will proceed and hope for the best")
  }

  private fun readBufferOnce(cls: Class<*>, inst: Any) {
    val m =
      // DeviceAPI (C72E): UHFGetReceived_EX2 is confirmed present
      runCatching { cls.getMethod("UHFGetReceived_EX2") }.getOrNull()
        ?: runCatching { cls.getMethod("UHFGetReceived") }.getOrNull()
        ?: runCatching { cls.getMethod("UHFInventorySingleEPCTIDUSER") }.getOrNull()
        ?: runCatching { cls.getMethod("readTagFromBuffer") }.getOrNull()
        ?: runCatching { cls.getMethod("ReadTagFromBuffer") }.getOrNull()
        ?: return
    val raw = m.invoke(inst) ?: return
    Log.d("CarbonChainway", "readBufferOnce raw type=${raw.javaClass.simpleName} val=$raw")
    when (raw) {
      is Array<*> -> {
        for (t in raw) {
          if (t == null) continue
          if (t is String) {
            val s = t.trim()
            Log.d("CarbonChainway", "  array-String raw='$s'")
            if (s.isNotEmpty()) emitEpc(maybeConvertUiiToEpc(cls, inst, s), null)
          } else {
            Log.d("CarbonChainway", "  array-obj type=${t.javaClass.simpleName} val=$t")
            emitFromTagObject(cls, inst, t)
          }
        }
      }
      is Iterable<*> -> {
        for (t in raw) {
          if (t == null) continue
          if (t is String) {
            val s = t.trim()
            Log.d("CarbonChainway", "  iter-String raw='$s'")
            if (s.isNotEmpty()) emitEpc(maybeConvertUiiToEpc(cls, inst, s), null)
          } else {
            Log.d("CarbonChainway", "  iter-obj type=${t?.javaClass?.simpleName} val=$t")
            emitFromTagObject(cls, inst, t!!)
          }
        }
      }
      is String -> {
        Log.d("CarbonChainway", "  direct-String raw='$raw'")
        if (raw.isNotBlank()) emitEpc(maybeConvertUiiToEpc(cls, inst, raw.trim()), null)
      }
      else -> {
        Log.d("CarbonChainway", "  else-obj type=${raw.javaClass.simpleName} val=$raw")
        emitFromTagObject(cls, inst, raw)
      }
    }
  }

  /** Try to read RSSI from Chainway tag objects (UHFTAGInfo, etc.) via reflection. */
  private fun extractRssi(tag: Any): Int? {
    val c = tag.javaClass
    val methodNames = listOf("getRssi", "getRSSI", "getRssiValue", "getPeakRssi", "getPeakRSSI")
    for (name in methodNames) {
      val v =
        runCatching {
          val m = c.getMethod(name)
          when (val o = m.invoke(tag)) {
            is Int -> o
            is Short -> o.toInt()
            is Byte -> o.toInt()
            is String -> o.trim().toIntOrNull()
            else -> null
          }
        }.getOrNull()
      if (v != null) return v
    }
    for (f in c.declaredFields) {
      if (!f.name.contains("rssi", ignoreCase = true)) continue
      runCatching {
        f.isAccessible = true
        when (val o = f.get(tag)) {
          is Int -> return o
          is Short -> return o.toInt()
        }
      }
    }
    return null
  }

  private fun extractEpcStringFromTag(cls: Class<*>, inst: Any, tag: Any): String? {
    val c = tag.javaClass
    // Log all available methods the first time we see this tag type
    val tagMethods = c.methods.map { it.name }.distinct().sorted()
    Log.d("CarbonChainway", "tag type=${c.simpleName} methods=$tagMethods")
    for (name in listOf("getEPC", "getEpc", "getUid", "getUII")) {
      val s =
        runCatching {
          val m = c.getMethod(name)
          (m.invoke(tag) as? String)?.trim()
        }.getOrNull()
      Log.d("CarbonChainway", "  $name -> '$s'")
      if (!s.isNullOrEmpty()) return maybeConvertUiiToEpc(cls, inst, s)
    }
    val raw = tag.toString().trim()
    Log.d("CarbonChainway", "  toString -> '$raw'")
    return if (raw.isNotEmpty()) maybeConvertUiiToEpc(cls, inst, raw) else null
  }

  private fun emitFromTagObject(cls: Class<*>, inst: Any, tag: Any) {
    val hex = extractEpcStringFromTag(cls, inst, tag) ?: return
    val rssi = extractRssi(tag)
    emitEpc(hex, rssi)
  }

  private fun maybeConvertUiiToEpc(cls: Class<*>, inst: Any, uii: String): String {
    val m = runCatching { cls.getMethod("convertUiiToEPC", String::class.java) }.getOrNull()
      ?: runCatching { cls.getMethod("ConvertUiiToEPC", String::class.java) }.getOrNull()
    if (m != null) {
      val epc = runCatching { m.invoke(inst, uii) as? String }.getOrNull()
      Log.d("CarbonChainway", "convertUiiToEPC('$uii') -> '$epc'")
      if (!epc.isNullOrBlank()) return epc.trim().uppercase()
    } else {
      Log.d("CarbonChainway", "convertUiiToEPC not found, returning uii='$uii' as-is")
    }
    return uii.trim().uppercase()
  }

  private fun emitEpc(hex: String, rssi: Int?) {
    val sink = tagSink ?: return
    val r = rssi ?: -55
    val up = hex.uppercase()
    Log.d("CarbonChainway", "emitEpc len=${up.length} hex='$up'")
    val payload = mapOf("epc" to up, "rssi" to r)
    mainHandler.post { sink.success(payload) }
  }
}
