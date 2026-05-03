package com.shopcarbon.wms

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.zebra.rfid.api3.ENUM_TRANSPORT
import com.zebra.rfid.api3.ENUM_TRIGGER_MODE
import com.zebra.rfid.api3.HANDHELD_TRIGGER_EVENT_TYPE
import com.zebra.rfid.api3.INVENTORY_STATE
import com.zebra.rfid.api3.InvalidUsageException
import com.zebra.rfid.api3.OperationFailureException
import com.zebra.rfid.api3.RFIDReader
import com.zebra.rfid.api3.ReaderDevice
import com.zebra.rfid.api3.Readers
import com.zebra.rfid.api3.RfidEventsListener
import com.zebra.rfid.api3.RfidReadEvents
import com.zebra.rfid.api3.RfidStatusEvents
import com.zebra.rfid.api3.SESSION
import com.zebra.rfid.api3.SL_FLAG
import com.zebra.rfid.api3.START_TRIGGER_TYPE
import com.zebra.rfid.api3.STATUS_EVENT_TYPE
import com.zebra.rfid.api3.STOP_TRIGGER_TYPE
import com.zebra.rfid.api3.TagData
import com.zebra.rfid.api3.TriggerInfo
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.abs

/**
 * Zebra RFID API3: prefers Bluetooth, then USB service transport.
 * Streams `{"epc","rssi"}` on the Flutter [EventChannel] sink.
 */
