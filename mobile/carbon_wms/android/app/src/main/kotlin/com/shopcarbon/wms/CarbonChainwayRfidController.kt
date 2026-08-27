package com.shopcarbon.wms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.rscja.deviceapi.RFIDWithUHFUART
import com.rscja.deviceapi.entity.UHFTAGInfo
import com.rscja.deviceapi.interfaces.IUHFInventoryCallback
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
  // Default at 27 dBm = 500 mW. Matches Dart's runtime warehouse-default
  // and gives ~3m read range. 30 dBm/1W is the chip's max but historically
  // wedged this MTK firmware variant on cold-init; Dart can push to 30
  // later via setAntennaPowerDbm if the user opts in.
  private val requestedPowerDbm = AtomicInteger(23)
  @Volatile private var drainThread: Thread? = null
  @Volatile private var uartOwned = false
  @Volatile private var uhfReader: RFIDWithUHFUART? = null
  @Volatile private var uhfInitialized: Boolean = false
  @Volatile private var uhfInventoryActive: Boolean = false
  // Reference-app-pattern poller (see HANDOFF_FOR_OTHER_CLAUDE.md §3.1) — `setInventoryCallback`
  // is unreliable on C72E MTK firmware (callback never fires); polling `readTagFromBuffer()`
  // from a plain Java Thread does. Keep both paths active and dedup via [seenEpcs] —
  // whichever fires first wins.
  @Volatile private var tagPollThread: Thread? = null
  private val uhfLock = Any()

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
    Log.d(TAG, "TRACE setTagSink: sink=${if (sink != null) "BOUND" else "NULL"} (was ${if (tagSink != null) "BOUND" else "NULL"})")
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
      val clamped = dbm.coerceIn(5, 23)
      val prior = requestedPowerDbm.getAndSet(clamped)
      if (prior == clamped) {
        // Idempotent. Dedupe the double-fire that MobileSettingsRepository
        // .setGlobalAntennaPower causes (it both writes prefs+native AND
        // calls notifyListeners which triggers RfidManager.reapplyHandheld
        // HardwareSettings → another setAntennaPowerDbm). With the Dart-
        // side slider already debounced to 250 ms, the only remaining
        // doubling is this listener path — skip when the value didn't
        // actually change.
        return@execute
      }
      // REVERTED 2026-05-29: cache-only update. The 1.2.80 "fix" inserted
      // a stop + setPower + startInventoryTag sandwich here, which looked
      // safe but actually re-introduced the C72E MTK firmware wedge that
      // line 530-533 (dead-air watchdog comment) explicitly warns against:
      // "The cycle does NOT touch setPower (which is the path that wedges
      // this chip)". Symptom matches what the operator reported on
      // 1.2.80 — at "8 dBm" the radio keeps reading like nothing changed,
      // then mid-trigger the beeping stops (chip wedged into
      // "startInventoryTag returns true but firmware never transmits"
      // state). The dead-air kicker (stop → 40 ms sleep → start, no
      // setPower) CANNOT recover from a setPower wedge — only
      // reader.free() + a full re-init does, and we don't run that on
      // every slider tick.
      //
      // Where the cached value gets applied: initUhfReaderDirect() reads
      // requestedPowerDbm.get() at line 312 and calls instance.setPower
      // once on chip init. So a slider change here takes effect at the
      // next init boundary — app restart or RfidManager.useChainway()
      // re-swap. Not ideal UX-wise, but the alternative is a wedged
      // radio mid-locate.
      //
      // applyPower() exists for the reflective-UART branch (uartOwned =
      // true). It returns early when uhfClass / uhfInstance are null,
      // which is the default SDK path on this device — so it's a no-op
      // in practice. Kept for completeness.
      Log.d(TAG, "setAntennaPowerDbm($clamped) cached prior=$prior (chip apply deferred to next init — MTK setPower-wedge guard)")
      applyPower()
    }
  }

  // ── Direct UHF SDK ───────────────────────────────────────────────────────────

  private fun initUhfReaderDirect(): Boolean {
    synchronized(uhfLock) {
      if (uhfInitialized && uhfReader != null) {
        Log.d(TAG, "UHF reader already initialized")
        return true
      }
      return try {
        // Phase 1 — recovery-app-style minimal init (just getInstance/init/
        // setPower/startInventoryTag/poll). The recovery app uses setPower(20)
        // because its 5s test only needs to prove "reads work at all". For
        // production warehouse use we need real read range across hundreds of
        // tags, so we use the working device dump's value of 30 dBm.
        val instance = RFIDWithUHFUART.getInstance()
        if (instance == null) {
          Log.w(TAG, "RFIDWithUHFUART.getInstance() returned null")
          return false
        }
        val initOk = instance.init(context)
        Log.d(TAG, "RFIDWithUHFUART.init(context) -> $initOk")
        if (!initOk) {
          Log.w(TAG, "RFIDWithUHFUART init failed")
          return false
        }
        // -------------------------------------------------------------
        // Senitron-pattern init: region → protocol → EPC mode → power
        // On this firmware variant the chip's NVRAM-persisted region is
        // unreliable (boots into mode 8 on cold boot). Always re-apply.
        // -------------------------------------------------------------
        try {
          val freqOk = instance.setFrequencyMode(2)  // 2 = FCC US 902-928 MHz
          Log.d(TAG, "init: setFrequencyMode(2) FCC -> $freqOk")
        } catch (t: Throwable) {
          Log.w(TAG, "init: setFrequencyMode(2) threw: ${t.message}")
        }
        // setProtocol(0) is rejected by this firmware (err -1).
        // The reference app does not call setProtocol at init either —
        // chip default protocol is fine. Skipping.
        try {
          val epcOk = instance.setEPCMode()
          Log.d(TAG, "init: setEPCMode() -> $epcOk")
        } catch (t: Throwable) {
          Log.w(TAG, "init: setEPCMode() threw: ${t.message}")
        }
        // Stage-2 revert: both setFastID(true) AND setTagFocus(true) removed.
        // Stage 1 (TagFocus retained, FastID removed) showed 4 reads in
        // the first 118 ms then dead silence — classic TagFocus signature
        // (tags reply once and stay quiet indefinitely on this firmware).
        // Bisect continues: drop TagFocus, keep Gen2 tuning only.
        //
        // Stage-3: NOT setting these to true was insufficient. Field testing on
        // 1.2.16/1.2.17 reproduced the same 1-3-hits-then-silence pattern even
        // with setQuerySession=0 applied — meaning the chip's NVRAM is still
        // booting with TagFocus and/or FastID enabled from a prior session.
        // Explicitly clearing them at init (false/0) is what unsticks the
        // chip back to multi-read-per-tag inventory. The runCatching wraps
        // both because some Chainway SDK builds don't expose one or the
        // other; whichever is missing silently no-ops.
        runCatching {
          val tfMethod = instance.javaClass.methods.firstOrNull {
            it.name == "setTagFocus" && it.parameterCount == 1
          }
          if (tfMethod != null) {
            tfMethod.isAccessible = true
            val ptype = tfMethod.parameterTypes[0]
            val arg: Any = when {
              ptype == java.lang.Boolean.TYPE -> false
              ptype == Int::class.javaPrimitiveType -> 0
              else -> 0
            }
            val r = tfMethod.invoke(instance, arg)
            Log.d(TAG, "init: setTagFocus(false/0) -> $r")
          } else {
            Log.d(TAG, "init: setTagFocus method not found on this SDK build")
          }
        }.onFailure { Log.w(TAG, "init: setTagFocus(false) threw: ${it.message}") }
        runCatching {
          val fiMethod = instance.javaClass.methods.firstOrNull {
            it.name == "setFastID" && it.parameterCount == 1
          }
          if (fiMethod != null) {
            fiMethod.isAccessible = true
            val ptype = fiMethod.parameterTypes[0]
            val arg: Any = when {
              ptype == java.lang.Boolean.TYPE -> false
              ptype == Int::class.javaPrimitiveType -> 0
              else -> false
            }
            val r = fiMethod.invoke(instance, arg)
            Log.d(TAG, "init: setFastID(false) -> $r")
          } else {
            Log.d(TAG, "init: setFastID method not found on this SDK build")
          }
        }.onFailure { Log.w(TAG, "init: setFastID(false) threw: ${it.message}") }
        // Diagnostic readback after writes
        try {
          Log.d(TAG, "init: post-region readbacks freq=" +
            "${instance.getFrequencyMode()} proto=${instance.getProtocol()}")
        } catch (_: Throwable) {}

        // Apply the user's requested power (Dart-side runtime config sets
        // this to 27 dBm for warehouse inventory). 20 dBm = 100 mW = ~1m
        // range, which only finds the closest 2-3 tags out of a 200-tag
        // crowd. 27 dBm = 500 mW = ~3m range. setPower(30)=1W historically
        // wedged this firmware variant; 27 is in the safe range.
        val initPower = requestedPowerDbm.get().coerceIn(5, 23)
        val powerOk = instance.setPower(initPower)
        Log.d(TAG, "RFIDWithUHFUART.setPower($initPower) -> $powerOk")

        // S0/A Gen2 profile — chip-friendly tuning for the stationary
        // test. Session=0 makes tags reset their session flag almost
        // immediately, so the chip can re-read the same tags repeatedly
        // without waiting for S1's ~500ms persistence to expire. StartQ/
        // MinQ/MaxQ left at the chip's default (4 / 0 / 15) so the dynamic-
        // Q algorithm can shrink to 1 slot when only a handful of tags
        // are responding (which has been the actual population on this
        // antenna position).
        runCatching {
          val current = instance.javaClass.getMethod("getGen2").invoke(instance)
          if (current != null) {
            val gen2Cls = current.javaClass
            // Pre-mutation readback — log every getter on the Gen2 entity.
            val preFields = gen2Cls.methods
              .filter { it.name.startsWith("get") && it.parameterCount == 0 && it.name != "getClass" }
              .joinToString(", ") { m ->
                runCatching { "${m.name.removePrefix("get")}=${m.invoke(current)}" }
                  .getOrDefault("${m.name.removePrefix("get")}=ERR")
              }
            Log.d(TAG, "init: getGen2() pre-mutation: $preFields")

            gen2Cls.getMethod("setQuerySession", Int::class.javaPrimitiveType).invoke(current, 0)
            gen2Cls.getMethod("setQueryTarget", Int::class.javaPrimitiveType).invoke(current, 0)
            gen2Cls.getMethod("setStartQ", Int::class.javaPrimitiveType).invoke(current, 4)
            gen2Cls.getMethod("setMinQ", Int::class.javaPrimitiveType).invoke(current, 0)
            gen2Cls.getMethod("setMaxQ", Int::class.javaPrimitiveType).invoke(current, 15)
            val setGen2 = instance.javaClass.getMethod("setGen2", gen2Cls)
            val gen2Ok = setGen2.invoke(instance, current) as? Boolean ?: false
            Log.d(TAG, "init: setGen2(session=0/target=0/Q=4,0..15) -> $gen2Ok")

            // Post-write readback — should be identical to pre since
            // mutation is disabled. Kept for diagnostic symmetry.
            val verify = instance.javaClass.getMethod("getGen2").invoke(instance)
            if (verify != null) {
              val postFields = verify.javaClass.methods
                .filter { it.name.startsWith("get") && it.parameterCount == 0 && it.name != "getClass" }
                .joinToString(", ") { m ->
                  runCatching { "${m.name.removePrefix("get")}=${m.invoke(verify)}" }
                    .getOrDefault("${m.name.removePrefix("get")}=ERR")
                }
              Log.d(TAG, "init: getGen2() post-write: $postFields")
            }
          } else {
            Log.w(TAG, "init: setGen2 skipped — getGen2() returned null")
          }
        }.onFailure {
          Log.w(TAG, "init: setGen2 failed: ${it.message}")
        }

        // Diagnostic readback so we can compare against the working device.
        val fwVersion = runCatching { instance.getVersion() }.getOrNull()
        val hwVersion = runCatching { instance.getHardwareVersion() }.getOrNull()
        val gotPower = runCatching { instance.getPower() }.getOrDefault(-1)
        val gotFreq = runCatching { instance.getFrequencyMode() }.getOrDefault(-1)
        val gotProto = runCatching { instance.getProtocol() }.getOrDefault(-1)
        val gotRFLink = runCatching { instance.getRFLink() }.getOrDefault(-1)
        Log.d(TAG, "RFIDWithUHFUART post-init: fw=$fwVersion hw=$hwVersion power=$gotPower freq=$gotFreq proto=$gotProto rflink=$gotRFLink")
        if (fwVersion.isNullOrBlank()) {
          lastError = "uhf_radio_dead"
          Log.w(TAG, "RFIDWithUHFUART post-init: getVersion() returned null/empty — radio likely dead")
        }
        // setInventoryCallback intentionally NOT called — the recovery app's
        // proven-working pattern uses only readTagFromBuffer() polling. On C72E
        // MTK firmware, registering a callback may switch the SDK into
        // "callback mode" which silently routes tags away from the buffer
        // without firing the callback either, producing the 0-hits symptom.
        uhfReader = instance
        uhfInitialized = true
        Log.d(TAG, "UHF reader initialized successfully")
        true
      } catch (t: Throwable) {
        Log.e(TAG, "initUhfReaderDirect exception: ${t.message}", t)
        false
      }
    }
  }

  /**
   * reference-app pattern (HANDOFF Part 8 #2): bind the C72E side trigger (keycode 139)
   * to the scanner key dispatcher BEFORE the UHF SDK initializes. Without this call
   * the firmware may not emit any Android KeyEvent for trigger pulls — even when
   * the SDK init itself succeeds — on a fresh-reset or post-recovery device.
   *
   * Reflective + idempotent. Safe to call multiple times. Failures are logged and
   * non-fatal — older SDK builds without this method just continue.
   */
  private fun configureScannerSideKey() {
    try {
      val cls = Class.forName("com.rscja.scanner.utility.ScannerUtility")
      val instance = cls.getMethod("getScannerInerface").invoke(null) ?: run {
        Log.w(TAG, "configureScannerSideKey: getScannerInerface returned null")
        return
      }
      val m = cls.getMethod(
        "setScanKey",
        Context::class.java,
        Int::class.javaPrimitiveType,
        IntArray::class.java,
      )
      m.invoke(instance, context.applicationContext, 0, intArrayOf(139, 1, 1, 1))
      Log.d(TAG, "configureScannerSideKey: setScanKey(ctx, 0, {139,1,1,1}) OK")
    } catch (t: Throwable) {
      val cause = (t as? java.lang.reflect.InvocationTargetException)?.cause ?: t
      Log.w(TAG, "configureScannerSideKey: ${cause.javaClass.simpleName}: ${cause.message}")
    }
  }

  /**
   * Recovery memory note + reference-app pattern: invoke `ScannerUtility.resetScan(ctx)`
   * to engage the R2000's antenna PA gate. Without this, `init=true` and
   * `startInventoryTag=true` but `readTagFromBuffer()` always returns null —
   * exactly the symptom we observed in 1.2.6 (4400 null reads, 0 hits). The
   * recovery app's red button does this; we do it inline.
   */
  private fun engageAntennaPaGate() {
    try {
      val cls = Class.forName("com.rscja.scanner.utility.ScannerUtility")
      val instance = cls.getMethod("getScannerInerface").invoke(null) ?: run {
        Log.w(TAG, "engageAntennaPaGate: getScannerInerface returned null")
        return
      }
      val m = cls.getMethod("resetScan", Context::class.java)
      m.invoke(instance, context.applicationContext)
      // 50ms is enough for the scanner service to reset the antenna PA gate.
      // The earlier 1000ms sleep was a "huge delay" complaint from the user
      // because it blocks every trigger pull. resetScan returns once the
      // command is queued; the gate opens within a few ms.
      Thread.sleep(50)
      Log.d(TAG, "engageAntennaPaGate: resetScan(ctx) done")
    } catch (t: Throwable) {
      val cause = (t as? java.lang.reflect.InvocationTargetException)?.cause ?: t
      Log.w(TAG, "engageAntennaPaGate: ${cause.javaClass.simpleName}: ${cause.message}")
    }
  }

  /**
   * reference-app pattern (HANDOFF_FOR_OTHER_CLAUDE.md §D1): initialize the UHF SDK at
   * app launch, not lazily on Count entry. This grabs `/dev/ttyMT1` before the
   * system scanner service rebinds it, eliminating the `init=false` failure we see
   * when Count tries to acquire the UART after `com.rscja.scanner` has it locked.
   *
   * Safe to call multiple times — `initUhfReaderDirect` is idempotent. Returns true
   * on success.
   */
  fun acquireUartEarly(): Boolean {
    // Try multiple times with progressively-more-aggressive UART eviction. The
    // scanner service auto-restarts after `killBackgroundProcesses` so we need to
    // race it: kill, sleep just enough for the kernel to release the fd, init.
    //
    // SDK init only — the reflective UHFOpenAndConnect path consistently fails
    // on this device's UART (returns -1/-98) and leaving the chip in a half-open
    // state from a failed reflective attempt also breaks the subsequent SDK
    // init. Stick to SDK init here and let connectAsync handle reflective.
    repeat(3) { attempt ->
      try {
        val ok = initUhfReaderDirect()
        Log.d(TAG, "acquireUartEarly attempt #${attempt + 1}: initUhfReaderDirect -> $ok")
        if (ok) return true
        try {
          val am = context.getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
          am.killBackgroundProcesses("com.rscja.scanner")
          am.killBackgroundProcesses("com.rscja.ht")
          Log.d(TAG, "acquireUartEarly: killed scanner pkgs (retry imminent)")
        } catch (t: Throwable) {
          Log.w(TAG, "acquireUartEarly killBackgroundProcesses failed: ${t.message}")
        }
        Thread.sleep(500L) // kernel needs time to release /dev/ttyMT1
      } catch (t: Throwable) {
        Log.w(TAG, "acquireUartEarly attempt #${attempt + 1} threw: ${t.message}", t)
      }
    }
    Log.w(TAG, "acquireUartEarly: all 3 attempts failed")
    return false
  }

  /**
   * Reference-app-style ensureReaderReady (HANDOFF Part 8 #4): verify the reader is
   * initialized and re-init lazily if not. the reference wrapper does this on every
   * `startInventoryTag` call — that's why a Count screen re-entry works for them
   * and fails for us. Returns true if the reader is ready to start inventory.
   */
  private fun ensureReaderReady(): Boolean {
    synchronized(uhfLock) {
      if (uhfInitialized && uhfReader != null) return true
    }
    Log.d(TAG, "ensureReaderReady: reader not initialized, attempting recovery")
    // Run the same retry-with-kill cycle as acquireUartEarly. Idempotent.
    return acquireUartEarly()
  }

  // ── Reference-app-pattern TagThread poller ──────────────────────────────────────
  // Drain `readTagFromBuffer()` continuously while inventory is running. Critical
  // because `setInventoryCallback` doesn't fire on C72E MTK firmware. Sleeping ONLY
  // when the buffer is empty keeps tag throughput at hardware-max while keeping CPU
  // idle when no tags are present. Pattern from HANDOFF_FOR_OTHER_CLAUDE.md §3.1.

  private fun startTagPollThread() {
    if (tagPollThread?.isAlive == true) {
      Log.d(TAG, "TagThread: already running")
      return
    }
    val reader = uhfReader ?: run {
      Log.w(TAG, "TagThread: uhfReader is null — cannot start")
      return
    }
    val t = Thread({
      Log.d(TAG, "TRACE TagThread: STARTED scanning=${scanning.get()}")
      var loops = 0
      var nullReads = 0
      var hits = 0
      // Dead-air watchdog: this firmware drops into a post-singulation silence
      // after the first few tags reply (Session-1 / TagFocus-like behavior even
      // with QuerySession=0 + setTagFocus(false)). Holding the trigger does not
      // unstick it; the operator has to release and re-pull. To restore
      // hold-to-scan UX we cycle stopInventoryTag → startInventoryTag whenever
      // we see ~750 ms of consecutive null reads (≈ 38 * 20 ms = 760 ms). The
      // cycle does NOT touch setPower (which is the path that wedges this
      // chip), so it's safe to repeat indefinitely while scanning is true.
      var consecutiveNullReads = 0
      var kicks = 0
      val deadAirThreshold = 38   // 38 * 20ms ≈ 760ms of silence before a kick
      val maxKicksPerSecond = 2   // hard cap so we never thrash the UART
      var kicksWindowStart = System.currentTimeMillis()
      var kicksInWindow = 0
      try {
        while (scanning.get() && !Thread.currentThread().isInterrupted) {
          loops++
          try {
            val tag = reader.readTagFromBuffer()
            if (tag != null) {
              hits++
              consecutiveNullReads = 0
              val epc = tag.getEPC()
              if (VERBOSE_TAG_TRACE) {
                Log.d(TAG, "TRACE TagThread: HIT #$hits epc=$epc rssi=${tag.getRssi()}")
              }
              if (!epc.isNullOrBlank()) {
                val normalized = epc.trim().uppercase()
                val rssiDbm = parseRssiDbm(tag.getRssi())
                emitEpc(normalized, rssiDbm)
              }
              // No sleep — immediately fetch next buffered tag.
            } else {
              nullReads++
              consecutiveNullReads++
              if (nullReads % 100 == 0) {
                Log.d(TAG, "TRACE TagThread: $nullReads null reads, $hits hits, $loops loops")
              }
              Thread.sleep(20L)
              if (consecutiveNullReads >= deadAirThreshold && scanning.get()) {
                val nowMs = System.currentTimeMillis()
                if (nowMs - kicksWindowStart >= 1000L) {
                  kicksWindowStart = nowMs
                  kicksInWindow = 0
                }
                if (kicksInWindow < maxKicksPerSecond) {
                  kicksInWindow++
                  kicks++
                  Log.d(TAG, "TRACE TagThread: dead-air kick #$kicks (${consecutiveNullReads * 20}ms silent)")
                  runCatching { reader.stopInventory() }
                  // Brief settle so the chip's pending Q round drains before the
                  // restart — without this the next startInventoryTag often
                  // returns false on the fast path and forces a full re-init.
                  var interruptedDuringSettle = false
                  try { Thread.sleep(40L) } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                    interruptedDuringSettle = true
                  }
                  // If a stop arrived during the settle (trigger released / screen
                  // left), do NOT restart. Otherwise the kick re-arms the radio
                  // AFTER stopInventoryAsync already stopped it, and since the poll
                  // thread then exits there's nothing left to turn it off — the
                  // reader "keeps reading after the trigger is toggled off".
                  if (interruptedDuringSettle || !scanning.get() ||
                      Thread.currentThread().isInterrupted) {
                    Log.d(TAG, "TRACE TagThread: kick aborted — stop arrived during settle")
                    break
                  }
                  val restarted = runCatching { reader.startInventoryTag() }.getOrDefault(false)
                  Log.d(TAG, "TRACE TagThread: kick startInventoryTag -> $restarted")
                  consecutiveNullReads = 0
                }
              }
            }
          } catch (ie: InterruptedException) {
            Thread.currentThread().interrupt()
          } catch (e: Exception) {
            Log.w(TAG, "TRACE TagThread: loop error: ${e.message}")
            try { Thread.sleep(50L) } catch (_: InterruptedException) {
              Thread.currentThread().interrupt()
            }
          }
        }
      } finally {
        // Whatever exited the loop (interrupt, scanning=false, aborted kick),
        // if we're no longer meant to be scanning make sure the radio is
        // actually stopped — so a kick or SDK quirk can never leave it
        // transmitting after the trigger is toggled off. Safe to call twice.
        if (!scanning.get()) {
          runCatching { reader.stopInventory() }
        }
        Log.d(TAG, "TRACE TagThread: STOPPED scanning=${scanning.get()} loops=$loops hits=$hits nulls=$nullReads kicks=$kicks")
      }
    }, "CarbonChainway-TagThread").apply { isDaemon = true }
    tagPollThread = t
    t.start()
  }

  private fun stopTagPollThread() {
    val t = tagPollThread ?: return
    tagPollThread = null
    runCatching { t.interrupt() }
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

        // Skip the reflective UART path entirely on first launch. The recovery
        // app's proven sequence is just init → setPower → startInventoryTag →
        // readTagFromBuffer via RFIDWithUHFUART. Running additional reflective
        // UHFInit/UHFOpenAndConnect in parallel wedges the chip on C72E MTK
        // firmware (init=false from recovery app after our retries left chip
        // wedged). Delegate to acquireUartEarly which uses the SDK init path
        // and is synchronized via uhfLock + idempotent — two callers won't
        // race the chip. If the SDK reader is already initialized this
        // returns immediately.
        if (acquireUartEarly()) {
          Log.d(TAG, "connectAsync: SDK init via acquireUartEarly OK")
          lastError = null
          mainHandler.post { onDone(null) }
        } else {
          Log.w(TAG, "connectAsync: acquireUartEarly failed — falling back to broadcast")
          connectBroadcastOnly(onDone)
        }
      } catch (e: Throwable) {
        lastError = e.message ?: e.javaClass.simpleName
        Log.e(TAG, "connect failed: ${e.message}", e)
        mainHandler.post { onDone(e) }
      }
    }
  }

  private fun connectBroadcastOnly(onDone: (Throwable?) -> Unit) {
    Log.d(TAG, "connectBroadcastOnly ENTERED")
    // ScannerLogcatBridge polls logcat for firmware-emitted EPC lines; hardware_barcode
    // relay picks up OUTPUT_BARCODE_RFID broadcasts. Neither touches /dev/ttyMT1.
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
    Log.d(TAG, "TRACE startInventoryFlutterResult: ENTER uartOwned=$uartOwned scanning=${scanning.get()} uhfReader=${uhfReader != null} tagSinkBound=${tagSink != null}")
    Log.d("LAT", "TRIGGER_ACK ts=${System.currentTimeMillis()} stack=chainway")
    executor.execute {
      try {
        // Lazy reflective UART takeover when Dart skipped chainway.connect.
        // SKIP this entirely if the SDK reader is already initialized — calling
        // UHFInit reflectively while the SDK has the UART triggers a sequence
        // of UHFInit -> -1 errors that leave the chip half-initialized, and
        // the subsequent startInventoryTag returns true but no tags ever come
        // through readTagFromBuffer. The SDK path matches what the recovery
        // app uses, so trust it.
        if (!uartOwned && uhfReader == null && canOwnUart()) {
          val cls = uhfClass ?: resolveUhfClass()
          val inst = uhfInstance ?: cls?.let { getStaticInstance(it) }
          if (cls != null && inst != null) {
            uhfClass = cls
            uhfInstance = inst
            uartOwned = initUart(cls, inst)
            Log.d(TAG, "lazy UART takeover -> uartOwned=$uartOwned")
          } else {
            Log.w(TAG, "lazy UART takeover skipped — class/instance resolve failed")
          }
        } else if (uhfReader != null) {
          Log.d(TAG, "lazy UART takeover skipped — SDK reader already initialized")
        }

        // SDK fallback when reflective takeover declined or failed.
        // reference-app pattern (HANDOFF Part 8 #4): if the SDK reader isn't ready,
        // run the kill-and-retry cycle from acquireUartEarly. Without this, a
        // single early init failure permanently bricks the session for this
        // app instance — the user sees "trigger does nothing" on every pull.
        if (!uartOwned) {
          // Recovery-app pattern (the only proven-working path on this device):
          // engage antenna PA gate, then startInventoryTag, then poll. No
          // per-trigger kill of com.rscja.scanner — that was injecting ~400ms
          // lag plus sometimes wedged the chip antenna gate between probe and
          // start. Scanner is killed once at app launch in MainActivity which
          // gives the SDK exclusive UART; from there we trust the connection.
          //
          // If startInventoryTag returns false the chip is wedged → kill
          // scanner, free reader, re-init, retry. Rare path.
          var reader = uhfReader
          var startOk = false
          if (reader != null) {
            // Recovery-app pattern: NO setPower here. Power is set exactly
            // once in initUhfReaderDirect and stays. Calling setPower a
            // second time with the same value wedges this MTK firmware
            // variant — startInventoryTag returns true but the chip never
            // transmits (0 hits / N null reads symptom we hit at 27 dBm).
            engageAntennaPaGate()
            startOk = runCatching { reader!!.startInventoryTag() }.getOrDefault(false)
            Log.d(TAG, "RFIDWithUHFUART.startInventoryTag() -> $startOk (fast path)")
          }
          if (!startOk) {
            Log.d(TAG, "fast path failed, falling into kill+reinit recovery")
            try {
              val am = context.getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
              am.killBackgroundProcesses("com.rscja.scanner")
              am.killBackgroundProcesses("com.rscja.ht")
            } catch (_: Throwable) {}
            synchronized(uhfLock) {
              try { uhfReader?.free() } catch (_: Throwable) {}
              uhfReader = null
              uhfInitialized = false
            }
            Thread.sleep(300)
            if (initUhfReaderDirect()) {
              reader = uhfReader
              if (reader != null) {
                engageAntennaPaGate()
                startOk = runCatching { reader!!.startInventoryTag() }.getOrDefault(false)
                Log.d(TAG, "RFIDWithUHFUART.startInventoryTag() -> $startOk (recovery)")
              }
            } else {
              Log.w(TAG, "recovery re-init failed")
            }
          }
          uhfInventoryActive = startOk
          if (startOk) {
            scanning.set(true)
            // reference-app pattern: poll readTagFromBuffer() — `setInventoryCallback`
            // doesn't fire on C72E MTK firmware. The two paths coexist; dedup via
            // [seenEpcs] handles double-emission if both happen to fire.
            startTagPollThread()
            mainHandler.post { result.success(null) }
            return@execute
          }
        }
        if (uartOwned) {
          val cls = uhfClass; val inst = uhfInstance
          if (cls != null && inst != null && !scanning.getAndSet(true)) {
            applyPower()
            startDrainLoop(cls, inst)
            Log.d(TAG, "startInventory: drain loop armed (uartOwned path)")
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
    // Reference-app-pattern poller — interrupt immediately so the next read() call returns.
    stopTagPollThread()
    // Direct SDK stop — mirrors the direct start path
    if (uhfInventoryActive) {
      uhfInventoryActive = false
      val reader = uhfReader
      if (reader != null) {
        executor.execute {
          val stopOk = reader.stopInventory()
          Log.d(TAG, "RFIDWithUHFUART.stopInventory() -> $stopOk")
        }
        Log.d(TAG, "stopInventory uartOwned=$uartOwned")
        return
      }
    }
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

  // ── Tag EPC write ───────────────────────────────────────────────────────────

  /**
   * Writes [newEpc] (24 hex chars, 96 bits) onto the EPC bank of the tag whose current EPC
   * equals [targetEpc]. Runs synchronously on the controller executor. Pauses inventory
   * for the duration of the write and resumes it on exit if it was running. Returns `true`
   * only when the underlying SDK confirms success.
   */
  fun writeEpcOnce(targetEpc: String, newEpc: String, result: MethodChannel.Result) {
    val tgt = targetEpc.trim().uppercase().replace(Regex("[^0-9A-F]"), "")
    val new = newEpc.trim().uppercase().replace(Regex("[^0-9A-F]"), "")
    if (tgt.length != 24 || new.length != 24) {
      mainHandler.post { result.success(false) }
      return
    }
    executor.execute {
      val ok = runCatching { performWriteEpc(tgt, new) }.getOrElse {
        Log.w(TAG, "writeEpc error: ${it.message}", it)
        false
      }
      Log.d(TAG, "writeEpc($tgt -> $new) = $ok")
      mainHandler.post { result.success(ok) }
    }
  }

  private fun performWriteEpc(targetEpc: String, newEpc: String): Boolean {
    // Pause inventory: write + inventory share the UART/radio and collide.
    val wasScanning = scanning.get()
    if (wasScanning) {
      runCatching { uhfReader?.stopInventory() }
      // Reflective stop path used by UART-owned branch
      val cls = uhfClass; val inst = uhfInstance
      if (cls != null && inst != null && uartOwned) {
        invokeNoArgs(cls, inst, "UHFStopGet", "stopInventoryTag", "stopInventory")
      }
      scanning.set(false)
      // Let the radio settle before switching to access mode. 50ms is
      // enough on every C72E firmware I've measured; 120ms was a 2024
      // belt-and-suspenders that meaningfully dragged the per-write
      // cycle without changing the success rate.
      android.os.SystemClock.sleep(50)
    }
    try {
      // Primary path: writeData on EPC bank (bank=1, ptr=2 words = skip CRC+PC, cnt=6 words = 96-bit EPC).
      // The previous implementation tried writeDataToEpc(ptr=32, cnt=96) as the first path; on the
      // C72E SDK those args are interpreted as words, putting the pointer far past the EPC bank.
      // That call silently returned true on success-looking firmware without actually writing the
      // tag silicon — producing the "encoded=true but tag still has old EPC" bug.
      val reader = uhfReader ?: run {
        Log.w(TAG, "performWriteEpc: uhfReader is null — canOwnUart()=${canOwnUart()}; no write path available")
        return false
      }

      // Boost to MAX (23 dBm — the C72E thermal cap) for the write window
      // regardless of the slider. Writes need materially more link-budget
      // than reads — at the slider's dBm the radio could hear the tag
      // (read OK) but the tag's EEPROM charge pump couldn't gather enough
      // energy to commit, producing the "writeData=true but EPC didn't
      // change" silent failure. The slider's value is restored after the
      // post-write power cycle so subsequent inventory honours the
      // operator's setting.
      val sliderPower = requestedPowerDbm.get().coerceIn(5, 23)
      val writePower = 23  // C72E max — never exceed thermal cap
      val curPower = runCatching { reader.getPower() }.getOrDefault(-1)
      val pwrSetOk = runCatching { reader.setPower(writePower) }.getOrDefault(false)
      Log.d(TAG, "pre-write power: getPower()=$curPower slider=$sliderPower writePower=$writePower setPower=$pwrSetOk")

      var writeOk = false
      var writeBranch = "none"
      runCatching {
        writeOk = reader.writeData(ACCESS_PWD, 1, 2, 6, newEpc)
        writeBranch = "writeData(EPC bank, ptr=2, cnt=6)"
        Log.d(TAG, "$writeBranch -> $writeOk")
      }.onFailure { Log.w(TAG, "writeData threw: ${it.message}") }

      // Fallback: 2-arg writeDataToEpc if the filter-less write above didn't take.
      // Only try this if we truly failed (to avoid writing the same data twice).
      if (!writeOk) {
        runCatching {
          writeOk = reader.writeDataToEpc(ACCESS_PWD, newEpc)
          writeBranch = "writeDataToEpc(2-arg)"
          Log.d(TAG, "$writeBranch -> $writeOk")
        }.onFailure { Log.w(TAG, "writeDataToEpc(2-arg) threw: ${it.message}") }
      }

      if (!writeOk) {
        Log.d(TAG, "performWriteEpc: all write branches failed; returning false")
        return false
      }

      // Settle before the power cycle: the tag's charge pump needs a
      // moment to finish its (attempted) EEPROM write before we kill
      // RF. 80ms is enough — the Gen2 write-cycle spec is ~20ms typical
      // / 50ms worst case for EPC bank.
      android.os.SystemClock.sleep(80)

      // Power-cycle the tag. A successful writeData updates the tag's RAM response register
      // regardless of whether the EEPROM commit actually succeeded — so the tag will keep
      // broadcasting the new EPC for as long as RF keeps it awake, producing a false-positive
      // verify. Cutting RF for ~600 ms drops the tag below operating voltage; when we re-energize
      // it, the tag boots from EEPROM. If the EEPROM actually committed, it broadcasts newEpc.
      // If the write didn't commit (locked bank / insufficient write power / access-password
      // mismatch), it broadcasts the legacy oldEpc and the verifier correctly fails.
      //
      // This is the fix for the bug where Chainway reported ENCODED on a tag that Samsung
      // immediately re-scanned as the legacy C1... EPC — the write never landed on silicon,
      // but the tag's RAM kept replying with the new EPC as long as it was in Chainway's field.
      runCatching { reader.stopInventory() }
      val cwOffOk = runCatching { reader.setCW(0) }.getOrDefault(false)
      val lowPwrOk = runCatching { reader.setPower(5) }.getOrDefault(false)
      // 300ms is enough RF-off dwell for the C72E. The Gen2 spec needs
      // the tag's charge pump to bleed below operating voltage (~10ms
      // physically) — 600ms was the original 2024 conservative number
      // and was the single biggest contributor to the ~10s observed
      // per-write latency on a steady-state re-encode pass.
      Log.d(TAG, "power-cycle: stopInventory()+setCW(0)=$cwOffOk setPower(5)=$lowPwrOk; sleeping 300ms")
      android.os.SystemClock.sleep(300)
      val cwOnOk = runCatching { reader.setCW(1) }.getOrDefault(false)
      // Restore the operator's slider power (NOT the boosted writePower).
      // After encode the radio returns to whatever the slider had before
      // the boost — verify scans the tag at that level, and any
      // subsequent inventory honours the operator's setting.
      val restoreOk = runCatching { reader.setPower(sliderPower) }.getOrDefault(false)
      Log.d(TAG, "power-cycle: setCW(1)=$cwOnOk restored to slider=$sliderPower (was boosted=$writePower)=$restoreOk; tag should have rebooted from EEPROM")

      // Verify: multi-sighting scan AFTER power cycle. A tag that genuinely committed newEpc
      // to EEPROM will broadcast newEpc repeatedly. A tag that didn't commit will broadcast
      // oldEpc — we reject in that case too (not just on zero sightings of newEpc).
      Log.d(TAG, "performWriteEpc: write branch=$writeBranch; entering verify after power cycle")
      val verified = verifyEpcWrite(reader, targetEpc, newEpc)
      if (!verified) {
        // POST-FAIL READ-BACK FALLBACK (2026-05-30)
        // ----
        // Mirror the Zebra controller's "is the OLD EPC actually gone"
        // promotion. Cause: 6 of 43 WRITE_FAILED rows from the operator's
        // 2026-05-29 re-encode session physically did write — geiger
        // confirmed the chip broadcasts the NEW EPC and the old EPC is
        // gone. The verify loop hit 0 new-EPC sightings within the
        // 1500ms window even though the chip was written. Likely causes:
        // (a) tag at edge of read range at verify-time after the
        // operator naturally moves the gun post-write,
        // (b) tag still in its post-power-cycle re-boot when verify
        // started polling (Chainway antennas sometimes need >300ms),
        // (c) buffer drain stole the few new-EPC reads we did get.
        //
        // The diagnostic readData(EPC bank) was always logged but never
        // acted on; promote when the read-back matches newEpc.
        var rescueEpc: String? = null
        runCatching {
          val pc = reader.readData(ACCESS_PWD, 1, 0, 1)  // bank=EPC, ptr=0 words, cnt=1 word = CRC
          Log.d(TAG, "post-fail diag: readData(EPC bank, ptr=0, cnt=1 CRC) -> $pc")
        }.onFailure { Log.w(TAG, "post-fail diag: EPC CRC read threw: ${it.message}") }
        runCatching {
          val epcReadBack = reader.readData(ACCESS_PWD, 1, 2, 6)  // bank=EPC, ptr=2, cnt=6 = 96-bit EPC
          rescueEpc = epcReadBack?.replace("\\s".toRegex(), "")?.uppercase()
          Log.d(TAG, "post-fail diag: readData(EPC bank, ptr=2, cnt=6 EPC) -> '$epcReadBack' (expected new=$newEpc, else old=$targetEpc)")
        }.onFailure { Log.w(TAG, "post-fail diag: EPC read threw: ${it.message}") }
        runCatching {
          val reserved = reader.readData(ACCESS_PWD, 0, 0, 4)  // bank=RESERVED, ptr=0, cnt=4 = kill+access pw
          Log.d(TAG, "post-fail diag: readData(RESERVED bank, kill+access pw) -> '$reserved' (if read-locked, write likely write-locked too)")
        }.onFailure { Log.w(TAG, "post-fail diag: RESERVED read threw (likely read-locked): ${it.message}") }
        // Promote when the read-back matches the new EPC. We accept
        // both equality and `startsWith` because some Chainway SDK
        // builds return a few extra trailing bytes from the bank.
        val newNorm = newEpc.uppercase()
        if (rescueEpc != null && (rescueEpc == newNorm || rescueEpc!!.startsWith(newNorm))) {
          Log.d(TAG, "performWriteEpc: verify returned false but read-back EPC '$rescueEpc' matches newEpc — promoting to true (verify false-negative, chip wrote OK)")
          return true
        }
      }
      return verified
    } finally {
      // Resume inventory if we paused it.
      if (wasScanning) {
        scanning.set(true)
        val reader = uhfReader
        if (reader != null) {
          runCatching { reader.startInventoryTag() }
        } else {
          val cls = uhfClass; val inst = uhfInstance
          if (cls != null && inst != null && uartOwned) {
            startDrainLoop(cls, inst)
          }
        }
      } else {
        // We were NOT inventorying before this write (e.g. the Encode screen
        // stops scanning before writing). The power-cycle above turned the CW
        // carrier back ON (setCW(1)) and verify ran its own inventory, so the
        // radio can be left transmitting. Because `scanning` is false, the
        // caller's stopInventory() early-returns and can never quiet it —
        // the reader stays "stuck on" until the app is force-restarted.
        // Force the radio to a clean OFF state so the caller owns it cleanly.
        val reader = uhfReader
        if (reader != null) {
          runCatching { reader.stopInventory() }
          runCatching { reader.setCW(0) }
        } else {
          val cls = uhfClass; val inst = uhfInstance
          if (cls != null && inst != null && uartOwned) {
            invokeNoArgs(cls, inst, "UHFStopGet", "stopInventoryTag", "stopInventory")
          }
        }
        uhfInventoryActive = false
        scanning.set(false)
        stopTagPollThread()
      }
    }
  }

  // ── Write verification ──────────────────────────────────────────────────────

  /**
   * After a write that returned `true`, briefly scan and confirm the tag silicon actually
   * committed the new EPC. Requires [minNewSightings] separate sightings of [newEpc] within
   * [timeoutMs] — not a single sighting, which is vulnerable to the UHF Gen2 ghost-response
   * failure mode (tag's write-buffer echoes the new EPC briefly before the silicon reverts to
   * the old value when the charge pump fails to commit).
   *
   * A genuinely committed tag in the antenna field will produce dozens to hundreds of matching
   * reads per second; a ghost response produces at most one or two. Threshold 3 discriminates
   * cleanly between the two while tolerating tags on the edge of the read range.
   *
   * This is the fix for the "encoded=true but tag still has legacy C1... EPC on Samsung
   * re-scan" bug — the single-sighting latch was flipping on the ghost echo.
   */
  /// minNewSightings was dropped from 3 → 1 on 2026-05-29 to match the
  /// Zebra controller (which was tightened in 1.2.94 because the
  /// 3-sighting threshold false-failed in marginal fields — operator
  /// watched the tag get written, Samsung re-read confirmed the new
  /// EPC, but verify timed out waiting for sighting #3 and reported
  /// writeFailed). The `oldSightings == 0` guard still catches the
  /// ghost-echo failure mode that justified the original threshold.
  /// timeoutMs lowered from 3000 → 1500: success exits on the first
  /// matching sighting (~50-150ms in a touching scenario); the
  /// timeout only governs the failure path.
  private fun verifyEpcWrite(
    reader: RFIDWithUHFUART,
    oldEpc: String,
    newEpc: String,
    timeoutMs: Long = 1500,
    minNewSightings: Int = 1,
  ): Boolean {
    val oldSightings = java.util.concurrent.atomic.AtomicInteger(0)
    val newSightings = java.util.concurrent.atomic.AtomicInteger(0)
    val otherSightings = java.util.concurrent.atomic.AtomicInteger(0)
    val verifyCallback = object : IUHFInventoryCallback {
      override fun callback(tagInfo: UHFTAGInfo) {
        val epc = tagInfo.getEPC()?.trim()?.uppercase() ?: return
        when (epc) {
          oldEpc -> {
            val n = oldSightings.incrementAndGet()
            if (n <= 3 || n % 10 == 0) Log.d(TAG, "verify sighted OLD $epc (count=$n)")
          }
          newEpc -> {
            val n = newSightings.incrementAndGet()
            if (n <= 5 || n % 10 == 0) Log.d(TAG, "verify sighted NEW $epc (count=$n)")
          }
          else -> {
            val n = otherSightings.incrementAndGet()
            if (n <= 3) Log.d(TAG, "verify sighted OTHER $epc (count=$n)")
          }
        }
      }
    }
    runCatching { reader.setInventoryCallback(verifyCallback) }
    val deadline = android.os.SystemClock.elapsedRealtime() + timeoutMs
    try {
      val startOk = runCatching { reader.startInventoryTag() }.getOrDefault(false)
      Log.d(TAG, "verifyEpcWrite: startInventoryTag()=$startOk timeout=${timeoutMs}ms threshold=$minNewSightings")
      while (android.os.SystemClock.elapsedRealtime() < deadline &&
             newSightings.get() < minNewSightings) {
        Thread.sleep(50)
      }
    } finally {
      runCatching { reader.stopInventory() }
      // Restore the app's normal inventory callback so regular scanning resumes.
      // We don't have a reference to the original callback, so rebuild the standard one.
      runCatching {
        reader.setInventoryCallback(object : IUHFInventoryCallback {
          override fun callback(tagInfo: UHFTAGInfo) {
            val epc = tagInfo.getEPC()
            if (epc.isNullOrBlank()) return
            val normalized = epc.trim().uppercase()
            emitEpc(normalized, parseRssiDbm(tagInfo.getRssi()))
          }
        })
      }
    }
    val nNew = newSightings.get()
    val nOld = oldSightings.get()
    val nOther = otherSightings.get()
    // Post-power-cycle, a single sighting of oldEpc means the tag booted from EEPROM and
    // is still broadcasting the legacy value — the write did not commit to silicon, regardless
    // of how many times we sighted newEpc (those sightings would be stale RAM from before the
    // cycle, or buffered SDK queue). Fail hard in that case.
    val verified = nNew >= minNewSightings && nOld == 0
    Log.d(TAG, "verifyEpcWrite: old=$oldEpc new=$newEpc newSightings=$nNew oldSightings=$nOld otherSightings=$nOther threshold=$minNewSightings requireOldZero=true -> $verified")
    return verified
  }

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

  private fun canOwnUart(): Boolean = true

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
        if (r >= 0) {
          Log.d(TAG, "UART takeover complete via UHFOpenAndConnect")
          logChipDiagnostics(cls, inst)
          return true
        }
      }
      // All paths failed — release via UHFFree only (UHFCloseAndDisconnect is called internally).
      // Double-closing causes inconsistent kernel port state on some Chainway firmware.
      Log.w(TAG, "UHFOpenAndConnect failed all paths — releasing via UHFFree")
      invokeNoArgs(cls, inst, "UHFFree")
      System.gc()
      Thread.sleep(50)
      return false
    }

    Log.d(TAG, "UHFOpenAndConnect not found — UHFInit-only path OK")
    logChipDiagnostics(cls, inst)
    return true
  }

  /**
   * One-shot dump of the chip's actual reported state right after UART acquisition.
   * Used to distinguish "chip is healthy + RF active but no tag in field"
   * from "chip is misconfigured (wrong frequency / power=0 / hardware fault)".
   */
  private fun logChipDiagnostics(cls: Class<*>, inst: Any) {
    runCatching {
      val m = cls.methods.firstOrNull { it.name == "UHFGetHwType" && it.parameterCount == 0 }
      m?.isAccessible = true
      val raw = m?.invoke(inst)
      val hex = when (raw) {
        is CharArray -> raw.map { "%02X".format(it.code and 0xFF) }.joinToString("")
        is ByteArray -> raw.joinToString("") { "%02X".format(it.toInt() and 0xFF) }
        else -> raw?.toString() ?: "<null>"
      }
      Log.d(TAG, "DIAG UHFGetHwType -> $hex")
    }.onFailure { Log.w(TAG, "DIAG UHFGetHwType failed: ${it.message}") }

    runCatching {
      val m = cls.methods.firstOrNull { it.name == "UHFGetFrequency_Ex" && it.parameterCount == 0 }
        ?: cls.methods.firstOrNull { it.name == "UHFGetFrequency" && it.parameterCount == 0 }
      m?.isAccessible = true
      val raw = m?.invoke(inst)
      val hex = when (raw) {
        is CharArray -> raw.map { "%02X".format(it.code and 0xFF) }.joinToString("")
        is ByteArray -> raw.joinToString("") { "%02X".format(it.toInt() and 0xFF) }
        else -> raw?.toString() ?: "<null>"
      }
      Log.d(TAG, "DIAG UHFGetFrequency -> $hex")
    }.onFailure { Log.w(TAG, "DIAG UHFGetFrequency failed: ${it.message}") }

    runCatching {
      val m = cls.methods.firstOrNull { it.name == "UHFGetPower" && it.parameterCount == 0 }
      m?.isAccessible = true
      val raw = m?.invoke(inst)
      val hex = when (raw) {
        is CharArray -> raw.map { "%02X".format(it.code and 0xFF) }.joinToString("")
        is ByteArray -> raw.joinToString("") { "%02X".format(it.toInt() and 0xFF) }
        else -> raw?.toString() ?: "<null>"
      }
      Log.d(TAG, "DIAG UHFGetPower -> $hex")
    }.onFailure { Log.w(TAG, "DIAG UHFGetPower failed: ${it.message}") }
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
    val p = requestedPowerDbm.get().coerceIn(5, 23)
    val m = cls.methods.firstOrNull { it.name in setOf("UHFSetPower", "setPower", "SetPower", "setOutputPower") && it.parameterCount == 1 }
      ?.also { it.isAccessible = true } ?: return
    val arg: Any = if (m.parameterTypes[0] == java.lang.Character.TYPE) java.lang.Character(p.toChar()) else java.lang.Integer(p)
    runCatching { m.invoke(inst, arg) }
    Log.d(TAG, "${m.name}($p) applied")
  }

  /**
   * Phase 1 — apply the chip config that the working device dump (HC720A210300240
   * / HH-574) reports while the reference app is running. Without these the chip
   * accepts inventory but never transmits — same symptom as 1.2.7's "0 hits"
   * trace. Called right after a successful reflective UART takeover.
   *
   *   getFrequencyMode() = 8
   *   getRFLink()        = 1
   *   getProtocol()      = -1   ← never set (skip)
   *   getPower()         = 30   ← applied separately via applyPower()
   *
   * EPC-only inventory mode (UHFSetMode(0)) matches the SDK call setEPCMode().
   */
  private fun applyChipConfigReflective(cls: Class<*>, inst: Any) {
    fun callChar(name: String, value: Int) {
      val m = cls.methods.firstOrNull { it.name == name && it.parameterCount == 1 } ?: run {
        Log.d(TAG, "applyChipConfigReflective: $name not found"); return
      }
      m.isAccessible = true
      val arg: Any = if (m.parameterTypes[0] == java.lang.Character.TYPE) java.lang.Character(value.toChar()) else java.lang.Integer(value)
      val r = runCatching { (m.invoke(inst, arg) as? Number)?.toInt() ?: -1 }.getOrDefault(-2)
      Log.d(TAG, "applyChipConfigReflective: $name($value) -> $r")
    }
    callChar("UHFSetFrequency_EX", 8)   // matches working device dump
    callChar("UHFSetMode", 0)           // EPC-only inventory frames
    callChar("UHFSetRFLink", 1)         // matches working device dump
    // setProtocol intentionally skipped — working dump reports getProtocol()=-1 (unset)
    applyPower()                         // UHFSetPower(30) by default
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
    stopTagPollThread()
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
    // Clean up direct SDK reader
    synchronized(uhfLock) {
      val reader = uhfReader
      if (reader != null) {
        runCatching { reader.stopInventory() }
        runCatching { reader.free() }
        Log.d(TAG, "RFIDWithUHFUART freed")
      }
      uhfReader = null
      uhfInitialized = false
      uhfInventoryActive = false
    }
    // seenEpcs intentionally NOT cleared — dedup persists across start/stop cycles
  }

  private fun emitEpc(hex: String, rssiRaw: Int?) {
    val up = hex.uppercase().replace(Regex("[^0-9A-F]"), "")
    if (up.isEmpty()) {
      if (VERBOSE_TAG_TRACE) Log.d(TAG, "TRACE emitEpc: input empty after normalize ('$hex')")
      return
    }
    // Same guard as the Zebra controller: only a plausible negative dBm counts
    // as a real reading. 0 is not "very strong", it's "the SDK had nothing".
    val rssi = rssiRaw?.takeIf { it < 0 && it > -110 }
    // Hot path — one call per tag read, which is hundreds per second during a
    // geiger sweep. Logging here cost real frame time and fed the logcat
    // bridge's regex scanner; keep it behind a flag for field diagnosis.
    if (VERBOSE_TAG_TRACE) {
      Log.d(TAG, "TRACE emitEpc: ENTER epc=$up rssi=$rssi sinkBound=${tagSink != null}")
    }
    ScanSoundPool.shared?.playTagBeep(normalizeRssi(rssi))
    val sink = tagSink ?: run {
      Log.w(TAG, "TRACE emitEpc: tagSink is NULL — Dart never subscribed to rfid_tag_stream OR setTagSink(null) was called")
      return
    }
    // CRITICAL: send rssi=null (not 0) when the SDK couldn't parse RSSI.
    // The Locate-Tag screen treats rssi=0 as a valid -0 dBm reading, which
    // its rssiToProximity01 formula clamps to 100%, pinning the proximity
    // bar at full regardless of distance. Passing null through lets the
    // Dart-side fallback (fallbackRssiOnNull = -65) compute a sensible
    // mid-range proximity until a real RSSI lands.
    val payload: Map<String, Any?> = if (rssi != null) {
      mapOf("epc" to up, "rssi" to rssi)
    } else {
      mapOf("epc" to up, "rssi" to null)
    }
    mainHandler.post {
      try {
        sink.success(payload)
        if (VERBOSE_TAG_TRACE) {
          Log.d(TAG, "TRACE emitEpc: SINK POSTED epc=$up rssi=${rssi ?: "null"}")
        }
      } catch (e: Throwable) {
        Log.w(TAG, "TRACE emitEpc: sink.success threw: ${e.message}")
      }
    }
  }

  /**
   * Parses the RSSI string returned by [UHFTAGInfo.getRssi] into signed dBm.
   *
   * Observed wire formats on this SDK (DeviceAPI_ver20251103):
   *   - "-72.80"  — signed decimal dBm (most common on C72E)
   *   - "-65"     — signed integer dBm
   *   - "72"      — unsigned magnitude (rare; some firmwares drop the sign)
   *
   * We accept any of them: toDouble handles both decimal and integer forms;
   * if the parsed value is positive (unsigned magnitude), we negate it so
   * callers always receive a negative dBm value in the -90..-30 range.
   * Returns null for "", null, or unparseable strings (callers treat as
   * "no RSSI" — beep falls back to mid-range default).
   */
  private fun parseRssiDbm(raw: String?): Int? {
    if (raw.isNullOrBlank()) return null
    val v = raw.trim().toDoubleOrNull() ?: return null
    // Signed or unsigned magnitude → always return as negative dBm.
    val dbm = if (v > 0.0) -v else v
    return dbm.toInt()
  }

  /** dBm → 0–100 normalized scale. Matches W4.3 geiger spec so UI and audio agree. */
  private fun normalizeRssi(dbm: Int?): Int {
    if (dbm == null || dbm == 0) return 60  // no-rssi default keeps beep audible
    // rssi_dbm >= -40 → 100, rssi_dbm <= -90 → 0, linear between
    val clamped = dbm.coerceIn(-90, -40)
    return ((clamped + 90) * 2).coerceIn(0, 100)
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

  fun isReady(): Boolean = uhfReader != null || (uhfInstance != null && uartOwned)

  /**
   * Achievable power range in integer dBm for the Chainway C72E radio.
   * Matches the clamp in [setAntennaPowerDbm] above (5..23) — the chip's
   * firmware silently rejects anything outside this window. Used by the
   * status-change slider so the operator can't drag to a value the radio
   * can't honour. Returns null when the radio isn't initialised.
   */
  fun getPowerRangeDbm(): Pair<Int, Int>? {
    if (!isReady()) return null
    return 5 to 23
  }

  companion object {
    private const val TAG = "CarbonChainway"
    private const val FUNCTION_UHF = 11
    private const val ACCESS_PWD = "00000000"

    /**
     * Per-tag-read logging. Flip to true only while diagnosing a "no reads
     * reach Dart" report. Leave false in shipped builds: these lines fire once
     * per read (hundreds/sec on a geiger sweep) and directly cost frame time.
     */
    private const val VERBOSE_TAG_TRACE = false

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
