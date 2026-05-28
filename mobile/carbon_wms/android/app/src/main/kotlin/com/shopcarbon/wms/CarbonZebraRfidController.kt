package com.shopcarbon.wms

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.zebra.rfid.api3.BEEPER_VOLUME
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
import com.zebra.scannercontrol.DCSSDKDefs
import com.zebra.scannercontrol.DCSScannerInfo
import com.zebra.scannercontrol.FirmwareUpdateEvent
import com.zebra.scannercontrol.IDcsSdkApiDelegate
import com.zebra.scannercontrol.SDKHandler
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.abs

/**
 * Zebra RFID API3: prefers Bluetooth, then USB service transport.
 * Streams `{"epc","rssi"}` on the Flutter [EventChannel] sink.
 *
 * Two SDKs run side-by-side against the same RFD8500:
 *   - API3 (RFIDReader) owns UHF tag inventory + trigger-mode routing.
 *   - CoreScanner (SDKHandler) owns barcode decode events. When the trigger
 *     is flipped to BARCODE_MODE on the API3 side, the imager fires and the
 *     decoded bytes come back on the CoreScanner session via
 *     IDcsSdkApiDelegate.dcssdkEventBarcode. This is the same dual-stack
 *     pattern Zebra's own 123RFID reference app uses.
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

  // CoreScanner (com.zebra.scannercontrol) state. SDKHandler is constructed
  // once per connect cycle and torn down in disconnectSync. Scanner ID for
  // the active session (the paired RFD8500) is captured when CoreScanner
  // fires dcssdkEventCommunicationSessionEstablished.
  @Volatile private var sdkHandler: SDKHandler? = null
  @Volatile private var barcodeScannerId: Int = -1

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
   * Flip the RFD8500 trigger to fire the 2D imager instead of UHF. While in
   * this mode, trigger pulls do NOT produce RFID tag events — the imager
   * fires and the decoded barcode flows back through the CoreScanner
   * session as a [IDcsSdkApiDelegate.dcssdkEventBarcode] callback (see
   * [BarcodeDelegate]).
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
        // Defensive re-init of the CoreScanner SDK side. The barcode SDK
        // is normally booted once at connect-time, but a BT drop +
        // re-pair AFTER connect leaves the new sled identity without a
        // CoreScanner communication session — the imager fires + green-
        // beeps + the gun decodes, but the host never sees it because
        // dcssdkEventBarcode is bound to the OLD scanner ID. Calling
        // initBarcodeSdkOnce() here is idempotent (it no-ops when
        // sdkHandler is already set), and forceRebindBarcodeScanner()
        // re-triggers Available-Scanners discovery so a freshly-paired
        // RFD8500 gets a session before the operator's first trigger pull.
        // Fixes the Bin Assign symptom "scan green-beeps but bin code
        // never appears in the app" on Zebra hardware.
        initBarcodeSdkOnce()
        forceRebindBarcodeScanner()
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
      } catch (e: Exception) {
        Log.w(TAG, "setTriggerModeBarcode failed: ${e.message}")
        lastError = e.message ?: e.javaClass.simpleName
      }
    }
  }

  fun setTriggerModeRfid() {
    executor.execute {
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
   * Boots CoreScanner ([SDKHandler]) and registers our [BarcodeDelegate].
   * Once initialised, the SDK auto-discovers paired RFD8500s and fires
   * [IDcsSdkApiDelegate.dcssdkEventScannerAppeared] for each one. We then
   * call [SDKHandler.dcssdkEstablishCommunicationSession] to open the
   * barcode session — after which trigger-driven imager decodes flow
   * through [IDcsSdkApiDelegate.dcssdkEventBarcode] into our
   * [CarbonHardwareBarcodeRelay].
   *
   * Best-effort: failures here do NOT fail the API3 RFID connect. UHF still
   * works even if the barcode side never comes up.
   */
  private fun initBarcodeSdkOnce() {
    if (sdkHandler != null) return
    val relay = barcodeRelay ?: run {
      Log.d(TAG, "barcode SDK: no relay set, skipping init")
      return
    }
    try {
      val handler = SDKHandler(context.applicationContext)
      // BT_NORMAL = Bluetooth Classic SSI, the mode RFD8500 uses when paired
      // for sled-style operation alongside API3 RFID. The dual-stack pattern
      // works because the sled's firmware multiplexes RFID and barcode
      // logical channels on the same physical BT link, which is the same
      // combination Zebra's own 123RFID app uses.
      handler.dcssdkSetOperationalMode(DCSSDKDefs.DCSSDK_MODE.DCSSDK_OPMODE_BT_NORMAL)
      handler.dcssdkSetDelegate(BarcodeDelegate(relay))
      val mask = (
        DCSSDKDefs.DCSSDK_EVENT.DCSSDK_EVENT_BARCODE.value or
          DCSSDKDefs.DCSSDK_EVENT.DCSSDK_EVENT_SCANNER_APPEARANCE.value or
          DCSSDKDefs.DCSSDK_EVENT.DCSSDK_EVENT_SCANNER_DISAPPEARANCE.value or
          DCSSDKDefs.DCSSDK_EVENT.DCSSDK_EVENT_SESSION_ESTABLISHMENT.value or
          DCSSDKDefs.DCSSDK_EVENT.DCSSDK_EVENT_SESSION_TERMINATION.value
        )
      handler.dcssdkSubsribeForEvents(mask)
      handler.dcssdkEnableAutomaticSessionReestablishment(true, 0)
      handler.dcssdkEnableAvailableScannersDetection(true)
      handler.dcssdkEnableBluetoothScannersDiscovery(true)
      sdkHandler = handler
      Log.d(TAG, "barcode SDK: SDKHandler initialised, awaiting scanner-appeared events")
    } catch (t: Throwable) {
      Log.w(TAG, "barcode SDK: init failed (${t.javaClass.name}: ${t.message})", t)
      sdkHandler = null
    }
  }

  /**
   * Re-bind a paired RFD8500 to the CoreScanner SDK without bouncing the
   * RFID side. Resolves the "decode green-beeps but Flutter never sees the
   * data" symptom that happens when the SDK was initialised before the
   * sled was paired, or when the BT link dropped + auto-reconnected after
   * the initial connect.
   *
   * Strategy:
   *  1. Ask CoreScanner for the current AvailableScannersList — this also
   *     re-fires `dcssdkEventScannerAppeared` for any sled that the SDK
   *     knows about but isn't actively tracking.
   *  2. If we already have a [barcodeScannerId] mapped, re-issue
   *     [dcssdkEstablishCommunicationSession] for it (no-op when the
   *     session is already alive on most firmware revisions; otherwise
   *     re-opens it).
   *
   * Idempotent. No-ops when the SDK never came up.
   */
  private fun forceRebindBarcodeScanner() {
    val handler = sdkHandler ?: return
    try {
      // ArrayList is what CoreScanner's API expects/returns; the variant
      // is intentional. Re-querying the list re-fires scannerAppeared
      // events for any sled with a known BT identity.
      val list = ArrayList<DCSScannerInfo>()
      try {
        handler.dcssdkGetAvailableScannersList(list)
        Log.d(TAG, "barcode SDK: rebind — available list size=${list.size}")
        for (s in list) {
          val name = s.scannerName.orEmpty()
          if (!name.uppercase().startsWith("RFD")) continue
          val id = s.scannerID
          val res = try {
            handler.dcssdkEstablishCommunicationSession(id)
          } catch (t: Throwable) {
            Log.w(TAG, "barcode SDK: rebind establish id=$id threw", t)
            -1
          }
          Log.d(TAG, "barcode SDK: rebind establish id=$id name='$name' -> $res")
        }
      } catch (t: Throwable) {
        Log.w(TAG, "barcode SDK: getAvailableScannersList threw", t)
      }
      // Belt-and-braces: if we still have a remembered scannerID from a
      // prior session, re-establish it directly.
      val sid = barcodeScannerId
      if (sid != -1) {
        try {
          val res = handler.dcssdkEstablishCommunicationSession(sid)
          Log.d(TAG, "barcode SDK: rebind cached id=$sid -> $res")
        } catch (t: Throwable) {
          Log.w(TAG, "barcode SDK: rebind cached id=$sid threw", t)
        }
      }
    } catch (t: Throwable) {
      Log.w(TAG, "barcode SDK: forceRebind failed", t)
    }
  }

  /**
   * Routes CoreScanner callbacks to our existing barcode relay. Filters
   * scanner appearances by name so only RFD-class devices ever get a
   * communication session — paired Galaxy Watches and the like are ignored.
   */
  private inner class BarcodeDelegate(
    private val relay: CarbonHardwareBarcodeRelay,
  ) : IDcsSdkApiDelegate {
    override fun dcssdkEventScannerAppeared(scanner: DCSScannerInfo) {
      val name = scanner.scannerName.orEmpty()
      val id = scanner.scannerID
      Log.d(TAG, "barcode SDK: scannerAppeared id=$id name='$name' model='${scanner.scannerModel}'")
      if (!name.uppercase().startsWith("RFD")) {
        Log.d(TAG, "barcode SDK: skipping non-RFD scanner '$name'")
        return
      }
      executor.execute {
        try {
          val res = sdkHandler?.dcssdkEstablishCommunicationSession(id)
          Log.d(TAG, "barcode SDK: establishCommunicationSession id=$id -> $res")
        } catch (t: Throwable) {
          Log.w(TAG, "barcode SDK: establishCommunicationSession id=$id threw", t)
        }
      }
    }

    override fun dcssdkEventScannerDisappeared(scannerID: Int) {
      Log.d(TAG, "barcode SDK: scannerDisappeared id=$scannerID")
      if (barcodeScannerId == scannerID) {
        barcodeScannerId = -1
      }
    }

    override fun dcssdkEventCommunicationSessionEstablished(scanner: DCSScannerInfo) {
      barcodeScannerId = scanner.scannerID
      Log.d(TAG, "barcode SDK: sessionEstablished id=${scanner.scannerID} name='${scanner.scannerName}'")
    }

    override fun dcssdkEventCommunicationSessionTerminated(scannerID: Int) {
      Log.d(TAG, "barcode SDK: sessionTerminated id=$scannerID")
      if (barcodeScannerId == scannerID) {
        barcodeScannerId = -1
      }
    }

    override fun dcssdkEventBarcode(barcodeData: ByteArray?, barcodeType: Int, fromScannerID: Int) {
      if (barcodeData == null || barcodeData.isEmpty()) return
      val raw = try {
        String(barcodeData, Charsets.UTF_8)
      } catch (_: Exception) {
        return
      }
      val cleaned = raw.trim().trimEnd(' ', '\r', '\n', ' ')
      if (cleaned.isEmpty()) return
      Log.d(TAG, "barcode SDK: decode id=$fromScannerID type=$barcodeType bytes=${barcodeData.size} value='$cleaned'")
      relay.emitExternal(cleaned)
    }

    override fun dcssdkEventImage(imageData: ByteArray?, fromScannerID: Int) { /* not subscribed */ }
    override fun dcssdkEventVideo(videoData: ByteArray?, fromScannerID: Int) { /* not subscribed */ }
    override fun dcssdkEventBinaryData(binaryData: ByteArray?, fromScannerID: Int) { /* not subscribed */ }
    override fun dcssdkEventFirmwareUpdate(event: FirmwareUpdateEvent?) { /* not subscribed */ }
    override fun dcssdkEventAuxScannerAppeared(newTopology: DCSScannerInfo?, auxScanner: DCSScannerInfo?) { /* not used */ }
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
        // After API3 is up, boot CoreScanner so imager decodes have a path
        // home. Best-effort: failures don't fail the RFID connect.
        initBarcodeSdkOnce()
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
      val clamped = dbm.coerceIn(0, 30)
      val prior = requestedPowerDbm.getAndSet(clamped)
      if (prior == clamped) {
        // Idempotent dedupe. MobileSettingsRepository.setGlobalAntennaPower
        // double-fires this (direct push AND notifyListeners → RfidManager
        // .reapplyHandheldHardwareSettings → setAntennaPowerDbm again).
        // Without the dedupe, a single Dart slider release queues TWO
        // full stop+setAntennaRfConfig+perform cycles. Each cycle drops
        // ~1 s of buffered tags (line 1075 drainage), so the operator
        // gets a stutter + extra beep flurry every drag.
        return@execute
      }
      val r = reader
      if (r == null || !r.isConnected) {
        Log.d(TAG, "setAntennaPowerDbm($clamped) deferred: reader not connected (will apply on next start)")
        return@execute
      }
      // RFD8500 firmware rejects setAntennaRfConfig while Inventory is
      // streaming with OperationFailureException, so we pause + apply +
      // resume around the config write. CRITICAL: flip inventoryActive
      // false BEFORE Actions.Inventory.stop() so the up-to-1 s of
      // buffered tags the SDK drains post-stop (see line 1075's "buffered
      // tags for up to 1s after .stop()" comment) get gated off by the
      // eventReadNotify guard at line 1077. Without this the operator
      // sees a beep flurry every slider change even though they think
      // they're pausing. Flip back true AFTER successful perform.
      val wasRunning = inventoryActive
      if (wasRunning) {
        inventoryActive = false
        try {
          r.Actions.Inventory.stop()
        } catch (e: Exception) {
          Log.w(TAG, "setAntennaPowerDbm: pre-apply Inventory.stop ignored: ${e.message}")
        }
      }
      val ok = applyTransmitPowerDbm(r)
      Log.d(TAG, "setAntennaPowerDbm($clamped) prior=$prior appliedOk=$ok wasRunning=$wasRunning")
      if (wasRunning) {
        try {
          r.Actions.Inventory.perform()
          // Only flip the gate back true AFTER perform returns without
          // throwing. The old code left this to "inventoryActive stays
          // whatever it was", relying on the variable never having been
          // touched — that broke as soon as we (correctly) cleared it
          // before stop above. Be explicit.
          inventoryActive = true
        } catch (e: Exception) {
          Log.w(TAG, "setAntennaPowerDbm: post-apply Inventory.perform failed: ${e.message}")
          // Surfaces in lastError so the diagnostics card and the count
          // screen's RfidManager can flag the radio as broken.
          lastError = e.message ?: e.javaClass.simpleName
          inventoryActive = false
        }
      }
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
        // Silence the sled's per-tag beeper ONLY during this active
        // inventory burst. Restored to HIGH in stopInventoryAsync so
        // the sled is back at the resting volume by the time anything
        // outside scan (connect/disconnect chime, power chime) fires.
        try {
          r.Config.setBeeperVolume(BEEPER_VOLUME.QUIET_BEEP)
          Log.d(TAG, "BeeperVolume -> QUIET_BEEP (scan-start)")
        } catch (e: Exception) {
          Log.w(TAG, "scan-start setBeeperVolume failed: ${e.message}")
        }
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
      // Restore the sled's resting volume so subsequent firmware chimes
      // (mode change → done elsewhere, disconnect, power) fire audibly,
      // including after a force-close because NVRAM is now HIGH. This
      // is the central guarantee of the at-rest=HIGH policy.
      try {
        reader?.takeIf { it.isConnected }?.Config?.setBeeperVolume(BEEPER_VOLUME.HIGH_BEEP)
        Log.d(TAG, "BeeperVolume -> HIGH_BEEP (scan-stop)")
      } catch (e: Exception) {
        Log.w(TAG, "scan-stop setBeeperVolume failed: ${e.message}")
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

    // Capture pre-write power index so we can boost-then-restore around the
    // writeWait call. Write requires materially more link-budget than read
    // — at the slider's dBm the radio could hear the tag (read OK) but the
    // tag's EEPROM charge pump couldn't gather enough energy to actually
    // commit the new EPC, so writeWait returned without exception while
    // the silicon rejected the write. 50+ "defective" tags traced back to
    // this. Force max power for the write window, restore afterwards.
    val levels = r.ReaderCapabilities.transmitPowerLevelValues
    val prevPowerIdx = runCatching {
      r.Config.Antennas.getAntennaRfConfig(1).getTransmitPowerIndex()
    }.getOrDefault(-1)
    val maxPowerIdx = (levels?.size ?: 1) - 1
    runCatching {
      if (levels != null && maxPowerIdx >= 0 && prevPowerIdx != maxPowerIdx) {
        val cfg = r.Config.Antennas.getAntennaRfConfig(1)
        cfg.setTransmitPowerIndex(maxPowerIdx)
        r.Config.Antennas.setAntennaRfConfig(1, cfg)
        Log.d(TAG, "performWriteEpc: boosted power idx $prevPowerIdx -> $maxPowerIdx for write")
      }
    }.onFailure { Log.w(TAG, "performWriteEpc: power boost failed: ${it.message}") }

    // Allow the SDK more time on synchronous tag-access calls. The default
    // is short on some firmware revisions and a slow tag → spurious
    // OperationFailureException → false. Per the Zebra Tag Write Guide,
    // setAccessOperationWaitTimeout should be raised before writeWait.
    runCatching { r.Config.setAccessOperationWaitTimeout(3000) }
      .onFailure { Log.w(TAG, "setAccessOperationWaitTimeout failed (older SDK?): ${it.message}") }

    try {
      // Log effective transmit power so write attempts are auditable.
      runCatching {
        val idx = r.Config.Antennas.getAntennaRfConfig(1).getTransmitPowerIndex()
        val rawDbm = if (levels != null && idx in levels.indices) levels[idx] else -1
        Log.d(TAG, "pre-write power: antenna=1 idx=$idx rawLevel=$rawDbm (requested=${requestedPowerDbm.get()} dBm) prevIdx=$prevPowerIdx")
      }

      val params = r.Actions.TagAccess.WriteAccessParams()
      params.accessPassword = 0L
      params.memoryBank = com.zebra.rfid.api3.MEMORY_BANK.MEMORY_BANK_EPC
      params.offset = 2                       // skip CRC (word 0) + PC (word 1)
      params.writeDataLength = newEpc.length / 4  // hex chars / 4 = words. 24/4 = 6 for 96-bit EPC.
      params.writeRetries = 3                 // partial-write recovery (Zebra recommends ≥3 with prefilter)
      params.setWriteData(newEpc)             // hex string — SDK converts to bytes

      // 6-param writeWait with bPrefilter=true. The SDK then applies the
      // tagID as a SELECT prefilter so the write packet only addresses
      // the target tag — critical when the radio hears 5+ tags from
      // adjacent racks at write power. Without prefilter, the write
      // could go to the wrong tag (or none). bTIDPrefilter=false on the
      // first attempt — TID prefilter doubles write latency and isn't
      // needed for unique EPCs. The 4-param version we previously used
      // had no prefilter at all and is what the Zebra Pre-Filter
      // Configurations Tutorial explicitly warns against for EPC writes.
      r.Actions.TagAccess.writeWait(targetEpc, params, null, null, true, false)
      Log.d(TAG, "writeWait(target=$targetEpc, new=$newEpc, prefilter=true) returned without exception")

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
      // (`levels` was captured at the top of the function — reuse it here.)
      val minIdx = 0
      runCatching {
        val cfg = r.Config.Antennas.getAntennaRfConfig(1)
        cfg.setTransmitPowerIndex(minIdx)
        r.Config.Antennas.setAntennaRfConfig(1, cfg)
      }.onFailure { Log.w(TAG, "power-cycle: setTransmitPowerIndex($minIdx) failed: ${it.message}") }
      Log.d(TAG, "power-cycle: dropped from boosted idx=$maxPowerIdx to idx=$minIdx (levels.size=${levels?.size ?: -1}); sleeping 600ms")
      Thread.sleep(600)
      // Bring power BACK UP to max for the verify window. The earlier
      // design restored to the operator's slider before verifying, on
      // the theory that "verify should match the read setting." In
      // practice it false-failed: operators encoding at 5-15 dBm with
      // the tag literally touching the antenna got writeFailed because
      // the verify loop's 3-second window couldn't gather 3 sightings
      // at low power, even though the tag had successfully been
      // rewritten. Verify at max so a touching tag is unambiguous; we
      // restore the operator's power AFTER verify completes, regardless
      // of outcome (see finally block).
      val restoreIdx = if (prevPowerIdx >= 0) prevPowerIdx
        else indexClosestToDbm(levels ?: IntArray(0), requestedPowerDbm.get())
      runCatching {
        val cfg = r.Config.Antennas.getAntennaRfConfig(1)
        cfg.setTransmitPowerIndex(maxPowerIdx)
        r.Config.Antennas.setAntennaRfConfig(1, cfg)
      }.onFailure { Log.w(TAG, "verify-prep: setTransmitPowerIndex(max) failed: ${it.message}") }
      Log.d(TAG, "verify-prep: boosted to max idx=$maxPowerIdx for verify window (operator's idx=$restoreIdx will be restored after)")

      // Multi-sighting verify after power cycle. Additionally requires oldSightings==0 —
      // see verifyEpcWrite for rationale.
      val verified = verifyEpcWrite(r, targetEpc, newEpc)

      // Always restore the operator's power, whether verify succeeded
      // or not, so the next inventory in this screen behaves as the
      // operator expects.
      runCatching {
        val cfg = r.Config.Antennas.getAntennaRfConfig(1)
        cfg.setTransmitPowerIndex(restoreIdx)
        r.Config.Antennas.setAntennaRfConfig(1, cfg)
      }.onFailure { Log.w(TAG, "post-verify: restore setTransmitPowerIndex failed: ${it.message}") }
      Log.d(TAG, "post-verify: restored to operator's idx=$restoreIdx")
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
      // If we exited via exception before the post-write power cycle ran,
      // the radio is still at the boosted max. Restore the operator's
      // power so subsequent inventory uses the slider value.
      if (prevPowerIdx >= 0 && levels != null) {
        runCatching {
          val cfg = r.Config.Antennas.getAntennaRfConfig(1)
          if (cfg.getTransmitPowerIndex() != prevPowerIdx) {
            cfg.setTransmitPowerIndex(prevPowerIdx)
            r.Config.Antennas.setAntennaRfConfig(1, cfg)
            Log.d(TAG, "performWriteEpc finally: restored power idx=$prevPowerIdx after early exit")
          }
        }.onFailure { Log.w(TAG, "performWriteEpc finally: restore power failed: ${it.message}") }
      }
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
    minNewSightings: Int = 2,
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
   *
   * Returns true if the radio confirmed the config write. The previous
   * version swallowed every exception which made it impossible to tell
   * whether the slider was actually doing anything on RFD8500.
   */
  private fun applyTransmitPowerDbm(r: RFIDReader): Boolean {
    return try {
      val levels = r.ReaderCapabilities.transmitPowerLevelValues
      if (levels == null || levels.isEmpty()) {
        Log.w(TAG, "applyTransmitPowerDbm: transmitPowerLevelValues missing")
        return false
      }
      val tgt = requestedPowerDbm.get().coerceIn(0, 30)
      val idx = indexClosestToDbm(levels, tgt).coerceIn(0, levels.size - 1)
      val maxRaw = levels.maxOrNull() ?: 0
      val unit = if (maxRaw > 33) "centi-dBm" else "dBm"
      val pickedRaw = levels[idx]
      val pickedDbm = if (maxRaw > 33) pickedRaw / 100 else pickedRaw
      val config = r.Config.Antennas.getAntennaRfConfig(1)
      config.setTransmitPowerIndex(idx)
      config.setTari(0L)
      config.setrfModeTableIndex(0L)
      r.Config.Antennas.setAntennaRfConfig(1, config)
      Log.d(
        TAG,
        "applyTransmitPowerDbm: tgt=${tgt}dBm idx=$idx picked=${pickedDbm}dBm (raw=$pickedRaw $unit) levelsLen=${levels.size}",
      )
      true
    } catch (e: Exception) {
      // Most common cause: setAntennaRfConfig called while inventory is
      // streaming → BUSY / OperationFailureException. setAntennaPowerDbm
      // now stops inventory before calling this, so a failure here means
      // something else (lost BT link, region locked, etc.).
      Log.w(TAG, "applyTransmitPowerDbm failed: ${e.javaClass.simpleName}: ${e.message}")
      lastError = e.message ?: e.javaClass.simpleName
      false
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
    // Beeper policy: the sled stays at HIGH_BEEP at REST (between
    // active scans + at idle), and is set to QUIET_BEEP only for the
    // duration of an inventory burst (in startInventoryFlutterResult).
    // Per-tag is silenced during scan; connect/disconnect/power chimes
    // happen while the sled is at rest and fire audibly.
    //
    // Belt-and-suspenders: write HIGH right after r.connect() too.
    // This connect's own firmware chime is gated by whatever NVRAM
    // held *before* this write lands — so a sled stuck at QUIET from
    // a prior force-close still has a silent first connect. But by
    // committing HIGH here, every operation AFTER this point uses
    // HIGH: the upcoming disconnect chime fires, the next session's
    // connect chime fires, etc. One sacrificed chime to self-heal
    // out of a stuck-QUIET NVRAM state without making the user run
    // a scan + stop cycle manually to prime it.
    val rJustConnected = reader
    if (rJustConnected != null && rJustConnected.isConnected) {
      try {
        rJustConnected.Config.setBeeperVolume(BEEPER_VOLUME.HIGH_BEEP)
        Log.d(TAG, "BeeperVolume -> HIGH_BEEP (post-connect, at-rest)")
      } catch (e: Exception) {
        Log.w(TAG, "post-connect setBeeperVolume failed: ${e.message}")
      }
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

    // Beeper restore lives in stopInventoryAsync now — by the time
    // disconnect runs, the sled is already back at HIGH_BEEP from the
    // last stopInventory, so the firmware's disconnect chime fires
    // naturally. Doing it here too would be redundant and risks
    // racing the link teardown.

    // Tear down CoreScanner first so its session socket releases before we
    // kill the RFID side — same physical BT link, sequence matters.
    val handler = sdkHandler
    if (handler != null) {
      try {
        val sid = barcodeScannerId
        if (sid >= 0) {
          handler.dcssdkTerminateCommunicationSession(sid)
        }
      } catch (e: Exception) {
        Log.w(TAG, "barcode SDK: terminateCommunicationSession threw: ${e.message}")
      }
      try {
        handler.dcssdkClose()
      } catch (e: Exception) {
        Log.w(TAG, "barcode SDK: dcssdkClose threw: ${e.message}")
      }
      sdkHandler = null
    }
    barcodeScannerId = -1

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
    Log.d("LAT", "NATIVE_EPC ts=${System.currentTimeMillis()} epc=$clean rssi=$rssi")
    val rssiInt = rssi?.toInt()
    // Native-originated per-tag beep — fire before sink post so audio feedback
    // does not wait for Dart scheduling. The beep falls back to -56 when RSSI
    // is missing (mid-range volume), but the WIRE payload to Dart must keep
    // `null` so the Locate-Tag screen's fallbackRssiOnNull path can fire
    // instead of pinning the proximity bar near 69% (the value a -56 dBm
    // reading would produce on the rssiToProximity01 formula).
    ScanSoundPool.shared?.playTagBeep(normalizeRssi(rssiInt ?: -56))
    val payload: Map<String, Any?> = if (rssiInt != null) {
      mapOf("epc" to clean, "rssi" to rssiInt)
    } else {
      mapOf("epc" to clean, "rssi" to null)
    }
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