class CarbonZebraRfidController(
  private val context: Context,
) : Readers.RFIDReaderEventHandler {
  private val executor = Executors.newSingleThreadExecutor()
  private val mainHandler = Handler(Looper.getMainLooper())

  @Volatile private var tagSink: EventChannel.EventSink? = null
  @Volatile private var triggerSink: EventChannel.EventSink? = null
  @Volatile private var readerNameHint: String? = null
  @Volatile private var barcodeRelay: CarbonHardwareBarcodeRelay? = null
  @Volatile private var barcodeListenerRegistered: Boolean = false
  @Volatile private var barcodeWatcher: Any? = null
  @Volatile private var barcodeScanner: Any? = null

  /** Requested output power in dBm (0–30), forwarded to the reader’s transmit power table. */
  private val requestedPowerDbm = AtomicInteger(30)

  private var readers: Readers? = null
  private var readersAttached: Boolean = false
  private var reader: RFIDReader? = null
  private var eventHandler: RfidEventsListener? = null
  @Volatile private var lastError: String? = null
  // True between startInventory success and stop intent. Read callback drops events
  // while this is false so tags that arrive after the user pressed Stop don't trickle
  // into the UI (SDK buffer on RFD8500 sometimes flushes for ~1s post-stop).
  @Volatile private var inventoryActive: Boolean = false

  fun getLastError(): String? = lastError

  fun setTagSink(sink: EventChannel.EventSink?) {
    tagSink = sink
  }

  fun setTriggerSink(sink: EventChannel.EventSink?) {
    triggerSink = sink
  }

  fun setReaderNameHint(name: String?) {
    readerNameHint = name?.trim()?.takeIf { it.isNotEmpty() }
  }

  fun setBarcodeRelay(relay: CarbonHardwareBarcodeRelay?) {
    barcodeRelay = relay
  }

  /**
   * Flip the RFD8500 trigger to fire the 2D imager instead of UHF. While in this mode,
   * trigger pulls do NOT produce RFID tag events; barcode scans flow either via the
   * Zebra Scanner Control SDK (registered below) or via HID-keyboard emulation if the
   * sled was paired in keyboard mode (in which case the offstage TextField on
   * Bin Assign captures them — that path is unchanged by this method).
   *
   * Idempotent. No-ops when the reader is not connected.
   */
  fun setTriggerModeBarcode() {
    executor.execute {
      val r = reader ?: run {
        Log.w(TAG, "setTriggerModeBarcode: reader is null (Zebra not connected)")
        return@execute
      }
      if (!r.isConnected) {
        Log.w(TAG, "setTriggerModeBarcode: reader.isConnected=false (RFD8500 link dropped)")
        return@execute
      }
      try {
        // Stop any in-flight UHF inventory before switching: leaving inventory running
        // while the trigger flips to BARCODE wedges the SDK's read state on some
        // firmware builds (it never emits the EndOfInventory status notification, so
        // the next RFID_MODE switch sees stale state and rejects subsequent perform()).
        try { r.Actions.Inventory.stop() } catch (_: Exception) { /* not running, fine */ }
        inventoryActive = false
        // setTriggerMode returns a boolean: true means the firmware acknowledged the
        // change. On some RFD8500 firmware revisions the call returns true but does
        // NOT physically re-route the trigger — switchMode() is the hardware-level
        // fallback that toggles the radio↔imager routing on the device itself.
        val accepted = try {
          r.Config.setTriggerMode(ENUM_TRIGGER_MODE.BARCODE_MODE, true)
        } catch (e: Exception) {
          Log.w(TAG, "setTriggerMode(BARCODE_MODE) threw: ${e.message}")
          false
        }
        Log.d(TAG, "setTriggerMode(BARCODE_MODE) returned=$accepted")
        if (!accepted) {
          // Fallback: call the hardware-level toggle. switchMode is unconditional;
          // if the trigger was already in BARCODE this would put it back to RFID,
          // so we only call it when setTriggerMode rejected the change.
          try {
            r.switchMode()
            Log.d(TAG, "switchMode() invoked as BARCODE fallback")
          } catch (e: Exception) {
            Log.w(TAG, "switchMode() fallback threw: ${e.message}")
          }
        }
        ensureBarcodeListenerRegistered()
      } catch (e: Exception) {
        Log.w(TAG, "setTriggerModeBarcode failed: ${e.message}")
        lastError = e.message ?: e.javaClass.simpleName
      }
    }
  }

  fun setTriggerModeRfid() {
    executor.execute {
      // CRITICAL: tear down the BarcodeScanner SSI session FIRST, before
      // touching API3's setTriggerMode. Once CoreScanner has an active
      // scanner.connect(), it claims trigger routing on the RFD8500 itself
      // and API3's setTriggerMode(RFID_MODE) is silently overridden — the
      // trigger continues firing the 2D laser even though API3 says it's
      // back in RFID mode. Disconnecting the BarcodeScanner releases SSI's
      // claim and lets API3 take the trigger back.
      val bs = barcodeScanner
      if (bs != null) {
        try {
          bs.javaClass.getMethod("disconnect").invoke(bs)
          Log.d(TAG, "setTriggerModeRfid: BarcodeScanner.disconnect() OK")
        } catch (e: Exception) {
          Log.w(TAG, "setTriggerModeRfid: BarcodeScanner.disconnect threw: ${e.message}")
        }
        barcodeScanner = null
        // Allow re-connection on the next setTriggerModeBarcode() call.
        barcodeListenerRegistered = false
      }

      val r = reader ?: run {
        Log.w(TAG, "setTriggerModeRfid: reader is null")
        return@execute
      }
      if (!r.isConnected) {
        Log.w(TAG, "setTriggerModeRfid: reader.isConnected=false")
        return@execute
      }
      try {
        val accepted = try {
          r.Config.setTriggerMode(ENUM_TRIGGER_MODE.RFID_MODE, true)
        } catch (e: Exception) {
          Log.w(TAG, "setTriggerMode(RFID_MODE) threw: ${e.message}")
          false
        }
        Log.d(TAG, "setTriggerMode(RFID_MODE) returned=$accepted")
        if (!accepted) {
          try {
            r.switchMode()
            Log.d(TAG, "switchMode() invoked as RFID fallback")
          } catch (e: Exception) {
            Log.w(TAG, "switchMode() fallback threw: ${e.message}")
          }
        }
      } catch (e: Exception) {
        Log.w(TAG, "setTriggerModeRfid failed: ${e.message}")
        lastError = e.message ?: e.javaClass.simpleName
      }
    }
  }

  /**
   * Wires the bundled Zebra Barcode Scanner SDK end-to-end so RFD8500 imager
   * decodes flow into our hardware-barcode EventChannel.
   *
   * Why this is non-trivial: the API3 AAR bundles a SECOND SDK
   * (`com.zebra.barcode.sdk`) that sits on top of CoreScanner
   * (`com.zebra.scannercontrol`). Just registering a [BarcodeDataListener] on
   * the legacy event handler is a no-op — the events only fire if a
   * [BarcodeScanner] instance has been `connect()`ed, which is what
   * initialises CoreScanner internally. The earlier "spike" version of this
   * method registered the listener without ever connecting, so decoded
   * barcodes had no path back to Dart.
   *
   * Sequence:
   *   1. `BarcodeScannerSdk.setContext(applicationCtx)`
   *   2. Build a [BarcodeScannerWatcher] (BLUETOOTH) and add an events
   *      listener — this fires `onScannerAppeared` / `onScannerConnected`
   *      whenever a BT scanner is paired or comes into range.
   *   3. Enumerate already-paired scanners via the management services
   *      factory; if our RFD8500 is already paired we connect immediately.
   *   4. On every appear/connect event we call [connectBarcodeScanner], which
   *      registers a [BarcodeDataListener] AND calls `scanner.connect()` so
   *      the imager decode path becomes live.
   *
   * Reflection-only: we don't import `com.zebra.barcode.sdk.*` because the
   * AAR's package surface has shifted between minor versions, and we don't
   * want the controller's connect-async path to crash on a missing class for
   * an SDK that is technically optional. Failures degrade silently to the
   * HID-keyboard-wedge path (the offstage TextField on Bin Assign).
   */
  private fun ensureBarcodeListenerRegistered() {
    if (barcodeListenerRegistered) return
    val relay = barcodeRelay ?: run {
      Log.d(TAG, "barcode SDK: no relay set, skipping")
      return
    }
    try {
      val sdkClass = Class.forName("com.zebra.barcode.sdk.BarcodeScannerSdk")
      sdkClass.getMethod("setContext", android.content.Context::class.java)
        .invoke(null, context.applicationContext)

      val typeClass = Class.forName("com.zebra.barcode.sdk.BarcodeScannerType")
      val bluetoothType = typeClass.getField("BLUETOOTH").get(null)

      // Why no watcher: 1.2.28 registered both a watcher AND called
      // BarcodeScannerManager.getScanners(). The watcher's auto-fired
      // onScannerAppeared (running on the SDK's own thread) raced with our
      // getScanners iteration, both touching the same HashMap inside
      // SDKHandler -> ConcurrentModificationException. 1.2.29 dropped the
      // enumerate hoping the watcher alone would fire — it doesn't (proven
      // by 47s of silence in logcat). The RFD8500 is already paired before
      // the app launches, so a one-shot enumerate is the correct path; new
      // scanners appearing mid-session is not a flow we need to support.
      val mgmtFactory = sdkClass.getMethod("getBarcodeScannerManagementServicesFactory")
        .invoke(null)
      val mgmt = mgmtFactory.javaClass.getMethod("createBarcodeScannerManager", typeClass)
        .invoke(mgmtFactory, bluetoothType)
      Log.d(TAG, "barcode SDK: enumerating paired BT scanners via manager")
      val scanners = mgmt.javaClass.getMethod("getScanners").invoke(mgmt) as? java.util.ArrayList<*>
      Log.d(TAG, "barcode SDK: enumerate found=${scanners?.size ?: 0} scanner(s)")
      // Critical filter: BarcodeScannerManager.getScanners() returns EVERY
      // paired Bluetooth device, not just barcode-capable ones. On the user's
      // Samsung S25 it returned the Galaxy Watch7 alongside the RFD8500. The
      // first watch.connect() "succeeded" (CoreScanner accepts any BT device
      // that respond to its handshake), then claimed ownership of the trigger
      // routing — and Count screen suddenly fired the 2D laser instead of UHF.
      // Only attempt connect on devices whose name starts with "RFD" — that
      // covers RFD8500/RFD9000/RFD2000 etc. Anything else (watches, phones,
      // headphones, generic BT keyboards) is filtered out.
      if (!scanners.isNullOrEmpty()) {
        for (info in scanners) {
          if (info == null) continue
          val (name, _) = runCatching {
            val n = info.javaClass.getMethod("getName").invoke(info)?.toString().orEmpty()
            val h = info.javaClass.getMethod("getHardwareId").invoke(info)?.toString().orEmpty()
            Log.d(TAG, "barcode SDK: enumerated name='$n' hwId='$h'")
            n to h
          }.getOrDefault("" to "")
          if (!name.uppercase().startsWith("RFD")) {
            Log.d(TAG, "barcode SDK: skipping non-RFD device '$name'")
            continue
          }
          connectBarcodeScanner(info, relay)
        }
      }

      barcodeListenerRegistered = true
      Log.d(TAG, "barcode SDK: enumerate complete (RFD-only filter applied)")
    } catch (e: Throwable) {
      // Reflection wraps every method exception in InvocationTargetException.
      // Unwrap so the log shows the real CoreScanner/SDK error class, not the
      // generic "InvocationTargetException: null" placeholder.
      val root = unwrap(e)
      Log.w(
        TAG,
        "barcode SDK init failed (${root.javaClass.name}: ${root.message}); " +
          "falling back to HID-keyboard wedge for Bin Assign decodes",
        root,
      )
    }
  }

  private fun unwrap(t: Throwable): Throwable {
    var cur: Throwable = t
    var depth = 0
    while (depth < 6) {
      val cause = (cur as? java.lang.reflect.InvocationTargetException)?.targetException
        ?: cur.cause
        ?: break
      if (cause === cur) break
      cur = cause
      depth++
    }
    return cur
  }

  /**
   * Builds a [BarcodeScanner] for [info], registers the data listener that
   * forwards decodes to our [CarbonHardwareBarcodeRelay], then connects the
   * scanner so the imager pipeline goes live. Idempotent — if we already hold
   * a connected scanner we skip.
   */
  private fun connectBarcodeScanner(info: Any, relay: CarbonHardwareBarcodeRelay) {
    if (barcodeScanner != null) {
      Log.d(TAG, "barcode SDK: scanner already connected, skipping new info")
      return
    }
    try {
      val sdkClass = Class.forName("com.zebra.barcode.sdk.BarcodeScannerSdk")
      val factory = sdkClass.getMethod("getBarcodeScannerFactory").invoke(null)
      val infoIfClass = Class.forName("com.zebra.barcode.sdk.BarcodeScannerInfo")
      val scanner = factory.javaClass.getMethod("create", infoIfClass)
        .invoke(factory, info)

      // Data listener: every decode comes through here. Trim trailing nulls /
      // CR/LF from SSI byte payloads so the Dart side gets a clean string.
      val listenerClass = Class.forName("com.zebra.barcode.sdk.BarcodeDataListener")
      val listener = java.lang.reflect.Proxy.newProxyInstance(
        listenerClass.classLoader,
        arrayOf(listenerClass),
      ) { _, method, args ->
        if (method.name == "onBarcodeDataReceived" && args != null && args.isNotEmpty()) {
          runCatching {
            val ev = args[0]
            val bytes = ev.javaClass.getMethod("getBarcodeData").invoke(ev) as? ByteArray
            if (bytes != null && bytes.isNotEmpty()) {
              val raw = String(bytes, java.nio.charset.StandardCharsets.UTF_8)
              val cleaned = raw.trimEnd(' ', '\r', '\n', ' ')
              Log.d(TAG, "barcode SDK: decode bytes=${bytes.size} value='$cleaned'")
              relay.emitExternal(cleaned)
            }
          }.onFailure {
            Log.w(TAG, "barcode SDK: decode parse failed: ${it.message}")
          }
        }
        null
      }
      scanner.javaClass.getMethod("addBarcodeDataListener", listenerClass)
        .invoke(scanner, listener)

      // connect() is the load-bearing step — it boots CoreScanner internally
      // and enables the dcssdkEventBarcode path that fires our listener.
      scanner.javaClass.getMethod("connect").invoke(scanner)
      barcodeScanner = scanner
      Log.d(TAG, "barcode SDK: scanner.connect() succeeded; imager decodes now live")
    } catch (e: Throwable) {
      val root = unwrap(e)
      Log.w(
        TAG,
        "barcode SDK: connectBarcodeScanner failed (${root.javaClass.name}: ${root.message})",
        root,
      )
    }
  }

  fun connectAsync(onDone: (Throwable?) -> Unit) {
    executor.execute {
      try {
        Log.d(TAG, "connectAsync: begin")
        disconnectSync()
        openReaders()
        val r = pickReader() ?: error("No Zebra RFID reader found. Pair an RFD8500 (Bluetooth) or connect USB.")
        reader = r
        Log.d(TAG, "connectAsync: picked reader, connecting")
        connectAndConfigureReader()
        lastError = null
        Log.d(TAG, "connectAsync: connected and configured")
        mainHandler.post { onDone(null) }
      } catch (e: Throwable) {
        Log.e(TAG, "connectAsync: failed", e)
        lastError = e.message ?: e.javaClass.simpleName
        // Unconditional full teardown + 500ms settle gives the BT stack time to
        // release the SPP socket before Flutter can call back. Without the
        // settle, a fast retry inherits the half-open socket and hangs.
        disconnectSync()
        try { Thread.sleep(500) } catch (_: InterruptedException) { /* ignore */ }
        mainHandler.post { onDone(e) }
      }
    }
  }

  fun disconnectAsync() {
    executor.execute { disconnectSync() }
  }

  fun setAntennaPowerDbm(dbm: Int) {
    executor.execute {
      requestedPowerDbm.set(dbm.coerceIn(0, 30))
      reader?.takeIf { it.isConnected }?.let { applyTransmitPowerDbm(it) }
    }
  }

  fun startInventoryFlutterResult(result: MethodChannel.Result) {
    Log.d("LAT", "TRIGGER_ACK ts=${System.currentTimeMillis()} stack=zebra")
    executor.execute {
      try {
        val r = reader
        if (r == null || !r.isConnected) {
          mainHandler.post { result.error("NOT_CONNECTED", "Zebra reader not connected", null) }
          return@execute
        }
        applyTransmitPowerDbm(r)
        r.Actions.Inventory.perform()
        inventoryActive = true
        mainHandler.post { result.success(null) }
      } catch (e: InvalidUsageException) {
        lastError = e.message ?: e.javaClass.simpleName
        mainHandler.post { result.error("INVENTORY_FAILED", e.message ?: "perform failed", null) }
      } catch (e: OperationFailureException) {
        lastError = e.message ?: e.javaClass.simpleName
        mainHandler.post { result.error("INVENTORY_FAILED", e.message ?: "perform failed", null) }
      }
    }
  }

  fun stopInventoryAsync() {
    // Set the gate flag FIRST, inline, so late reads from the SDK buffer are dropped
    // immediately. The actual SDK .stop() call runs on the executor as before but no
    // longer needs to win the race against in-flight tag-read callbacks.
    inventoryActive = false
    executor.execute {
      try {
        reader?.takeIf { it.isConnected }?.Actions?.Inventory?.stop()
      } catch (_: Exception) {
        /* ignore */
      }
    }
  }

  fun dispose() {
    executor.execute { disconnectSync() }
  }

  /**
   * Overwrites the EPC bank on the tag whose current ID matches [targetEpc] with [newEpc].
   * [targetEpc] acts as the SELECT filter; [newEpc] is 24 hex chars (96 bits). Pauses any
   * running inventory for the duration of the operation and resumes it on exit.
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
        lastError = it.message ?: it.javaClass.simpleName
        false
      }
      mainHandler.post { result.success(ok) }
    }
  }

  fun isReady(): Boolean = reader?.isConnected == true

  private fun performWriteEpc(targetEpc: String, newEpc: String): Boolean {
    val r = reader ?: return false
    if (!r.isConnected) return false

    // Pause inventory for the access sequence; resume on exit.
    val wasRunning = try {
      r.Actions.Inventory.stop(); true
    } catch (_: Exception) {
      false
    }
    try {
      // Log pre-write transmit power so write attempts are auditable against the radio state.
      runCatching {
        val idx = r.Config.Antennas.getAntennaRfConfig(1).getTransmitPowerIndex()
        val levels = r.ReaderCapabilities.transmitPowerLevelValues
        val rawDbm = if (levels != null && idx in levels.indices) levels[idx] else -1
        Log.d(TAG, "pre-write power: antenna=1 idx=$idx rawLevel=$rawDbm (requested=${requestedPowerDbm.get()} dBm)")
      }

      val params = r.Actions.TagAccess.WriteAccessParams()
      params.accessPassword = 0L
      params.memoryBank = com.zebra.rfid.api3.MEMORY_BANK.MEMORY_BANK_EPC
      params.offset = 2                       // skip CRC (word 0) + PC (word 1)
      params.writeDataLength = 6              // 6 words × 16 bits = 96 bits
      params.writeRetries = 1
      params.setWriteData(newEpc)             // hex string — SDK converts to bytes

      // writeWait is void — a successful return doesn't confirm the silicon accepted
      // the write. It only throws when the SDK knows it failed. Some radio-level
      // failures (weak signal, tag moved) produce neither exception nor success.
      r.Actions.TagAccess.writeWait(targetEpc, params, null, null)
      Log.d(TAG, "writeWait(target=$targetEpc, new=$newEpc) returned without exception")

      // Settle before the power cycle so the tag's charge pump has a moment to finish its
      // (attempted) EEPROM write before we kill RF.
      Thread.sleep(150)

      // Power-cycle the tag by dropping the reader's transmit power to index 0 for ~600 ms.
      // writeWait updates the tag's RAM response register regardless of whether EEPROM commit
      // succeeded — so multi-sighting verify while the tag is still in field is a false
      // positive. After RF drops, the tag loses power, clears RAM, and reboots from EEPROM
      // when we restore power. If EEPROM genuinely committed, it broadcasts newEpc; if not,
      // it broadcasts the legacy oldEpc and verify fails.
      //
      // This is the fix for the bug where Chainway (via the symmetric controller) claimed
      // ENCODED on a tag that Samsung then read back as the legacy C1... EPC — Samsung was
      // effectively doing the power-cycle that the verifier should have done itself.
      val levels = r.ReaderCapabilities.transmitPowerLevelValues
      val prevIdx = runCatching { r.Config.Antennas.getAntennaRfConfig(1).getTransmitPowerIndex() }
        .getOrDefault(-1)
      val minIdx = 0
      runCatching {
        val cfg = r.Config.Antennas.getAntennaRfConfig(1)
        cfg.setTransmitPowerIndex(minIdx)
        r.Config.Antennas.setAntennaRfConfig(1, cfg)
      }.onFailure { Log.w(TAG, "power-cycle: setTransmitPowerIndex($minIdx) failed: ${it.message}") }
      Log.d(TAG, "power-cycle: prevIdx=$prevIdx dropped to idx=$minIdx (levels.size=${levels?.size ?: -1}); sleeping 600ms")
      Thread.sleep(600)
      runCatching {
        val cfg = r.Config.Antennas.getAntennaRfConfig(1)
        cfg.setTransmitPowerIndex(if (prevIdx >= 0) prevIdx else indexClosestToDbm(levels ?: IntArray(0), requestedPowerDbm.get()))
        r.Config.Antennas.setAntennaRfConfig(1, cfg)
      }.onFailure { Log.w(TAG, "power-cycle: restore setTransmitPowerIndex failed: ${it.message}") }
      Log.d(TAG, "power-cycle: restored to prevIdx=$prevIdx; tag should have rebooted from EEPROM")

      // Multi-sighting verify after power cycle. Additionally requires oldSightings==0 —
      // see verifyEpcWrite for rationale.
      val verified = verifyEpcWrite(r, targetEpc, newEpc)
      if (!verified) {
        // Diagnostic: the SDK accepted writeWait but the tag didn't end up with newEpc in
        // EEPROM. Read the EPC and RESERVED banks directly so the log tells us whether
        // the tag is lock-protected / has a non-default access password / silently refused
        // the write. Filter by targetEpc — that's what the tag should still be broadcasting
        // if the write didn't commit.
        runCatching {
          val rp = r.Actions.TagAccess.ReadAccessParams()
          rp.accessPassword = 0L
          rp.memoryBank = com.zebra.rfid.api3.MEMORY_BANK.MEMORY_BANK_EPC
          rp.offset = 2
          rp.count = 6
          val td = r.Actions.TagAccess.readWait(targetEpc, rp, null)
          val id = td?.getTagID() ?: "<null>"
          val mem = td?.getMemoryBankData() ?: "<null>"
          Log.d(TAG, "post-fail diag: readWait(EPC bank, ptr=2, cnt=6) tagID=$id memBank='$mem' (expected new=$newEpc, else old=$targetEpc)")
        }.onFailure { Log.w(TAG, "post-fail diag: EPC read threw: ${it.message}") }
        runCatching {
          val rp = r.Actions.TagAccess.ReadAccessParams()
          rp.accessPassword = 0L
          rp.memoryBank = com.zebra.rfid.api3.MEMORY_BANK.MEMORY_BANK_RESERVED
          rp.offset = 0
          rp.count = 4
          val td = r.Actions.TagAccess.readWait(targetEpc, rp, null)
          val mem = td?.getMemoryBankData() ?: "<null>"
          Log.d(TAG, "post-fail diag: readWait(RESERVED bank, kill+access pw) -> '$mem' (if read-locked, write likely write-locked too)")
        }.onFailure { Log.w(TAG, "post-fail diag: RESERVED read threw (likely read-locked): ${it.message}") }
      }
      return verified
    } catch (e: InvalidUsageException) {
      Log.w(TAG, "performWriteEpc InvalidUsageException: ${e.message}")
      lastError = e.message ?: e.javaClass.simpleName
      return false
    } catch (e: OperationFailureException) {
      Log.w(TAG, "performWriteEpc OperationFailureException: ${e.message}")
      lastError = e.message ?: e.javaClass.simpleName
      return false
    } finally {
      if (wasRunning) {
        try { r.Actions.Inventory.perform() } catch (_: Exception) { /* ignore */ }
      }
    }
  }

  /**
   * Verify a just-issued Zebra EPC write by scanning for multiple sightings of [newEpc].
   * Requires [minNewSightings] separate reads within [timeoutMs] before declaring success —
   * a single sighting is vulnerable to the UHF Gen2 ghost-response failure mode where the
   * tag's write-buffer briefly echoes the new EPC before the silicon reverts. Same rationale
   * as [CarbonChainwayRfidController.verifyEpcWrite].
   */
  private fun verifyEpcWrite(
    r: RFIDReader,
    oldEpc: String,
    newEpc: String,
    timeoutMs: Long = 3000,
    minNewSightings: Int = 3,
  ): Boolean {
    val oldNorm = oldEpc.uppercase()
    val newNorm = newEpc.uppercase()
    var newSightings = 0
    var oldSightings = 0
    var otherSightings = 0
    val deadline = System.currentTimeMillis() + timeoutMs
    // eventReadNotify also drains the SDK read buffer via r.Actions.getReadTags(100).
    // Suppress it for the verify window so our poll loop has exclusive ownership of
    // the buffer — otherwise the listener could consume the few sightings we need and
    // leave our loop seeing zero.
    val previousInventoryActive = inventoryActive
    inventoryActive = false
    try {
      r.Actions.Inventory.perform()
      Log.d(TAG, "verifyEpcWrite: Inventory.perform() timeout=${timeoutMs}ms threshold=$minNewSightings")
      while (System.currentTimeMillis() < deadline && newSightings < minNewSightings) {
        val tags = try { r.Actions.getReadTags(100) } catch (_: Exception) { null }
        if (tags != null) {
          for (t in tags) {
            val id = t.getTagID()?.trim()?.uppercase() ?: continue
            when (id) {
              oldNorm -> {
                oldSightings++
                if (oldSightings <= 3 || oldSightings % 10 == 0) {
                  Log.d(TAG, "verify sighted OLD $id (count=$oldSightings)")
                }
              }
              newNorm -> {
                newSightings++
                if (newSightings <= 5 || newSightings % 10 == 0) {
                  Log.d(TAG, "verify sighted NEW $id (count=$newSightings)")
                }
                if (newSightings >= minNewSightings) break
              }
              else -> {
                otherSightings++
                if (otherSightings <= 3) {
                  Log.d(TAG, "verify sighted OTHER $id (count=$otherSightings)")
                }
              }
            }
          }
        }
        Thread.sleep(40)
      }
    } finally {
      try { r.Actions.Inventory.stop() } catch (_: Exception) { /* ignore */ }
      inventoryActive = previousInventoryActive
    }
    // Post-power-cycle, any sighting of oldEpc means the tag booted from EEPROM still holding
    // the legacy value — the write did not commit to silicon. Reject regardless of newSightings.
    val verified = newSightings >= minNewSightings && oldSightings == 0
    Log.d(
      TAG,
      "verifyEpcWrite: old=$oldEpc new=$newEpc newSightings=$newSightings oldSightings=$oldSightings otherSightings=$otherSightings threshold=$minNewSightings requireOldZero=true -> $verified",
    )
    return verified
  }

  /**
   * Map requested dBm (0–30) to [RFIDReader.Config.Antennas] transmit power index.
   * Zebra tables are often centi-dBm (value/100); otherwise treat entries as dBm.
   */
  private fun applyTransmitPowerDbm(r: RFIDReader) {
    try {
      val levels = r.ReaderCapabilities.transmitPowerLevelValues ?: return
      if (levels.isEmpty()) return
      val tgt = requestedPowerDbm.get().coerceIn(0, 30)
      val idx = indexClosestToDbm(levels, tgt).coerceIn(0, levels.size - 1)
      val config = r.Config.Antennas.getAntennaRfConfig(1)
      config.setTransmitPowerIndex(idx)
      config.setTari(0L)
      config.setrfModeTableIndex(0L)
      r.Config.Antennas.setAntennaRfConfig(1, config)
    } catch (_: Exception) {
      /* optional on some firmware */
    }
  }

  private fun indexClosestToDbm(levels: IntArray, targetDbm: Int): Int {
    val tgt = targetDbm.coerceIn(0, 30)
    val maxRaw = levels.maxOrNull() ?: return 0
    val useCenti = maxRaw > 33
    var bestIdx = 0
    var bestErr = Int.MAX_VALUE
    for (i in levels.indices) {
      val v = levels[i]
      val dbm = if (useCenti) v / 100 else v
      val err = abs(dbm - tgt)
      if (err < bestErr) {
        bestErr = err
        bestIdx = i
      }
    }
    return bestIdx
  }

  private fun openReaders() {
    Log.d(TAG, "openReaders: trying BLUETOOTH transport")
    var r = Readers(ZebraContextWrapper(context.applicationContext), ENUM_TRANSPORT.BLUETOOTH)
    var list = safeList(r)
    Log.d(TAG, "openReaders: BLUETOOTH -> ${list?.size ?: "null"} readers; names=${list?.map { it.name }}")
    if (list.isNullOrEmpty()) {
      try {
        r.Dispose()
      } catch (_: Exception) {
        /* ignore */
      }
      Log.d(TAG, "openReaders: falling back to SERVICE_USB transport")
      r = Readers(ZebraContextWrapper(context.applicationContext), ENUM_TRANSPORT.SERVICE_USB)
      list = safeList(r)
      Log.d(TAG, "openReaders: SERVICE_USB -> ${list?.size ?: "null"} readers; names=${list?.map { it.name }}")
    }
    if (list.isNullOrEmpty()) {
      try {
        r.Dispose()
      } catch (_: Exception) {
        /* ignore */
      }
      error("No Zebra readers on Bluetooth or USB.")
    }
    readers = r
    Readers.attach(this)
    readersAttached = true
    Log.d(TAG, "openReaders: attached handler, ready")
  }

  private fun safeList(r: Readers): ArrayList<ReaderDevice>? =
    try {
      r.GetAvailableRFIDReaderList()
    } catch (_: InvalidUsageException) {
      null
    }

  private fun pickReader(): RFIDReader? {
    val list = readers?.GetAvailableRFIDReaderList() ?: return null
    val hint = readerNameHint
    if (!hint.isNullOrEmpty()) {
      for (d in list) {
        val n = d.name
        if (n != null && n.contains(hint, ignoreCase = true)) {
          return d.rfidReader
        }
      }
    }
    return list[0].rfidReader
  }

  private fun connectAndConfigureReader() {
    val r = reader ?: return
    if (!r.isConnected) {
      Log.d(TAG, "connectAndConfigureReader: r.connect()")
      r.connect()
      Log.d(TAG, "connectAndConfigureReader: connected=${r.isConnected} host=${r.hostName}")
    }
    val triggerInfo = TriggerInfo()
    triggerInfo.StartTrigger.setTriggerType(START_TRIGGER_TYPE.START_TRIGGER_TYPE_IMMEDIATE)
    triggerInfo.StopTrigger.setTriggerType(STOP_TRIGGER_TYPE.STOP_TRIGGER_TYPE_IMMEDIATE)

    if (eventHandler == null) {
      eventHandler = ZebraEventHandler()
    }
    r.Events.addEventsListener(eventHandler)
    r.Events.setHandheldEvent(true)
    r.Events.setTagReadEvent(true)
    r.Events.setAttachTagDataWithReadEvent(false)
    r.Config.setTriggerMode(ENUM_TRIGGER_MODE.RFID_MODE, true)
    r.Config.setStartTrigger(triggerInfo.StartTrigger)
    r.Config.setStopTrigger(triggerInfo.StopTrigger)

    applyTransmitPowerDbm(r)

    // Singulation-control setup is an optimization, not a requirement.
    // Some RFD8500 firmware revisions reject SESSION_S1 + INVENTORY_STATE_A + SL_ALL
    // as a combo with OperationFailureException and no recoverable detail. When that
    // happens, fall back to S0, then to the reader's defaults — we'd rather read
    // tags at suboptimal singulation than refuse to connect at all.
    applyOptionalSingulationControl(r)
    try {
      r.Actions.PreFilters.deleteAll()
    } catch (e: Exception) {
      Log.w(TAG, "PreFilters.deleteAll ignored: ${e.message}")
    }
  }

  private fun applyOptionalSingulationControl(r: RFIDReader) {
    val sessions = listOf(SESSION.SESSION_S1, SESSION.SESSION_S0)
    for (session in sessions) {
      try {
        val sing = r.Config.Antennas.getSingulationControl(1)
        sing.setSession(session)
        sing.Action.setInventoryState(INVENTORY_STATE.INVENTORY_STATE_A)
        sing.Action.setSLFlag(SL_FLAG.SL_ALL)
        r.Config.Antennas.setSingulationControl(1, sing)
        Log.d(TAG, "singulation: $session accepted")
        return
      } catch (e: Exception) {
        Log.w(TAG, "singulation: $session rejected (${e.message}); trying next")
      }
    }
    Log.w(TAG, "singulation: all fallbacks rejected — using reader defaults")
  }

  /**
   * Best-effort full teardown. Every step is guarded and every step is always
   * attempted, regardless of [RFIDReader.isConnected] — the earlier "only
   * disconnect if connected" gate left a half-open SPP socket on failed connects
   * which wedged Samsung's BT stack and required manual Settings toggling.
   *
   * Call ordering is reverse-construction: Readers.deattach → remove listeners
   * → stop inventory → disconnect → Dispose Readers. Every try block swallows
   * exceptions so a later step's failure doesn't skip an earlier unwind.
   */
  private fun disconnectSync() {
    inventoryActive = false

    // Tear down the BarcodeScanner first so its CoreScanner socket releases
    // before we kill the RFID side — same SPP transport, sequence matters.
    val bs = barcodeScanner
    if (bs != null) {
      try {
        bs.javaClass.getMethod("disconnect").invoke(bs)
      } catch (e: Exception) {
        Log.w(TAG, "barcode SDK: scanner.disconnect threw: ${e.message}")
      }
      barcodeScanner = null
    }
    barcodeWatcher = null
    barcodeListenerRegistered = false

    // 1. Detach the RFIDReaderEventHandler (process-wide listener slot).
    if (readersAttached) {
      try { Readers.deattach(this) } catch (_: Exception) { /* ignore */ }
      readersAttached = false
    }

    val r = reader
    val eh = eventHandler

    // 2. Remove per-reader events listener — unconditional so a failed-connect
    //    reader that never registered cleanly doesn't leak a dangling ref.
    if (r != null && eh != null) {
      try { r.Events.removeEventsListener(eh) } catch (_: Exception) { /* ignore */ }
    }

    // 3. Stop inventory — SDK tolerates being called when not actively
    //    inventorying. Harmless no-op in the connect-failed case.
    if (r != null) {
      try { r.Actions.Inventory.stop() } catch (_: Exception) { /* ignore */ }
    }

    // 4. Disconnect UNCONDITIONALLY. On a connect-failed path the SDK still
    //    owns an in-flight SPP socket attempt; disconnect() is how we tell it
    //    to release. Skipping this because isConnected==false was the wedge.
    if (r != null) {
      try { r.disconnect() } catch (_: Exception) { /* ignore */ }
    }

    reader = null
    eventHandler = null

    // 5. Dispose the Readers container — releases native allocations.
    try { readers?.Dispose() } catch (_: Exception) { /* ignore */ }
    readers = null
  }

  private fun emitTag(epc: String, rssi: Short?) {
    val sink = tagSink ?: return
    val clean = epc.trim().uppercase()
    Log.d("LAT", "NATIVE_EPC ts=${System.currentTimeMillis()} epc=$clean")
    val rssiInt = rssi?.toInt() ?: -56
    // Native-originated per-tag beep — fire before sink post so audio feedback
    // does not wait for Dart scheduling.
    ScanSoundPool.shared?.playTagBeep(normalizeRssi(rssiInt))
    val payload = mapOf("epc" to clean, "rssi" to rssiInt)
    mainHandler.post { sink.success(payload) }
  }

  /** dBm → 0–100 normalized scale. Same mapping as the Chainway controller. */
  private fun normalizeRssi(dbm: Int): Int {
    val clamped = dbm.coerceIn(-90, -40)
    return ((clamped + 90) * 2).coerceIn(0, 100)
  }

  override fun RFIDReaderAppeared(readerDevice: ReaderDevice) {
    Log.d(TAG, "RFIDReaderAppeared: name=${readerDevice.name}")
  }

  override fun RFIDReaderDisappeared(readerDevice: ReaderDevice) {
    Log.d(TAG, "RFIDReaderDisappeared: name=${readerDevice.name}")
    val host = reader?.hostName
    if (host != null && readerDevice.name == host) {
      disconnectAsync()
    }
  }

  companion object {
    private const val TAG = "CarbonZebra"
  }

  private inner class ZebraEventHandler : RfidEventsListener {
    override fun eventReadNotify(e: RfidReadEvents?) {
      // Drop late reads that arrive after the user stopped: RFD8500 sometimes flushes
      // buffered tags for up to 1s after .stop() is called, which on Samsung looked
      // like "EPCs keep scanning after Stop already gone."
      if (!inventoryActive) return
      val r = reader ?: return
      val tags: Array<TagData>? =
        try {
          r.Actions.getReadTags(100)
        } catch (_: Exception) {
          null
        }
      if (tags == null) return
      for (t in tags) {
        val id = t.getTagID() ?: continue
        if (id.isBlank()) continue
        val rssi =
          try {
            t.getPeakRSSI()
          } catch (_: Exception) {
            null
          }
        emitTag(id, rssi)
      }
    }

    override fun eventStatusNotify(rfidStatusEvents: RfidStatusEvents?) {
      val data = rfidStatusEvents?.StatusEventData ?: return
      if (data.getStatusEventType() != STATUS_EVENT_TYPE.HANDHELD_TRIGGER_EVENT) return
      val triggerEvent = data.HandheldTriggerEventData?.getHandheldEvent() ?: return
      val payload = when (triggerEvent) {
        HANDHELD_TRIGGER_EVENT_TYPE.HANDHELD_TRIGGER_PRESSED -> "down"
        HANDHELD_TRIGGER_EVENT_TYPE.HANDHELD_TRIGGER_RELEASED -> "up"
        else -> return
      }
      val sink = triggerSink ?: return
      mainHandler.post { sink.success(payload) }
    }
  }
}
