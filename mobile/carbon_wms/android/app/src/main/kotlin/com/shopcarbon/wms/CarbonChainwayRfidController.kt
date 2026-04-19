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
  private val pollCount = AtomicInteger(0)
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
        // Scan cls.methods[] directly — getMethod() fails across classloader boundaries
        val invNames = setOf("UHFInventory_EX_cnt", "UHFInventory", "UHFInventory_EX", "startInventoryTag")
        val mInv = cls.methods.firstOrNull { it.name in invNames }?.also { it.isAccessible = true }
        val paramTypes = mInv?.parameterTypes?.map { it.simpleName } ?: emptyList()
        Log.d("CarbonChainway", "startInventory method: ${mInv?.name ?: "NOT_FOUND"} params=$paramTypes")
        if (mInv == null) {
          mainHandler.post { result.error("INVENTORY_FAILED", "No start inventory method on Chainway class", null) }
          return@execute
        }
        // Build args for inventory start
        // UHFInventory_EX_cnt(char count, char session, char target):
        //   count=0 means "scan 0 times" = no-op! Pass 0xFF (255) for continuous-ish scanning.
        //   session=0 (S0), target=0 (A-flag). For UHFInventory/UHFInventory_EX pass zeros.
        var charArgIndex = 0
        val args = mInv.parameterTypes.map { t ->
          when {
            t == java.lang.Character.TYPE -> {
              val v = when {
                mInv.name == "UHFInventory_EX_cnt" && charArgIndex == 0 -> '\u00FF' // count=255
                else -> '\u0000'
              }.also { charArgIndex++ }
              java.lang.Character(v)
            }
            t == java.lang.Integer.TYPE -> java.lang.Integer(0)
            t == java.lang.Long.TYPE -> java.lang.Long(0L)
            t == java.lang.Boolean.TYPE -> java.lang.Boolean(false)
            t == String::class.java -> ""
            else -> null
          }
        }.toTypedArray()
        val ok = runCatching {
          (mInv.invoke(inst, *args) as? Boolean) ?: true
        }.getOrElse { e ->
          Log.e("CarbonChainway", "startInventory invoke failed: ${e.message}", e)
          false
        }
        Log.d("CarbonChainway", "${mInv.name}() -> $ok")
        if (ok == false) {
          mainHandler.post { result.error("INVENTORY_FAILED", "${mInv.name} returned false", null) }
          return@execute
        }
        scanning.set(true)
        // Try both: drain UHFGetReceived_EX2 buffer AND call UHFInventorySingleEPCTIDUSER
        // The single-shot method actively fires RF on every call, ensuring the antenna is live
        // even when the physical trigger is not held.
        val mSingle = cls.methods.firstOrNull { it.name == "UHFInventorySingleEPCTIDUSER" }?.also { it.isAccessible = true }
        Log.d("CarbonChainway", "pollLoop hasSingle=${mSingle != null} invMethod=${mInv.name}")
        // Keep reference to inventory method + args for re-triggering in poll loop
        val reInvArgs = args
        val reInvMethod = mInv
        pollThread =
          Thread {
            var emptyStreak = 0
            while (scanning.get()) {
              try {
                // Drain the background buffer (decodes ALL tags in one call now)
                val gotTag = readBufferOnce(cls, inst)
                if (gotTag) emptyStreak = 0 else emptyStreak++
                // Also fire single-shot to actively trigger RF emission
                if (mSingle != null) {
                  val raw = runCatching { mSingle.invoke(inst) }.getOrNull()
                  if (raw is CharArray) {
                    val bytes = raw.map { it.code and 0xFF }
                    // Reject if all non-first bytes are zero (no tag present, returning param noise)
                    val nonZeroCount = bytes.count { it != 0 }
                    if (nonZeroCount >= 3) {
                      val hex = bytes.take(12).joinToString("") { "%02X".format(it) }
                      if (hex.matches(Regex("[0-9A-F]{24}"))) {
                        Log.d("CarbonChainway", "single binaryEpc='$hex'")
                        emitEpc(hex, null)
                      } else {
                        // ASCII fallback
                        val epc = String(raw).trimEnd('\u0000').trim()
                        if (epc.length >= 24 && epc.matches(Regex("[0-9A-Fa-f]{24,}"))) {
                          emitEpc(maybeConvertUiiToEpc(cls, inst, epc.take(24)), null)
                        }
                      }
                    }
                  }
                }
                // Re-trigger inventory every 50 empty polls (~2.25s) — 255-count batch can
                // complete quickly when many tags are in range and we need to restart it
                if (emptyStreak > 0 && emptyStreak % 50 == 0) {
                  Log.d("CarbonChainway", "re-triggering ${reInvMethod.name} after $emptyStreak empty polls")
                  runCatching { reInvMethod.invoke(inst, *reInvArgs) }
                }
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
        for (name in listOf("UHFStopGet", "UHFCloseAndDisconnect", "stopInventory")) {
          cls.methods.firstOrNull { it.name == name && it.parameterCount == 0 }?.let { m ->
            m.isAccessible = true; runCatching { m.invoke(inst) }
          }
        }
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
      // Use methods[] scan — getMethod() fails across classloader boundaries
      for (name in listOf("UHFStopGet", "UHFCloseAndDisconnect", "UHFFree", "stopInventory", "free", "close")) {
        cls.methods.firstOrNull { it.name == name && it.parameterCount == 0 }?.let { m ->
          m.isAccessible = true
          runCatching { m.invoke(inst) }
        }
      }
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
    val powerNames = setOf("UHFSetPower", "setPower", "SetPower", "setOutputPower", "SetOutputPower")
    val m = cls.methods.firstOrNull { it.name in powerNames && it.parameterCount == 1 }?.also { it.isAccessible = true }
    if (m != null) {
      // UHFSetPower takes char on C72E — coerce int to char
      val arg: Any = when {
        m.parameterTypes[0] == java.lang.Character.TYPE -> java.lang.Character(p.toChar())
        else -> java.lang.Integer(p)
      }
      runCatching { m.invoke(inst, arg) }
      Log.d("CarbonChainway", "${m.name}($p) applied")
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
    // Log ALL UHF-prefixed methods with their param types for diagnosis
    rCls.methods.filter { it.name.startsWith("UHF") }.forEach { m ->
      Log.d("CarbonChainway", "method ${m.name} params=${m.parameterTypes.map{it.simpleName}}")
    }
    fun findMethodByName(vararg names: String): java.lang.reflect.Method? {
      for (name in names) {
        // Scan all public methods including those from parent classes in other classloaders
        val m = rCls.methods.firstOrNull { it.name == name }
        if (m != null) {
          m.isAccessible = true
          Log.d("CarbonChainway", "Found $name params=${m.parameterTypes.map{it.simpleName}}")
          return m
        }
      }
      return null
    }
    val mUhfInit = findMethodByName("UHFInit", "uhfInit")
    if (mUhfInit != null) {
      // C72E UHFInit(String) takes the UART device path — try ttyMT1 first, fallback to ""
      // The scanner APK references /dev/ttyMT2 but this device has ttyMT0/ttyMT1
      val uartPaths = listOf("/dev/ttyMT1", "/dev/ttyMT0", "/dev/ttyMT2", "")
      var initOk = false
      for (uart in uartPaths) {
        val initArgs = mUhfInit.parameterTypes.map { t ->
          when {
            t == Context::class.java -> ctx
            t == String::class.java -> uart
            t == Int::class.javaPrimitiveType || t == java.lang.Integer.TYPE -> 0
            t == Boolean::class.javaPrimitiveType || t == java.lang.Boolean.TYPE -> false
            else -> null
          }
        }.toTypedArray()
        val ok = runCatching { mUhfInit.invoke(inst, *initArgs) as? Boolean ?: true }.getOrElse { false }
        Log.d("CarbonChainway", "UHFInit('$uart') -> $ok")
        if (ok == true) { initOk = true; break }
      }
      if (!initOk) Log.w("CarbonChainway", "UHFInit returned false on all paths, continuing anyway")
      // Try UHFOpenAndConnect or UHFOpenAndConnect_Ex — also pass UART path
      val mOpen = findMethodByName("UHFOpenAndConnect", "UHFOpenAndConnect_Ex")
      if (mOpen != null) {
        val uartForOpen = listOf("/dev/ttyMT1", "/dev/ttyMT0", "/dev/ttyMT2", "")
        for (uart in uartForOpen) {
          val openArgs = mOpen.parameterTypes.map { t ->
            when {
              t == String::class.java -> uart
              t == Int::class.javaPrimitiveType || t == java.lang.Integer.TYPE -> 0
              else -> null
            }
          }.toTypedArray()
          val openOk = runCatching {
            mOpen.invoke(inst, *openArgs) as? Boolean ?: true
          }.getOrElse { e -> Log.w("CarbonChainway", "${mOpen.name}('$uart') failed: ${e.message}"); false }
          Log.d("CarbonChainway", "${mOpen.name}('$uart') -> $openOk")
          if (openOk == true) break
        }
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

  /** Active single-shot: UHFInventorySingleEPCTIDUSER fires RF and returns char[] with EPC. */
  private fun readSingleShot(cls: Class<*>, inst: Any) {
    val n = pollCount.incrementAndGet()
    val m = cls.methods.firstOrNull { it.name == "UHFInventorySingleEPCTIDUSER" }?.also { it.isAccessible = true } ?: return
    val raw = runCatching { m.invoke(inst) }.getOrNull() ?: return
    if (n % 200 == 0) Log.d("CarbonChainway", "single#$n type=${raw.javaClass.simpleName}")
    when {
      // C72E returns char[] — convert to String and trim nulls
      raw is CharArray -> {
        // Log first 30 non-null chars as hex for diagnosis
        val hexDump = raw.take(30).filter { it != '\u0000' }.joinToString("") { "%04X".format(it.code) }
        val epc = String(raw).trimEnd('\u0000').trim()
        if (epc.isNotEmpty()) {
          Log.d("CarbonChainway", "singleShot charArray len=${raw.size} hexDump='$hexDump' epc='$epc'")
          emitEpc(maybeConvertUiiToEpc(cls, inst, epc), null)
        }
      }
      // Some firmwares return a char[] wrapped as Object[]
      raw.javaClass.isArray && raw.javaClass.componentType == java.lang.Character.TYPE -> {
        @Suppress("UNCHECKED_CAST")
        val arr = raw as CharArray
        val epc = String(arr).trimEnd('\u0000').trim()
        if (epc.isNotEmpty()) {
          Log.d("CarbonChainway", "singleShot charArr2 epc='$epc'")
          emitEpc(maybeConvertUiiToEpc(cls, inst, epc), null)
        }
      }
      raw is String -> {
        val s = raw.trim()
        if (s.isNotEmpty()) {
          Log.d("CarbonChainway", "singleShot string epc='$s'")
          emitEpc(maybeConvertUiiToEpc(cls, inst, s), null)
        }
      }
      else -> {
        // Tag object with getEPC() or similar
        val hex = extractEpcStringFromTag(cls, inst, raw)
        if (!hex.isNullOrEmpty()) {
          Log.d("CarbonChainway", "singleShot tagObj epc='$hex'")
          emitEpc(hex, extractRssi(raw))
        }
      }
    }
  }

  private fun readBufferOnce(cls: Class<*>, inst: Any): Boolean {
    // UHFGetReceived_EX2(char[] buf): return value is count of buffered tags (-1 = empty).
    // The char[] gets filled with raw binary bytes (each char holds one byte via low 8 bits).
    // The buffer layout for multiple tags: each EPC96 tag = 12 bytes. With count=N tags,
    // the buffer contains N*12 bytes packed sequentially from offset 0.
    val n = pollCount.incrementAndGet()
    val m = cls.methods.firstOrNull { it.name == "UHFGetReceived_EX2" }?.also { it.isAccessible = true }
    if (m != null) {
      val buf = CharArray(256)
      val result = runCatching { m.invoke(inst, buf) }.getOrNull()
      val hexDump = buf.take(32).joinToString("") { "%02X".format(it.code and 0xFF) }
      if (n % 100 == 0) Log.d("CarbonChainway", "poll#$n UHFGetReceived_EX2 returnVal=$result hexDump=$hexDump")
      // returnVal=-1 means no tag in buffer; skip
      val count = (result as? Int) ?: (result as? Number)?.toInt() ?: -1
      if (count < 0) return false
      // Log a full dump whenever we get actual data
      Log.d("CarbonChainway", "poll#$n UHFGetReceived_EX2 count=$count hexDump=$hexDump")
      val bytes = buf.map { it.code and 0xFF }
      var emitted = false

      // Try to decode `count` sequential 12-byte EPC records from the buffer
      if (count > 0) {
        for (i in 0 until count) {
          val offset = i * 12
          if (offset + 12 > bytes.size) break
          val chunk = bytes.subList(offset, offset + 12)
          if (chunk.all { it == 0 }) continue
          val hex = chunk.joinToString("") { "%02X".format(it) }
          if (hex.matches(Regex("[0-9A-F]{24}"))) {
            Log.d("CarbonChainway", "readBufferOnce tag[$i] binaryEpc='$hex'")
            emitEpc(hex, null)
            emitted = true
          }
        }
        if (emitted) return true
      }

      // Fallback: scan the whole buffer for all non-zero 12-byte aligned runs
      var i = 0
      while (i + 12 <= bytes.size) {
        val chunk = bytes.subList(i, i + 12)
        if (chunk.any { it != 0 }) {
          val hex = chunk.joinToString("") { "%02X".format(it) }
          if (hex.matches(Regex("[0-9A-F]{24}"))) {
            Log.d("CarbonChainway", "readBufferOnce scan[$i] binaryEpc='$hex'")
            emitEpc(hex, null)
            emitted = true
          }
        }
        i += 12
      }
      if (emitted) return true

      // ASCII fallback: some firmwares write hex-string into buf
      val asciiHex = buf.takeWhile { it.code in 0x30..0x46 || it.code in 0x61..0x66 }
        .joinToString("") { it.toString() }.trim()
      if (asciiHex.matches(Regex("[0-9A-Fa-f]{24}"))) {
        Log.d("CarbonChainway", "readBufferOnce asciiEpc='$asciiHex'")
        emitEpc(asciiHex, null)
        return true
      }
      return false
    }
    // Fallback: generic read methods
    val readNames = setOf("UHFGetReceived", "readTagFromBuffer", "ReadTagFromBuffer")
    val mGen = cls.methods.firstOrNull { it.name in readNames }?.also { it.isAccessible = true } ?: return false
    val readArgs = mGen.parameterTypes.map { t ->
      when {
        t.isArray && t.componentType == java.lang.Character.TYPE -> CharArray(256)
        t == java.lang.Character.TYPE -> java.lang.Character('\u0000')
        t == java.lang.Integer.TYPE -> java.lang.Integer(0)
        else -> null
      }
    }.toTypedArray()
    val raw = runCatching { mGen.invoke(inst, *readArgs) }.getOrNull() ?: return false
    Log.d("CarbonChainway", "readBufferOnce generic raw type=${raw.javaClass.simpleName} val=$raw")
    return when (raw) {
      is String -> { if (raw.isNotBlank()) { emitEpc(maybeConvertUiiToEpc(cls, inst, raw.trim()), null); true } else false }
      is Array<*> -> {
        raw.filterNotNull().forEach { t ->
          if (t is String) { if (t.isNotBlank()) emitEpc(maybeConvertUiiToEpc(cls, inst, t.trim()), null) }
          else emitFromTagObject(cls, inst, t)
        }
        raw.isNotEmpty()
      }
      else -> { emitFromTagObject(cls, inst, raw); true }
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
    val epcGetterNames = setOf("getEPC", "getEpc", "getUid", "getUII")
    for (m in c.methods.filter { it.name in epcGetterNames && it.parameterCount == 0 }) {
      m.isAccessible = true
      val s = runCatching { (m.invoke(tag) as? String)?.trim() }.getOrNull()
      Log.d("CarbonChainway", "  ${m.name} -> '$s'")
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
    if (uii.isBlank()) return uii
    val convertNames = setOf("convertUiiToEPC", "ConvertUiiToEPC")
    val m = cls.methods.firstOrNull { it.name in convertNames && it.parameterCount == 1 }?.also { it.isAccessible = true }
    if (m != null) {
      val epc = runCatching { m.invoke(inst, uii) as? String }.getOrNull()
      Log.d("CarbonChainway", "convertUiiToEPC('$uii') -> '$epc'")
      if (!epc.isNullOrBlank()) return epc.trim().uppercase()
    }
    return uii.trim().uppercase()
  }

  private fun emitEpc(hex: String, rssi: Int?) {
    val sink = tagSink ?: return
    val r = rssi ?: -55
    // Normalize to exactly 24 uppercase hex chars
    val stripped = hex.uppercase().replace(Regex("[^0-9A-F]"), "")
    val up = when {
      stripped.length == 24 -> stripped
      stripped.length < 24 -> stripped.padEnd(24, '0')  // pad short EPCs
      else -> stripped.take(24)                          // truncate overlong
    }
    if (stripped.isEmpty()) {
      Log.w("CarbonChainway", "emitEpc: empty after strip, raw='$hex'")
      return
    }
    // Reject obviously invalid EPCs: all zeros, or only one non-zero byte (param noise)
    val nonZeroNibbles = up.count { it != '0' }
    if (nonZeroNibbles <= 2) {
      Log.w("CarbonChainway", "emitEpc: rejected low-entropy epc='$up'")
      return
    }
    Log.d("CarbonChainway", "emitEpc len=${stripped.length}->24 hex='$up'")
    val payload = mapOf("epc" to up, "rssi" to r)
    mainHandler.post { sink.success(payload) }
  }
}
