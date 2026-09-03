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

  // Dedicated executor for the (potentially blocking) tag-write. Kept OFF the
  // shared `executor` so a half-open-BT `writeWait` that hangs can never stall
  // stop/disconnect/setTriggerMode — those must always stay responsive or the
  // operator is forced to kill the app. Volatile + replaceable: on a hard
  // watchdog timeout we shutdownNow() (interrupt) and swap in a fresh one, so
  // the next write gets a clean thread even if the old one is still stuck in a
  // native BT call that ignores interruption.
  @Volatile private var writeExec: java.util.concurrent.ExecutorService =
    Executors.newSingleThreadExecutor()
  private val writeWatchdog = Executors.newSingleThreadExecutor()
  // Hard ceiling for a single write. Worst-case healthy write (1.5s writeWait +
  // 0.26s power-cycle + 3s verify + resume) is ~5s; 9s gives margin before we
  // declare the link wedged. The Dart side (rfid_vendor_channel.writeEpcTag)
  // carries a 12s belt-timeout outside this.
  private val writeHardTimeoutMs = 9000L

  // Set true whenever the CoreScanner barcode session is not known-alive, so
  // setTriggerModeBarcode only pays the multi-second full-rediscovery cost when
  // it's actually needed. Cleared only when a session is truly established (see
  // BarcodeDelegate); re-armed on scanner disappearance / session termination.
  @Volatile private var needsBarcodeRebind: Boolean = true

  // ── Cached radio state (RFD8500 latency fix) ────────────────────────────────
  // Every Config write below is a real Bluetooth round-trip to the sled
  // (~80-300 ms each). Locate-Tag re-asserted trigger-mode + pre-filter +
  // singulation on EVERY trigger pull on the theory that "vendor calls are
  // idempotent, so re-asserting is cheap". On RFD8500 that is false: the
  // re-assert cost ~800 ms of serialised SPP traffic before Inventory.perform()
  // could even run, which is exactly the "geiger lags / doesn't feel instant"
  // symptom. Caching what we last successfully pushed turns a redundant
  // re-assert into a true no-op.
  //
  // Every field is reset in disconnectSync() and re-seeded in
  // connectAndConfigureReader(), so a dropped + re-paired sled can never
  // inherit a stale belief about the radio's state.
  @Volatile private var currentTriggerModeRfid: Boolean? = null
  @Volatile private var currentPrefilterEpc: String? = null
  @Volatile private var currentSessionZero: Boolean? = null

  /// Transmit-power index last written to antenna 1, or -1 for "unknown".
  /// startInventory re-applied power on EVERY start, which is a
  /// getAntennaRfConfig + setAntennaRfConfig pair — two SPP round-trips sitting
  /// between the operator's trigger pull and the radio actually transmitting,
  /// for a value that almost never changes between pulls.
  @Volatile private var currentPowerIdx: Int = -1

  /// Beeper volume last written. Same story: QUIET on every scan start and HIGH
  /// on every stop is another round-trip per pull each way.
  @Volatile private var currentBeeperVolume: BEEPER_VOLUME? = null

  /** True while UHF inventory is streaming. Lets Dart skip redundant starts. */
  fun isInventoryActive(): Boolean = inventoryActive

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
      if (currentTriggerModeRfid == false) {
        Log.d(TAG, "setTriggerModeBarcode: already in BARCODE_MODE, skipping BT config write")
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
        // Only pay the multi-second CoreScanner rediscovery when the session
        // actually needs it (first arm, or after a BT drop / session drop).
        // Running it on EVERY 2D arm was the dominant cause of "switching to
        // 2D takes forever" across the app. needsBarcodeRebind stays true until
        // a session is genuinely established (BarcodeDelegate clears it), so a
        // still-failing session keeps retrying on each arm rather than latching.
        if (needsBarcodeRebind) {
          forceRebindBarcodeScanner()
        }
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
        // Wrapped in silenceModeSwitchBeep so the app-initiated switch is silent
        // (no spurious chime when entering/leaving a 2D-scan screen).
        silenceModeSwitchBeep(r) {
          val accepted = try {
            r.Config.setTriggerMode(ENUM_TRIGGER_MODE.BARCODE_MODE, true)
          } catch (e: Exception) {
            Log.w(TAG, "setTriggerMode(BARCODE_MODE) threw: ${e.message}")
            false
          }
          Log.d(TAG, "setTriggerMode(BARCODE_MODE) returned=$accepted")
          currentTriggerModeRfid = false
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
        }
      } catch (e: Exception) {
        Log.w(TAG, "setTriggerModeBarcode failed: ${e.message}")
        lastError = e.message ?: e.javaClass.simpleName
      }
    }
  }

  /**
   * App-initiated trigger-mode switches (screen enter/leave) should be SILENT —
   * the RFD8500 firmware fires a beeper chime on [Config.setTriggerMode], which
   * operators heard as a spurious "beep when leaving" Bin Assign / Clean Bin /
   * Locate / Cloud+Geiger. The chime obeys beeper volume (the same control the
   * scan-start path uses at ~line 494), so we drop to QUIET_BEEP around the
   * switch and restore HIGH_BEEP (the at-rest level) after a short settle so the
   * next genuine decode still beeps. Best-effort; never throws.
   */
  private fun silenceModeSwitchBeep(r: RFIDReader, block: () -> Unit) {
    setBeeperVolumeCached(r, BEEPER_VOLUME.QUIET_BEEP)
    try {
      block()
    } finally {
      try { Thread.sleep(150) } catch (_: InterruptedException) { /* ignore */ }
      setBeeperVolumeCached(r, BEEPER_VOLUME.HIGH_BEEP)
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
      if (currentTriggerModeRfid == true) {
        // Already in RFID mode. Skipping saves a setTriggerMode round-trip plus
        // the two setBeeperVolume writes and the 150 ms settle inside
        // silenceModeSwitchBeep — ~400 ms off every Locate-Tag entry, which is
        // the single biggest chunk of the "trigger feels delayed" complaint.
        Log.d(TAG, "setTriggerModeRfid: already in RFID_MODE, skipping BT config write")
        return@execute
      }
      try {
        silenceModeSwitchBeep(r) {
          val accepted = try {
            r.Config.setTriggerMode(ENUM_TRIGGER_MODE.RFID_MODE, true)
          } catch (e: Exception) {
            Log.w(TAG, "setTriggerMode(RFID_MODE) threw: ${e.message}")
            false
          }
          Log.d(TAG, "setTriggerMode(RFID_MODE) returned=$accepted")
          currentTriggerModeRfid = true
          if (!accepted) {
            try {
              r.switchMode()
              Log.d(TAG, "switchMode() invoked as RFID fallback")
            } catch (e: Exception) {
              Log.w(TAG, "switchMode() fallback threw: ${e.message}")
            }
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
      // Link/session is no longer trustworthy — force the next 2D arm to rebind.
      needsBarcodeRebind = true
      if (barcodeScannerId == scannerID) {
        barcodeScannerId = -1
      }
    }

    override fun dcssdkEventCommunicationSessionEstablished(scanner: DCSScannerInfo) {
      barcodeScannerId = scanner.scannerID
      // Session is live — stop paying the rediscovery cost on subsequent arms.
      needsBarcodeRebind = false
      Log.d(TAG, "barcode SDK: sessionEstablished id=${scanner.scannerID} name='${scanner.scannerName}'")
    }

    override fun dcssdkEventCommunicationSessionTerminated(scannerID: Int) {
      Log.d(TAG, "barcode SDK: sessionTerminated id=$scannerID")
      needsBarcodeRebind = true
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
        // Retry the resume so a single transient RFD8500 perform() rejection
        // can't strand the radio stopped with the screen still "scanning".
        resumeInventoryWithRetry(r)
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
        // Idempotent — Dart sometimes drives both
        // RfidVendorChannel.startZebraInventory() AND
        // RfidManager.startLocateScanning() back-to-back (locate-tag
        // does this defensively). Without this check the second call
        // tries to apply power + set beeper volume AFTER the first call
        // has already started Inventory.perform(), which throws
        // OperationFailureException (BUSY) because the radio is now
        // streaming. The visible symptom on the floor was a "the slider
        // does nothing" / "scan beep is wrong" log pattern with the
        // operator's previous power index stuck.
        if (inventoryActive) {
          Log.d(TAG, "startInventoryFlutterResult: already active, no-op")
          mainHandler.post { result.success(null) }
          return@execute
        }
        // Force the antenna config write on the start path rather than
        // trusting the cache. The cache is a latency optimisation for the
        // slider; starting inventory is the one moment where being wrong
        // about the radio's state costs the operator the whole screen.
        currentPowerIdx = -1
        applyTransmitPowerDbm(r)
        // Silence the sled's per-tag beeper ONLY during this active
        // inventory burst. Restored to HIGH in stopInventoryAsync so
        // the sled is back at the resting volume by the time anything
        // outside scan (connect/disconnect chime, power chime) fires.
        setBeeperVolumeCached(r, BEEPER_VOLUME.QUIET_BEEP)
        // Retry the START perform() the same way the resume/stop paths do. A
        // single silent BUSY here used to strand inventoryActive=false — which
        // the eventReadNotify gate then turned into a "scanning but frozen, zero
        // reads" radio. This is the site the encode / encode-and-print screens
        // hit intermittently: their stop→60ms→start clean-restart and the
        // post-chip-write power-cycle re-arm land inside the RFD8500's settle
        // window, where perform() throws OperationFailureException.
        if (resumeInventoryWithRetry(r)) {
          mainHandler.post { result.success(null) }
        } else {
          mainHandler.post {
            result.error("INVENTORY_FAILED", lastError ?: "perform failed", null)
          }
        }
      } catch (e: InvalidUsageException) {
        lastError = e.message ?: e.javaClass.simpleName
        mainHandler.post { result.error("INVENTORY_FAILED", e.message ?: "perform failed", null) }
      } catch (e: OperationFailureException) {
        lastError = e.message ?: e.javaClass.simpleName
        mainHandler.post { result.error("INVENTORY_FAILED", e.message ?: "perform failed", null) }
      }
    }
  }

  /**
   * Resume inventory after a mid-stream reconfigure (power / session / prefilter).
   * The RFD8500 intermittently rejects Inventory.perform() with
   * OperationFailureException when it lands too close to a config write. A single
   * silent failure used to strand inventoryActive=false, which the eventReadNotify
   * gate then turned into a permanently FROZEN geiger/scan (reads dropped, screen
   * still "scanning"). Retry a few times with a short settle; only give up — and
   * record lastError — after every attempt fails. Sets inventoryActive on success.
   */
  private fun resumeInventoryWithRetry(r: RFIDReader, attempts: Int = 4): Boolean {
    for (i in 0 until attempts) {
      try {
        r.Actions.Inventory.perform()
        inventoryActive = true
        if (i > 0) Log.d(TAG, "resumeInventoryWithRetry: perform ok on attempt ${i + 1}")
        return true
      } catch (e: Exception) {
        // e.message is null for essentially every Zebra failure, so the old
        // line ("failed: null") could not tell reader-busy from
        // wrong-trigger-mode from a wedged link. Report what the SDK actually
        // carries, plus the radio state we believed we were in.
        Log.w(
          TAG,
          "resumeInventoryWithRetry: perform ${i + 1}/$attempts failed: " +
            "${e.javaClass.simpleName} msg=${e.message} " +
            "detail=${describeZebraError(e)} connected=${r.isConnected} " +
            "triggerRfid=$currentTriggerModeRfid prefilter=$currentPrefilterEpc " +
            "sessionZero=$currentSessionZero powerIdx=$currentPowerIdx",
        )
        try { Thread.sleep(60) } catch (_: InterruptedException) { /* ignore */ }
      }
    }
    lastError = "resume_perform_failed"
    inventoryActive = false
    return false
  }

  /** Zebra puts its real error detail here, never in [Throwable.message]. */
  private fun describeZebraError(e: Exception): String = when (e) {
    is InvalidUsageException ->
      "info=${runCatching { e.info }.getOrNull()} vendor=${runCatching { e.vendorMessage }.getOrNull()}"
    is OperationFailureException ->
      "status=${runCatching { e.statusDescription }.getOrNull()} " +
        "vendor=${runCatching { e.vendorMessage }.getOrNull()}"
    else -> "-"
  }

  /**
   * Stop inventory reliably. A fire-and-forget stop() with a bare catch used to
   * leave the RFD8500 still transmitting when stop() threw (OperationFailureException
   * issued mid-cycle) — the "reader keeps scanning after the operator toggled the
   * trigger off" symptom on Status Change. stop() is idempotent, so retry a few
   * times; each attempt is cheap.
   */
  private fun stopInventoryWithRetry(r: RFIDReader, attempts: Int = 4): Boolean {
    for (i in 0 until attempts) {
      try {
        r.Actions.Inventory.stop()
        if (i > 0) Log.d(TAG, "stopInventoryWithRetry: stop ok on attempt ${i + 1}")
        return true
      } catch (e: Exception) {
        Log.w(TAG, "stopInventoryWithRetry: stop ${i + 1}/$attempts failed: ${e.message}")
        try { Thread.sleep(50) } catch (_: InterruptedException) { /* ignore */ }
      }
    }
    Log.w(TAG, "stopInventoryWithRetry: all $attempts stops failed — radio may still be transmitting")
    return false
  }

  fun stopInventoryAsync() {
    // Set the gate flag FIRST, inline, so late reads from the SDK buffer are dropped
    // immediately. The actual SDK .stop() call runs on the executor as before but no
    // longer needs to win the race against in-flight tag-read callbacks.
    inventoryActive = false
    executor.execute {
      try {
        reader?.takeIf { it.isConnected }?.let { stopInventoryWithRetry(it) }
      } catch (_: Exception) {
        /* ignore */
      }
      // Restore the sled's resting volume so subsequent firmware chimes
      // (mode change → done elsewhere, disconnect, power) fire audibly,
      // including after a force-close because NVRAM is now HIGH. This
      // is the central guarantee of the at-rest=HIGH policy.
      reader?.takeIf { it.isConnected }?.let {
        setBeeperVolumeCached(it, BEEPER_VOLUME.HIGH_BEEP)
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
    // Run the write on the DEDICATED write executor (never the shared one) and
    // bound it with a hard watchdog. If a half-open BT link makes writeWait hang
    // past writeHardTimeoutMs, we answer Dart `false`, abandon + recreate the
    // write thread, and force a link recovery — so a wedged write can no longer
    // brick the radio and force the operator to restart the app.
    val future = writeExec.submit(
      java.util.concurrent.Callable {
        runCatching { performWriteEpc(tgt, new) }.getOrElse {
          lastError = it.message ?: it.javaClass.simpleName
          false
        }
      },
    )
    writeWatchdog.execute {
      val ok = try {
        future.get(writeHardTimeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)
      } catch (te: java.util.concurrent.TimeoutException) {
        Log.e(
          TAG,
          "writeEpcOnce: HARD TIMEOUT after ${writeHardTimeoutMs}ms — link wedged; " +
            "abandoning write thread + recovering (was target=$tgt new=$new)",
        )
        lastError = "write_hard_timeout"
        future.cancel(true)
        recoverWedgedLink()
        false
      } catch (e: Exception) {
        lastError = e.message ?: e.javaClass.simpleName
        false
      }
      mainHandler.post { result.success(ok) }
    }
  }

  /**
   * Recover from a wedged tag-write. A native BT `writeWait` that hangs past the
   * watchdog cannot be interrupted cooperatively, so we (a) replace the write
   * executor so the next write gets a live thread, and (b) tear the reader link
   * down + rebuild it on the shared executor. Tearing the link is also what
   * unblocks the stuck SDK call on most RFD8500 firmware, letting the abandoned
   * thread finally die. Best-effort; never throws.
   */
  private fun recoverWedgedLink() {
    try { writeExec.shutdownNow() } catch (_: Throwable) { /* ignore */ }
    writeExec = Executors.newSingleThreadExecutor()
    needsBarcodeRebind = true
    inventoryActive = false
    executor.execute {
      try {
        disconnectSync()
        try { Thread.sleep(500) } catch (_: InterruptedException) { /* ignore */ }
        openReaders()
        val r = pickReader()
        if (r != null) {
          reader = r
          connectAndConfigureReader()
          initBarcodeSdkOnce()
          lastError = null
          Log.d(TAG, "recoverWedgedLink: reader reconnected after write wedge")
        } else {
          Log.w(TAG, "recoverWedgedLink: no reader found on reconnect")
        }
      } catch (e: Throwable) {
        lastError = e.message ?: e.javaClass.simpleName
        Log.w(TAG, "recoverWedgedLink: reconnect failed", e)
      }
    }
  }

  fun isReady(): Boolean = reader?.isConnected == true

  /**
   * Achievable power range in integer dBm for the connected RFD8500.
   * Reads `transmitPowerLevelValues`, applies the same divisor heuristic
   * as [applyTransmitPowerDbm] (1 / 10 / 100 → dBm / deci-dBm / centi-dBm),
   * and returns [floorDbm, ceilDbm]. The status-change slider uses this
   * to clamp itself to what the radio can actually accept — pre-fix the
   * slider went 1..30, but RFD8500 firmware floors at ~5 dBm and silently
   * lifted anything below it, so "3 dBm" on the bar matched 5 dBm on the
   * radio. Returns null when the reader isn't connected.
   */
  fun getPowerRangeDbm(): Pair<Int, Int>? {
    val r = reader
    if (r == null || !r.isConnected) return null
    return try {
      val levels = r.ReaderCapabilities.transmitPowerLevelValues
        ?: return null
      if (levels.isEmpty()) return null
      val minRaw = levels.min()
      val maxRaw = levels.max()
      val divisor = when {
        maxRaw <= 33 -> 1
        maxRaw <= 330 -> 10
        else -> 100
      }
      val minDbm = (minRaw + divisor - 1) / divisor // ceil(min) so we don't expose a value the radio can't hit
      val maxDbm = maxRaw / divisor
      Log.d(TAG, "getPowerRangeDbm: minRaw=$minRaw maxRaw=$maxRaw divisor=$divisor -> ${minDbm}..${maxDbm} dBm")
      minDbm to maxDbm
    } catch (e: Exception) {
      Log.w(TAG, "getPowerRangeDbm failed: ${e.message}")
      null
    }
  }

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
    // This routine drives setTransmitPowerIndex directly (boost, power-cycle,
    // verify, restore), so the applyTransmitPowerDbm cache can no longer be
    // trusted. Drop it for the duration and leave it dropped on exit.
    currentPowerIdx = -1
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

    // SDK access-op ceiling. The Zebra Tag Write Guide's 3000ms was the
    // pre-2026-05-29 setting and was the upper bound for writeWait's
    // synchronous wait. 1500ms is still well above the published
    // Gen2 write-cycle (~50ms worst case for EPC bank) plus internal
    // retries; tighter ceiling means failure mode resolves in ~half
    // the time without affecting healthy writes.
    runCatching { r.Config.setAccessOperationWaitTimeout(1500) }
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
      params.writeRetries = 2                 // partial-write recovery; 3 was the original cap-iano default (≥3 per Zebra doc), but 2 still covers the common single-bad-word case and shaves ~200-400ms off the worst-case write window.
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

      // Settle before the power cycle so the tag's charge pump has a
      // moment to finish its (attempted) EEPROM write before we kill
      // RF. 150 → 80 (2026-05-29) → 60ms (2026-06-05) — Gen2 write-cycle
      // finishes within ~50ms typical, so 60ms still covers it.
      Thread.sleep(60)

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
      // RF-off dwell. 600ms (2024) → 300ms → 200ms (2026-06-05); on
      // RFD8500 the chip charge pump drops below operating voltage within
      // ~10ms of RF removal, so 200ms is still a 20× margin for the tag to
      // lose RAM and reboot from EEPROM on the next read. Biggest single
      // contributor to per-write latency on the steady-state pass.
      Log.d(TAG, "power-cycle: dropped from boosted idx=$maxPowerIdx to idx=$minIdx (levels.size=${levels?.size ?: -1}); sleeping 200ms")
      Thread.sleep(200)
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
        // POST-FAIL RESCUE (hardened 2026-05-30)
        // ----
        // Operator hit 6 false-fails out of 43 WRITE_FAILED rows on the
        // 2026-05-29 RFD8500 session; geiger-verified the chips actually
        // wrote. Root cause of those 6: the prior fallback checked only
        // `td != null` to decide `oldStillPresent`, but RFD8500 firmware
        // variants ignore the EPC SELECT filter on `readWait` and return
        // whatever tag is nearest. With another tag in the operator's
        // hand or on a nearby rack, `td != null` was always true →
        // `oldStillPresent` always true → promotion never fired.
        //
        // New logic: read the EPC bank, then INSPECT the returned
        // tag's ID. Three outcomes:
        //   - tagID == oldEpc            → write did not commit, keep verified=false
        //   - tagID == newEpc            → write committed, PROMOTE
        //   - tagID null / something else → SELECT filter didn't fire
        //                                   (firmware quirk); ignore and
        //                                   keep verified=false (conservative)
        //
        // Additionally try a second readWait with `newEpc` as the
        // SELECT mask — on the RFD8500 builds that DO honour the filter,
        // a non-null result for that probe is unambiguous proof the
        // write committed.
        //
        // SPEED (2026-06-05): cap the rescue readWaits at 600ms each (was
        // the 1500ms write-window ceiling). A tag that's present at max
        // verify power answers a readWait in ~50-150ms; the full ceiling
        // only ever elapses when the tag is ABSENT, which on a genuine
        // failure is exactly probe-2 (NEW mask). 600ms is plenty for a
        // present tag and shaves ~1.8s off every genuine write_failed —
        // the dominant contributor to the operator's "5-7s on failures".
        // The rescue LOGIC is unchanged, so false-fail recovery still works.
        runCatching { r.Config.setAccessOperationWaitTimeout(600) }
        val oldNorm = targetEpc.uppercase()
        val newNorm = newEpc.uppercase()
        var rescuedById: String? = null

        runCatching {
          val rp = r.Actions.TagAccess.ReadAccessParams()
          rp.accessPassword = 0L
          rp.memoryBank = com.zebra.rfid.api3.MEMORY_BANK.MEMORY_BANK_EPC
          rp.offset = 2
          rp.count = 6
          val td = r.Actions.TagAccess.readWait(targetEpc, rp, null)
          val id = td?.getTagID()?.trim()?.uppercase()
          val mem = td?.getMemoryBankData() ?: "<null>"
          Log.d(TAG, "post-fail diag: readWait(EPC bank, ptr=2, cnt=6) tagID=$id memBank='$mem' (expected new=$newNorm, else old=$oldNorm)")
          when (id) {
            newNorm -> {
              rescuedById = "readWait-old-mask-returned-new"
              Log.d(TAG, "post-fail rescue: readWait with OLD filter returned NEW tagID — SELECT was ignored by firmware but the chip is now broadcasting newEpc")
            }
            oldNorm -> {
              Log.d(TAG, "post-fail diag: tag still broadcasting OLD EPC; write did not commit")
            }
            null -> {
              Log.d(TAG, "post-fail diag: readWait returned no tag; SELECT may have filtered out the rewritten chip (success-shape signal)")
            }
            else -> {
              Log.d(TAG, "post-fail diag: readWait returned a third-party tag (id=$id); SELECT filter wasn't honoured on this firmware")
            }
          }
        }.onFailure { Log.w(TAG, "post-fail diag: EPC read threw: ${it.message}") }

        // Positive probe — explicitly ask for the NEW EPC. If any tag
        // matches that filter (or, on filter-ignoring firmware, the
        // returned tagID happens to be newEpc), the chip definitely
        // wrote.
        if (rescuedById == null) {
          runCatching {
            val rp = r.Actions.TagAccess.ReadAccessParams()
            rp.accessPassword = 0L
            rp.memoryBank = com.zebra.rfid.api3.MEMORY_BANK.MEMORY_BANK_EPC
            rp.offset = 2
            rp.count = 6
            val td = r.Actions.TagAccess.readWait(newEpc, rp, null)
            val id = td?.getTagID()?.trim()?.uppercase()
            Log.d(TAG, "post-fail probe: readWait(NEW EPC select) tagID=$id")
            if (id == newNorm) {
              rescuedById = "readWait-new-mask-confirmed"
              Log.d(TAG, "post-fail rescue: readWait with NEW filter returned the NEW tagID — write confirmed")
            }
          }.onFailure {
            Log.w(TAG, "post-fail probe (NEW EPC select) threw: ${it.message}")
          }
        }

        // The RESERVED-bank diag probe used to run here as a third
        // readWait — purely informational ("if read-locked, write was
        // probably write-locked too"). It never set rescuedById, so on
        // real failures it just added another ~500-1500ms to a path
        // the operator was already complaining was >10s long. Removed
        // 2026-05-30. If we need that signal back for a specific
        // troubleshooting session, run it manually from the diag UI.

        if (rescuedById != null) {
          Log.d(TAG, "performWriteEpc: verify returned false but rescue path '$rescuedById' confirmed write — promoting to true")
          return true
        }
        // Keep verified=false. The chip is genuinely still broadcasting
        // the old EPC (or we got an ambiguous signal we shouldn't gamble
        // on). Operator can retry the row.
        Log.d(TAG, "performWriteEpc: verify and rescue both inconclusive; reporting writeFailed")
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
          currentPowerIdx = prevPowerIdx
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
  /// timeoutMs lowered 3000 → 1500 on 2026-05-29. A second drop to 600ms
  /// on 2026-05-30 was reverted: operator's re-encode session #37
  /// (2026-05-30) hit 11/11 write_failed where the chip really had
  /// NOT committed but the LIVE catalog still got polluted (via a
  /// separate CSV-upload bug, since fixed). 1500ms is the safe floor:
  /// success still exits on the first matching sighting (~50-150ms
  /// when the tag is touching the antenna at max-power verify), so
  /// in the common case the larger ceiling costs nothing; on a
  /// genuine-failure path the extra ~900ms is the price of certainty.
  private fun verifyEpcWrite(
    r: RFIDReader,
    oldEpc: String,
    newEpc: String,
    timeoutMs: Long = 1500,
    minNewSightings: Int = 1,
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
      // Drain any stale reads still in the SDK buffer from BEFORE the
      // power-cycle. Those reads carry the old EPC and were the source
      // of the false-fail "oldSightings=1" pattern operators kept seeing
      // even when the chip actually had been rewritten. After this loop
      // the buffer is empty and Inventory.perform() below fills it only
      // with fresh post-power-cycle reads.
      try {
        var drainAttempts = 0
        while (drainAttempts < 50) {
          val drained = r.Actions.getReadTags(100)
          if (drained == null || drained.isEmpty()) break
          drainAttempts++
        }
      } catch (_: Exception) { /* ignore — best effort */ }
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
      // Three known scalings for RFIDReader.ReaderCapabilities.transmitPowerLevelValues:
      //   maxRaw <=   33   →  values are dBm directly (RFD-x40 firmware).
      //   maxRaw   ~ 300   →  values are deci-dBm — RFD8500 sled (1 unit = 0.1 dB,
      //                       300 = 30.0 dBm). The previous heuristic lumped this
      //                       in with centi-dBm and reported "3 dBm" picked while
      //                       actually sending idx 300 to the radio → operator
      //                       saw the slider do nothing at low values and the
      //                       diagnostic line confused everything.
      //   maxRaw >  330    →  values are centi-dBm (1 unit = 0.01 dB, 3000 = 30 dBm).
      val (divisor, unit) = when {
        maxRaw <= 33 -> 1 to "dBm"
        maxRaw <= 330 -> 10 to "deci-dBm"
        else -> 100 to "centi-dBm"
      }
      if (idx == currentPowerIdx) {
        // Already there. Skipping saves the get/set pair — the single biggest
        // avoidable chunk of trigger-to-transmit latency on a repeat scan.
        return true
      }
      val pickedRaw = levels[idx]
      val pickedDbm = pickedRaw / divisor
      val config = r.Config.Antennas.getAntennaRfConfig(1)
      config.setTransmitPowerIndex(idx)
      // Do NOT touch Tari or rfModeTableIndex on RFD8500 — setTari(0) was
      // throwing OperationFailureException and rolling back the whole
      // config write (the operator's power change with it). Leave both
      // fields at whatever the radio's region profile chose at connect
      // time; we only want the power index here.
      r.Config.Antennas.setAntennaRfConfig(1, config)
      currentPowerIdx = idx
      Log.d(
        TAG,
        "applyTransmitPowerDbm: tgt=${tgt}dBm idx=$idx picked=${pickedDbm}dBm (raw=$pickedRaw $unit) levelsLen=${levels.size}",
      )
      true
    } catch (e: Exception) {
      Log.w(TAG, "applyTransmitPowerDbm failed: ${e.javaClass.simpleName}: ${e.message}")
      lastError = e.message ?: e.javaClass.simpleName
      currentPowerIdx = -1
      false
    }
  }

  /**
   * Write the sled's beeper volume only when it isn't already there. Each write
   * is an SPP round-trip, and the scan-start/scan-stop pair fired one every
   * time regardless of the current state.
   */
  private fun setBeeperVolumeCached(r: RFIDReader, volume: BEEPER_VOLUME) {
    if (currentBeeperVolume == volume) return
    try {
      r.Config.setBeeperVolume(volume)
      currentBeeperVolume = volume
      Log.d(TAG, "BeeperVolume -> $volume")
    } catch (e: Exception) {
      Log.w(TAG, "setBeeperVolume($volume) failed: ${e.message}")
      currentBeeperVolume = null
    }
  }

  private fun indexClosestToDbm(levels: IntArray, targetDbm: Int): Int {
    val tgt = targetDbm.coerceIn(0, 30)
    val maxRaw = levels.maxOrNull() ?: return 0
    val divisor = when {
      maxRaw <= 33 -> 1
      maxRaw <= 330 -> 10
      else -> 100
    }
    var bestIdx = 0
    var bestErr = Int.MAX_VALUE
    for (i in levels.indices) {
      val v = levels[i]
      val dbm = v / divisor
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
      setBeeperVolumeCached(rJustConnected, BEEPER_VOLUME.HIGH_BEEP)
    }
    val triggerInfo = TriggerInfo()
    triggerInfo.StartTrigger.setTriggerType(START_TRIGGER_TYPE.START_TRIGGER_TYPE_IMMEDIATE)
    triggerInfo.StopTrigger.setTriggerType(STOP_TRIGGER_TYPE.STOP_TRIGGER_TYPE_IMMEDIATE)

    // Everything below is CONFIGURATION, not connection. It used to run bare,
    // so a single rejected config write threw straight out of here into
    // connectAsync's catch, which called disconnectSync() and tore down a link
    // that had actually connected fine. The operator then had no reader at
    // all: no connect chime, no trigger events (the sled is the only source of
    // those on a non-Chainway host), and every scan failing NOT_CONNECTED —
    // three symptoms from one rejected call.
    //
    // This sled is known to reject config operations: SESSION_S1 came back
    // OperationFailureException in a 2026-08-28 log. applyOptionalSingulation
    // Control below already survives that; the calls here did not.
    //
    // A reader connected but imperfectly configured is far more useful than no
    // reader, so each step is now independent and failures are loud but not
    // fatal.
    if (eventHandler == null) {
      eventHandler = ZebraEventHandler()
    }
    // The events listener is the one genuinely load-bearing piece — without it
    // no tag reads and no trigger events reach us — so it is still allowed to
    // fail the connect.
    r.Events.addEventsListener(eventHandler)
    runCatching { r.Events.setHandheldEvent(true) }
      .onFailure { Log.w(TAG, "connect: setHandheldEvent rejected: ${it.message}") }
    runCatching { r.Events.setTagReadEvent(true) }
      .onFailure { Log.w(TAG, "connect: setTagReadEvent rejected: ${it.message}") }
    runCatching { r.Events.setAttachTagDataWithReadEvent(false) }
      .onFailure { Log.w(TAG, "connect: setAttachTagData rejected: ${it.message}") }
    runCatching {
      r.Config.setTriggerMode(ENUM_TRIGGER_MODE.RFID_MODE, true)
      currentTriggerModeRfid = true
    }.onFailure {
      // Leave the cache null, not true: we do not know what mode the sled is
      // in, so the next explicit request must actually write rather than be
      // skipped as redundant.
      currentTriggerModeRfid = null
      Log.w(TAG, "connect: setTriggerMode(RFID) rejected: ${it.message} — trigger may fire the imager")
    }
    runCatching { r.Config.setStartTrigger(triggerInfo.StartTrigger) }
      .onFailure { Log.w(TAG, "connect: setStartTrigger rejected: ${it.message}") }
    runCatching { r.Config.setStopTrigger(triggerInfo.StopTrigger) }
      .onFailure { Log.w(TAG, "connect: setStopTrigger rejected: ${it.message}") }

    applyTransmitPowerDbm(r)

    // Singulation-control setup is an optimization, not a requirement.
    // Some RFD8500 firmware revisions reject SESSION_S1 + INVENTORY_STATE_A + SL_ALL
    // as a combo with OperationFailureException and no recoverable detail. When that
    // happens, fall back to S0, then to the reader's defaults — we'd rather read
    // tags at suboptimal singulation than refuse to connect at all.
    applyOptionalSingulationControl(r)
    try {
      r.Actions.PreFilters.deleteAll()
      currentPrefilterEpc = null
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
        currentSessionZero = session == SESSION.SESSION_S0
        return
      } catch (e: Exception) {
        Log.w(TAG, "singulation: $session rejected (${e.message}); trying next")
      }
    }
    // Unknown state — leave the cache null so the next explicit request always
    // writes rather than trusting a belief we never established.
    currentSessionZero = null
    Log.w(TAG, "singulation: all fallbacks rejected — using reader defaults")
  }

  /**
   * Install (or clear) a Zebra PreFilter that gates inventory to the
   * single target EPC. The radio's per-cycle time slots are normally
   * shared across every tag in the field — in a warehouse with 400+
   * tags visible the locate target ends up with only a few reads per
   * second AND wildly variable RSSI (multipath dips between competing
   * tag responses). With the PreFilter installed, non-matching tags
   * are pushed into inventory state B and stop responding; the radio
   * dedicates all its slots to the target → 100+ reads/sec, dense and
   * consistent RSSI, no fading from cross-talk. Cleared on exit so
   * other screens see the full field.
   */
  fun setEpcInventoryFilter(
    epcHex: String?,
    result: MethodChannel.Result,
    force: Boolean = false,
  ) {
    executor.execute {
      try {
        val r = reader
        if (r == null || !r.isConnected) {
          mainHandler.post { result.success(false) }
          return@execute
        }
        val cleanEpc = epcHex?.trim()?.uppercase()?.replace(Regex("[^0-9A-F]"), "")
          ?.takeIf { it.length == 24 }
        if (!force && currentPrefilterEpc == cleanEpc) {
          // Same filter already installed. Skipping avoids stop + deleteAll +
          // add — three SPP round-trips — on every Locate-Tag trigger pull.
          Log.d(TAG, "setEpcInventoryFilter: already ${cleanEpc ?: "cleared"}, skipping")
          mainHandler.post { result.success(true) }
          return@execute
        }
        val wasActive = inventoryActive
        if (wasActive) {
          try { r.Actions.Inventory.stop() } catch (_: Exception) {}
          inventoryActive = false
        }
        runCatching { r.Actions.PreFilters.deleteAll() }
          .onFailure { Log.w(TAG, "PreFilters.deleteAll ignored: ${it.message}") }
        currentPrefilterEpc = null
        var addedOk = false
        if (cleanEpc != null) {
          try {
            val pf = r.Actions.PreFilters.PreFilter()
            pf.setMemoryBank(com.zebra.rfid.api3.MEMORY_BANK.MEMORY_BANK_EPC)
            pf.setTagPattern(cleanEpc)
            pf.setBitOffset(32) // skip CRC (16) + PC (16)
            pf.setTagPatternBitCount(96)
            pf.setFilterAction(com.zebra.rfid.api3.FILTER_ACTION.FILTER_ACTION_STATE_AWARE)
            pf.StateAwareAction.setTarget(com.zebra.rfid.api3.TARGET.TARGET_INVENTORIED_STATE_S0)
            pf.StateAwareAction.setStateAwareAction(
              com.zebra.rfid.api3.STATE_AWARE_ACTION.STATE_AWARE_ACTION_INV_A_NOT_INV_B,
            )
            r.Actions.PreFilters.add(pf)
            addedOk = true
            currentPrefilterEpc = cleanEpc
            Log.d(TAG, "setEpcInventoryFilter: installed pre-filter for $cleanEpc (match→A, others→B)")
          } catch (e: Exception) {
            Log.w(TAG, "setEpcInventoryFilter: add failed: ${e.javaClass.simpleName}: ${e.message}")
          }
        } else {
          Log.d(TAG, "setEpcInventoryFilter: cleared (epc=null or invalid)")
          addedOk = true
        }
        if (wasActive) {
          resumeInventoryWithRetry(r)
        }
        mainHandler.post { result.success(addedOk) }
      } catch (e: Exception) {
        Log.w(TAG, "setEpcInventoryFilter threw: ${e.message}")
        mainHandler.post { result.success(false) }
      }
    }
  }

  /**
   * Runtime session flip. Locate-Tag needs SESSION_S0 (tag responds on
   * every query, no B-state quiet period) so the proximity meter
   * actually tracks distance instead of bouncing every few seconds
   * while the tag is in S1's silent state. All other screens use the
   * default S1 picked at connect (better inventory throughput for
   * multi-tag passes).
   *
   * Stops in-flight inventory before reconfiguring — Zebra throws
   * OperationFailureException if you setSingulationControl while a
   * stream is running.
   */
  fun setSingulationSession(
    useSessionZero: Boolean,
    result: MethodChannel.Result,
    force: Boolean = false,
  ) {
    executor.execute {
      try {
        val r = reader
        if (r == null || !r.isConnected) {
          mainHandler.post { result.success(false) }
          return@execute
        }
        if (!force && currentSessionZero == useSessionZero) {
          // Already on the requested session — skip the get/set round-trips.
          Log.d(TAG, "setSingulationSession: already S${if (useSessionZero) 0 else 1}, skipping")
          mainHandler.post { result.success(true) }
          return@execute
        }
        val wasActive = inventoryActive
        if (wasActive) {
          try { r.Actions.Inventory.stop() } catch (_: Exception) {}
          inventoryActive = false
        }
        val target = if (useSessionZero) SESSION.SESSION_S0 else SESSION.SESSION_S1
        var ok = false
        try {
          val sing = r.Config.Antennas.getSingulationControl(1)
          sing.setSession(target)
          sing.Action.setInventoryState(INVENTORY_STATE.INVENTORY_STATE_A)
          sing.Action.setSLFlag(SL_FLAG.SL_ALL)
          r.Config.Antennas.setSingulationControl(1, sing)
          Log.d(TAG, "setSingulationSession: $target accepted")
          currentSessionZero = useSessionZero
          ok = true
        } catch (e: Exception) {
          Log.w(TAG, "setSingulationSession: $target rejected (${e.javaClass.simpleName}: ${e.message})")
        }
        if (wasActive) {
          resumeInventoryWithRetry(r)
        }
        mainHandler.post { result.success(ok) }
      } catch (e: Exception) {
        Log.w(TAG, "setSingulationSession threw: ${e.message}")
        mainHandler.post { result.success(false) }
      }
    }
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
    // Drop every cached belief about the radio — a re-paired sled starts from
    // firmware defaults, so trusting the old cache would skip config writes the
    // new link genuinely needs.
    currentTriggerModeRfid = null
    currentPrefilterEpc = null
    currentSessionZero = null
    currentPowerIdx = -1
    currentBeeperVolume = null

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

  /**
   * Emit one read-event's worth of tags as a SINGLE Flutter message.
   *
   * The previous shape was one `mainHandler.post` + one EventChannel message
   * per tag. With a Locate pre-filter and SESSION_S0 the RFD8500 reports a
   * single tag 200-400 times a second, so that was several hundred main-thread
   * runnables per second, each with its own map encode, channel hop and Dart
   * decode. The queue backed up, and a backed-up queue is latency the operator
   * feels directly as the meter lagging their hand.
   *
   * Batching collapses that to one hop per read event. The Dart side accepts
   * both shapes, so nothing that consumed single maps had to change.
   *
   * NOTE: deliberately NO per-tag Log.d here either — one logcat write per read
   * saturated the log buffer, and ScannerLogcatBridge (which tails the WHOLE
   * system log) then had to regex-scan every one of those lines.
   */
  private fun emitTags(tags: Array<TagData>) {
    val sink = tagSink ?: return
    val payload = ArrayList<Map<String, Any?>>(tags.size)
    for (t in tags) {
      val id = t.getTagID() ?: continue
      if (id.isBlank()) continue
      val rssiRaw = try {
        t.getPeakRSSI().toInt()
      } catch (_: Exception) {
        null
      }
      // Peak RSSI is a negative dBm figure. Some firmware revisions report 0
      // (or a positive value) when the reading is unavailable — passing that
      // through made the Locate screen compute 100 % proximity for a tag that
      // might be metres away, the "meter pins at full and never drops"
      // symptom. Anything outside a plausible UHF window is "no RSSI".
      val rssi = rssiRaw?.takeIf { it < 0 && it > -110 }
      // Native-originated per-tag beep — fired here so audio feedback does not
      // wait on Dart scheduling. Falls back to -56 for volume only; the WIRE
      // payload keeps null so the Locate screen can take its own no-RSSI path.
      ScanSoundPool.shared?.playTagBeep(normalizeRssi(rssi ?: -56))
      payload.add(mapOf("epc" to id.trim().uppercase(), "rssi" to rssi))
    }
    if (payload.isEmpty()) return
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
      if (tags == null || tags.isEmpty()) return
      emitTags(tags)
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
