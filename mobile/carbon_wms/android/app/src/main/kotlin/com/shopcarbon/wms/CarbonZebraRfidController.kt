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

  /** Requested output power in dBm (0–30), forwarded to the reader’s transmit power table. */
  private val requestedPowerDbm = AtomicInteger(30)

  private var readers: Readers? = null
  private var readersAttached: Boolean = false
  private var reader: RFIDReader? = null
  private var eventHandler: RfidEventsListener? = null
  @Volatile private var lastError: String? = null

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
        disconnectSync()
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
    executor.execute {
      try {
        val r = reader
        if (r == null || !r.isConnected) {
          mainHandler.post { result.error("NOT_CONNECTED", "Zebra reader not connected", null) }
          return@execute
        }
        applyTransmitPowerDbm(r)
        r.Actions.Inventory.perform()
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
      val params = r.Actions.TagAccess.WriteAccessParams()
      params.accessPassword = 0L
      params.memoryBank = com.zebra.rfid.api3.MEMORY_BANK.MEMORY_BANK_EPC
      params.offset = 2                       // skip CRC (word 0) + PC (word 1)
      params.writeDataLength = 6              // 6 words × 16 bits = 96 bits
      params.writeRetries = 1
      params.setWriteData(newEpc)             // hex string — SDK converts to bytes

      r.Actions.TagAccess.writeWait(targetEpc, params, null, null)
      return true
    } catch (e: InvalidUsageException) {
      lastError = e.message ?: e.javaClass.simpleName
      return false
    } catch (e: OperationFailureException) {
      lastError = e.message ?: e.javaClass.simpleName
      return false
    } finally {
      if (wasRunning) {
        try { r.Actions.Inventory.perform() } catch (_: Exception) { /* ignore */ }
      }
    }
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

    val sing = r.Config.Antennas.getSingulationControl(1)
    sing.setSession(SESSION.SESSION_S1)
    sing.Action.setInventoryState(INVENTORY_STATE.INVENTORY_STATE_A)
    sing.Action.setSLFlag(SL_FLAG.SL_ALL)
    r.Config.Antennas.setSingulationControl(1, sing)
    r.Actions.PreFilters.deleteAll()
  }

  private fun disconnectSync() {
    if (readersAttached) {
      try {
        Readers.deattach(this)
      } catch (_: Exception) {
        /* ignore */
      }
      readersAttached = false
    }
    try {
      val r = reader
      if (r != null) {
        val eh = eventHandler
        if (eh != null) {
          try {
            r.Events.removeEventsListener(eh)
          } catch (_: Exception) {
            /* ignore */
          }
        }
        try {
          if (r.isConnected) {
            try {
              r.Actions.Inventory.stop()
            } catch (_: Exception) {
              /* ignore */
            }
            r.disconnect()
          }
        } catch (_: Exception) {
          /* ignore */
        }
      }
    } catch (_: Exception) {
      /* ignore */
    }
    reader = null
    eventHandler = null
    try {
      readers?.Dispose()
    } catch (_: Exception) {
      /* ignore */
    }
    readers = null
  }

  private fun emitTag(epc: String, rssi: Short?) {
    val sink = tagSink ?: return
    val payload =
      mapOf(
        "epc" to epc.trim().uppercase(),
        "rssi" to (rssi?.toInt() ?: -56),
      )
    mainHandler.post { sink.success(payload) }
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
