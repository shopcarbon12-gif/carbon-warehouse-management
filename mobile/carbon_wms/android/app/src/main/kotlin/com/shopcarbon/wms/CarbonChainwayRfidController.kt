package com.shopcarbon.wms

import android.content.Context
import android.os.Handler
import android.os.Looper
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

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

  fun setTagSink(sink: EventChannel.EventSink?) {
    tagSink = sink
  }

  fun resolveUhfClass(): Class<*>? {
    val names =
      listOf(
        "com.rscja.deviceapi.RFIDWithUHFUART",
        "com.rscja.deviceapi.module.RFIDWithUHFUART",
        "com.rscja.deviceapi.RFIDWithUHF",
      )
    for (n in names) {
      try {
        return Class.forName(n)
      } catch (_: Throwable) {
        /* next */
      }
    }
    return null
  }

  fun connectAsync(onDone: (Throwable?) -> Unit) {
    executor.execute {
      try {
        disconnectSync()
        val cls = resolveUhfClass() ?: error("Chainway DeviceAPI class not found. Add vendor JAR to app/libs/.")
        uhfClass = cls
        val inst = getStaticInstance(cls) ?: error("Chainway UHF getInstance() not found.")
        uhfInstance = inst
        invokeInit(cls, inst)
        mainHandler.post { onDone(null) }
      } catch (e: Throwable) {
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
        val m0 = runCatching { cls.getMethod("startInventoryTag") }.getOrNull()
        val m2 =
          runCatching {
            cls.getMethod("startInventoryTag", Int::class.javaPrimitiveType, Int::class.javaPrimitiveType)
          }.getOrNull()
        val ok =
          when {
            m0 != null -> m0.invoke(inst) as? Boolean ?: true
            m2 != null -> m2.invoke(inst, 0, 0) as? Boolean ?: true
            else -> error("startInventoryTag not found on Chainway class")
          }
        if (!ok) {
          mainHandler.post { result.error("INVENTORY_FAILED", "Chainway startInventoryTag returned false", null) }
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
      runCatching { cls.getMethod("stopInventory").invoke(inst) }
      runCatching { cls.getMethod("free").invoke(inst) }
    }
    uhfClass = null
    uhfInstance = null
  }

  private fun getStaticInstance(cls: Class<*>): Any? {
    return runCatching {
      val m = cls.getMethod("getInstance")
      m.invoke(null)
    }.getOrElse {
      runCatching {
        cls.getDeclaredField("INSTANCE").apply { isAccessible = true }.get(null)
      }.getOrNull()
    }
  }

  private fun invokeInit(cls: Class<*>, inst: Any) {
    val ctx = context.applicationContext
    val mCtx = runCatching { cls.getMethod("init", Context::class.java) }.getOrNull()
    if (mCtx != null) {
      val ok = mCtx.invoke(inst, ctx) as? Boolean ?: true
      if (!ok) error("Chainway init(Context) returned false")
      return
    }
    val mNo = runCatching { cls.getMethod("init") }.getOrNull()
    if (mNo != null) {
      val ok = mNo.invoke(inst) as? Boolean ?: true
      if (!ok) error("Chainway init() returned false")
      return
    }
    error("No Chainway init(Context) or init()")
  }

  private fun readBufferOnce(cls: Class<*>, inst: Any) {
    val m =
      runCatching { cls.getMethod("readTagFromBuffer") }.getOrNull()
        ?: runCatching { cls.getMethod("ReadTagFromBuffer") }.getOrNull()
        ?: return
    val raw = m.invoke(inst) ?: return
    when (raw) {
      is Array<*> -> {
        for (t in raw) {
          val s = t?.toString()?.trim() ?: continue
          if (s.isNotEmpty()) emitEpc(maybeConvertUiiToEpc(cls, inst, s))
        }
      }
      is Iterable<*> -> {
        for (t in raw) {
          val s = t?.toString()?.trim() ?: continue
          if (s.isNotEmpty()) emitEpc(maybeConvertUiiToEpc(cls, inst, s))
        }
      }
      is String -> if (raw.isNotBlank()) emitEpc(maybeConvertUiiToEpc(cls, inst, raw.trim()))
    }
  }

  private fun maybeConvertUiiToEpc(cls: Class<*>, inst: Any, uii: String): String {
    val m = runCatching { cls.getMethod("convertUiiToEPC", String::class.java) }.getOrNull()
      ?: runCatching { cls.getMethod("ConvertUiiToEPC", String::class.java) }.getOrNull()
    if (m != null) {
      val epc = runCatching { m.invoke(inst, uii) as? String }.getOrNull()
      if (!epc.isNullOrBlank()) return epc.trim().uppercase()
    }
    return uii.trim().uppercase()
  }

  private fun emitEpc(hex: String) {
    val sink = tagSink ?: return
    val payload = mapOf("epc" to hex.uppercase(), "rssi" to -55)
    mainHandler.post { sink.success(payload) }
  }
}
