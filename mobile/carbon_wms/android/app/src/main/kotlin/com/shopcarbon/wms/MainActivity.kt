package com.shopcarbon.wms

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel

/**
 * Flutter channels:
 * - [MethodChannel] `carbon_wms/rfid`
 * - [EventChannel] `carbon_wms/rfid_tag_stream` — maps `{"epc","rssi"}` per tag
 */
class MainActivity : FlutterFragmentActivity() {
  private var zebraController: CarbonZebraRfidController? = null
  private var chainwayController: CarbonChainwayRfidController? = null
  private var hardwareBarcodeRelay: CarbonHardwareBarcodeRelay? = null
  private var hardwareTriggerRelay: CarbonHardwareTriggerRelay? = null
  private var scannerLogcatBridge: ScannerLogcatBridge? = null
  private var scanSoundPool: ScanSoundPool? = null


  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    startService(Intent(this, TaskRemovedSessionService::class.java))
    // Request WRITE_EXTERNAL_STORAGE on API <= 28 for KeyboardHelperParam.xml UHF patch
    if (Build.VERSION.SDK_INT <= 28) {
      requestPermissions(
        arrayOf(android.Manifest.permission.WRITE_EXTERNAL_STORAGE),
        REQ_WRITE_STORAGE,
      )
    }
    // Android 12+ requires runtime grant for BT operations used by Zebra SDK
    // (BluetoothAdapter.getBondedDevices throws SecurityException otherwise).
    if (Build.VERSION.SDK_INT >= 31) {
      val needed = arrayOf(
        android.Manifest.permission.BLUETOOTH_CONNECT,
        android.Manifest.permission.BLUETOOTH_SCAN,
      ).filter {
        checkSelfPermission(it) != android.content.pm.PackageManager.PERMISSION_GRANTED
      }.toTypedArray()
      if (needed.isNotEmpty()) {
        requestPermissions(needed, REQ_BLUETOOTH)
      }
    }
  }

  override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
    super.configureFlutterEngine(flutterEngine)
    val messenger = flutterEngine.dartExecutor.binaryMessenger
    DeviceTelemetryChannel.register(flutterEngine, this)

    val zebra = CarbonZebraRfidController(this)
    val chainway = CarbonChainwayRfidController(this)
    val barcodeRelay = CarbonHardwareBarcodeRelay(this)
    val triggerRelay = CarbonHardwareTriggerRelay(this)
    zebraController = zebra
    chainwayController = chainway
    hardwareBarcodeRelay = barcodeRelay
    hardwareTriggerRelay = triggerRelay
    // Zebra controller forwards BarcodeScannerSdk decode events to the same
    // EventChannel that Chainway broadcasts use, so the Dart screens get a
    // single barcode stream regardless of which sled is connected.
    zebra.setBarcodeRelay(barcodeRelay)

    // UART acquisition strategy on C72E MTK firmware:
    //   1. Kill `com.rscja.scanner` (which holds /dev/ttyMT1 exclusive on this firmware,
    //      and `ScannerUtility.disableFunction(FUNCTION_UHF)` is a no-op on MTK so
    //      cooperative eviction doesn't work).
    //   2. Wait briefly for the kernel to release the fd.
    //   3. Open the UART directly via `RFIDWithUHFUART.init(ctx)` and keep it for the
    //      app's lifetime. The reference app does this implicitly at launch; we
    //      have to be explicit because the scanner service auto-restarts after a few seconds.
    // Kill com.rscja.scanner BEFORE acquireUartEarly: on this firmware the
    // scanner service holds /dev/ttyMT1 exclusive, and ScannerUtility's
    // disableFunction() is a no-op stub on MTK. Without the kill, our
    // RFIDWithUHFUART.init may return true but startInventoryTag returns
    // false (silent UART contention). The recovery app gets away without
    // killing because its 5s test runs in a window where scanner happened
    // to be idle; we need this for reliable repeated inventory cycles.
    Thread({
      try {
        val am = getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
        am.killBackgroundProcesses("com.rscja.scanner")
        am.killBackgroundProcesses("com.rscja.ht")
        Log.d("MainActivity", "Killed com.rscja.scanner / com.rscja.ht for UART acquire")
        Thread.sleep(400)
      } catch (t: Throwable) {
        Log.w("MainActivity", "killBackgroundProcesses pre-acquire failed: ${t.message}")
      }
      chainway.acquireUartEarly()
    }, "Carbon-AcquireUart").apply { isDaemon = true }.start()

    // Note: the C72E camera-bound 2D imager wake-up moved out of this
    // activity in 1.2.35. Firing BARCODEUNLOCKSCANKEY at app start was
    // unlocking the system trigger key globally, so the OEM scanner service
    // started auto-firing the 2D laser on every screen — including the
    // login screen. The wake-up now happens lazily when Bin Assign loads
    // (see fast_putaway_screen.dart), which is the only screen that
    // actually needs the imager warm.

    EventChannel(messenger, "carbon_wms/hardware_barcode").setStreamHandler(barcodeRelay)
    EventChannel(messenger, "carbon_wms/hardware_trigger").setStreamHandler(
      object : EventChannel.StreamHandler {
        override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
          triggerRelay.onListen(arguments, events)
          zebra.setTriggerSink(events)
        }
        override fun onCancel(arguments: Any?) {
          triggerRelay.onCancel(arguments)
          zebra.setTriggerSink(null)
        }
      }
    )

    val bridge = ScannerLogcatBridge(this)
    scannerLogcatBridge = bridge
    MainActivity.scannerLogcatBridge = bridge

    // Native android.media.SoundPool bridge for per-tag beep (low-latency fallback).
    val soundPool = ScanSoundPool(this)
    soundPool.register(messenger)
    scanSoundPool = soundPool
    // Process-wide handle so Chainway/Zebra controllers can fire the per-tag
    // beep from inside their emit path (skips the Dart round-trip).
    ScanSoundPool.shared = soundPool

    EventChannel(messenger, "carbon_wms/rfid_tag_stream").setStreamHandler(
      object : EventChannel.StreamHandler {
        override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
          zebra.setTagSink(events)
          chainway.setTagSink(events)
          bridge.tagSink = events
          bridge.start()
        }

        override fun onCancel(arguments: Any?) {
          zebra.setTagSink(null)
          chainway.setTagSink(null)
          bridge.tagSink = null
        }
      },
    )

    MethodChannel(messenger, "carbon_wms/rfid").setMethodCallHandler { call, result ->
      when (call.method) {
        "ping" -> result.success("ok")
        "device.manufacturer" -> result.success(Build.MANUFACTURER ?: "")
        "zebra.sdkPresent" -> result.success(classPresent(ZEBRA_RFID_READER))
        "chainway.sdkPresent" -> {
          // Never call resolveUhfClass() on MTK — it loads DeviceAPIM.so via PathClassLoader
          // which can open /dev/ttyMT1 as a JNI_OnLoad side-effect on some firmware builds.
          // On MTK we run broadcast-only so the SDK presence is irrelevant.
          val isMtk = android.os.Build.HARDWARE.startsWith("mt", ignoreCase = true) ||
                      android.os.Build.BOARD.startsWith("mt", ignoreCase = true)
          val present = if (isMtk) false else (chainway.resolveUhfClass() != null)
          result.success(present)
        }
        "device.openScannerSettings" -> {
          val ok =
            runCatching {
              startActivity(
                Intent().apply {
                  setClassName("com.rscja.scanner", "com.rscja.scanner.ui.MainActivity")
                  addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                },
              )
              true
            }.getOrElse {
              runCatching {
                startActivity(
                  packageManager.getLaunchIntentForPackage("com.rscja.scanner")?.apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                  } ?: error("scanner package not found"),
                )
                true
              }.getOrDefault(false)
            }
          result.success(ok)
        }
        "device.openAndroidAppSettings" -> {
          runCatching {
            startActivity(
              Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.parse("package:$packageName")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
              },
            )
          }
          result.success(true)
        }
        "device.diagnostics" -> {
          val isMtk = Build.HARDWARE.startsWith("mt", ignoreCase = true) ||
                      Build.BOARD.startsWith("mt", ignoreCase = true)
          val chainwaySdk = if (isMtk) false else (chainway.resolveUhfClass() != null)
          val zebraSdk = classPresent(ZEBRA_RFID_READER)
          result.success(
            mapOf(
              "manufacturer" to (Build.MANUFACTURER ?: ""),
              "model" to (Build.MODEL ?: ""),
              "brand" to (Build.BRAND ?: ""),
              "chainwaySdkPresent" to chainwaySdk,
              "zebraSdkPresent" to zebraSdk,
              "chainwayLastError" to chainway.getLastError(),
              "zebraLastError" to zebra.getLastError(),
            ),
          )
        }
        "scanner.start2d" -> {
          hardwareBarcodeRelay?.startHardwareScan()
          result.success(true)
        }
        "scanner.stop2d" -> {
          hardwareBarcodeRelay?.stopHardwareScan()
          result.success(true)
        }
        "scanner.enableTriggerRelay" -> {
          hardwareBarcodeRelay?.activateTriggerRelay()
          result.success(true)
        }
        "scanner.disableTriggerRelay" -> {
          hardwareBarcodeRelay?.deactivateTriggerRelay()
          result.success(true)
        }
        "scanner.enableNativeTrigger" -> {
          chainway.enableNativeTrigger()
          result.success(true)
        }
        "scanner.disableNativeTrigger" -> {
          chainway.disableNativeTrigger()
          result.success(true)
        }
        "scanner.enableRfidFunctionMode" -> {
          enableScannerRfidMode(this, "MainActivity")
          result.success(true)
        }
        "scanner.disableRfidFunctionMode" -> {
          stopSystemScannerInventory(this, "MainActivity")
          disableScannerRfidMode(this, "MainActivity")
          result.success(true)
        }
        "scanner.close2dBarcode" -> {
          closeScanner2dEngine(this, "MainActivity")
          result.success(true)
        }
        "scanner.open2dBarcode" -> {
          openScanner2dEngine(this, "MainActivity")
          result.success(true)
        }
        "zebra.connect" -> {
          val args = call.arguments as? Map<*, *>
          val name = args?.get("readerName") as? String
          chainway.disconnectAsync()
          zebra.setReaderNameHint(name)
          zebra.connectAsync { err ->
            if (err != null) {
              result.error("CONNECT_FAILED", err.message ?: "zebra_connect", null)
            } else {
              result.success(mapOf("ok" to true))
            }
          }
        }
        "zebra.disconnect" -> {
          zebra.disconnectAsync()
          result.success(null)
        }
        "zebra.setTriggerMode2D" -> {
          zebra.setTriggerModeBarcode()
          result.success(null)
        }
        "zebra.setTriggerModeRfid" -> {
          zebra.setTriggerModeRfid()
          result.success(null)
        }
        "zebra.stopInventory" -> {
          zebra.stopInventoryAsync()
          result.success(null)
        }
        "zebra.startInventory" -> {
          if (!classPresent(ZEBRA_RFID_READER)) {
            result.error("NO_SDK", "Zebra RFID API3 not present.", null)
            return@setMethodCallHandler
          }
          zebra.startInventoryFlutterResult(result)
        }
        "chainway.connect" -> {
          zebra.disconnectAsync()
          chainway.connectAsync { err ->
            if (err != null) {
              result.error("CONNECT_FAILED", err.message ?: "chainway_connect", null)
            } else {
              result.success(mapOf("ok" to true))
            }
          }
        }
        "chainway.disconnect" -> {
          chainway.disconnectAsync()
          result.success(null)
        }
        "chainway.stopInventory" -> {
          chainway.stopInventoryAsync()
          result.success(null)
        }
        "chainway.clearSeenEpcs" -> {
          chainway.clearSeenEpcs()
          scannerLogcatBridge?.clearSeenEpcs()
          result.success(null)
        }
        "chainway.startInventory" -> {
          val isMtk = Build.HARDWARE.startsWith("mt", ignoreCase = true) ||
                      Build.BOARD.startsWith("mt", ignoreCase = true)
          // On MTK we run broadcast-only — skip the SDK check entirely to avoid
          // loading DeviceAPIM.so (which can open /dev/ttyMT1 as a JNI_OnLoad side-effect).
          if (!isMtk && chainway.resolveUhfClass() == null) {
            result.error("NO_SDK", "Chainway DeviceAPI not present.", null)
            return@setMethodCallHandler
          }
          chainway.startInventoryFlutterResult(result)
        }
        "rfid.setAntennaPower" -> {
          val args = call.arguments as? Map<*, *>
          val dbm = (args?.get("dbm") as? Number)?.toInt() ?: 30
          val p = dbm.coerceIn(0, 30)
          zebra.setAntennaPowerDbm(p)
          chainway.setAntennaPowerDbm(p)
          result.success(null)
        }
        "rfid.writeEpc" -> {
          val args = call.arguments as? Map<*, *>
          val target = (args?.get("targetEpc") as? String).orEmpty()
          val newEpc = (args?.get("newEpc") as? String).orEmpty()
          if (target.isBlank() || newEpc.isBlank()) {
            result.success(false)
            return@setMethodCallHandler
          }
          // Prefer whichever stack is actively linked. Chainway owns the radio on built-in
          // C72E; Zebra is active on RFD8500 BT sleds. Only one at a time because the
          // connect handlers disconnect the other.
          when {
            zebra.isReady() -> zebra.writeEpcOnce(target, newEpc, result)
            chainway.isReady() -> chainway.writeEpcOnce(target, newEpc, result)
            else -> result.success(false)
          }
        }
        else -> result.notImplemented()
      }
    }
  }

  override fun onDestroy() {
    // Intentionally no SessionPrefsBridge.clearWmsSessionToken call here.
    // The previous condition (`!isChangingConfigurations && isFinishing`) was
    // intended to log the operator out only on explicit back-press / finish().
    // On Samsung One UI the activity can finish for reasons that look benign
    // to the user (system memory pressure, foreground service handoff), and
    // wiping the token there racks up "Dashboard: http 401" right after the
    // next launch because /api/mobile/status is androidId-keyed and doesn't
    // require the Bearer to answer authorized:true. The explicit Logout
    // buttons in DeviceLockScreen / DashboardScreen are the supported way to
    // end the session; the JWT's own 7-day TTL bounds the worst case.
    ScanSoundPool.shared = null
    zebraController?.dispose()
    chainwayController?.dispose()
    hardwareBarcodeRelay?.dispose()
    hardwareTriggerRelay?.dispose()
    scannerLogcatBridge?.dispose()
    hardwareBarcodeRelay = null
    hardwareTriggerRelay = null
    zebraController = null
    chainwayController = null
    scannerLogcatBridge = null
    MainActivity.scannerLogcatBridge = null
    super.onDestroy()
  }

  private fun classPresent(name: String): Boolean =
    try {
      Class.forName(name)
      true
    } catch (_: Throwable) {
      false
    }


  companion object {
    private const val TAG = "MainActivity"
    private const val REQ_WRITE_STORAGE = 1001
    private const val REQ_BLUETOOTH = 1002
    const val ZEBRA_RFID_READER = "com.zebra.rfid.api3.RFIDReader"
    private const val SCANNER_PACKAGE = "com.rscja.scanner"
    @Volatile var scannerLogcatBridge: ScannerLogcatBridge? = null

    fun enableScannerRfidMode(context: Context, logTag: String = TAG) {
      closeScanner2dEngine(context, logTag)
      RFID_MODE_ENABLE_ACTIONS.forEach { action ->
        broadcastScannerAction(context, action, logTag)
      }
      android.os.SystemClock.sleep(80)
    }

    fun disableScannerRfidMode(context: Context, logTag: String = TAG) {
      RFID_MODE_DISABLE_ACTIONS.forEach { action ->
        broadcastScannerAction(context, action, logTag)
      }
      android.os.SystemClock.sleep(80)
    }

    fun startSystemScannerInventory(context: Context, logTag: String = TAG) {
      enableScannerRfidMode(context, logTag)
      RFID_START_ACTIONS.forEach { action ->
        broadcastScannerAction(context, action, logTag)
      }
    }

    fun stopSystemScannerInventory(context: Context, logTag: String = TAG) {
      RFID_STOP_ACTIONS.forEach { action ->
        broadcastScannerAction(context, action, logTag)
      }
    }

    fun closeScanner2dEngine(context: Context, logTag: String = TAG) {
      SCANNER_2D_DISABLE_ACTIONS.forEach { action ->
        broadcastScannerAction(context, action, logTag)
      }
    }

    fun openScanner2dEngine(context: Context, logTag: String = TAG) {
      SCANNER_2D_ENABLE_ACTIONS.forEach { action ->
        broadcastScannerAction(context, action, logTag)
      }
    }

    private fun broadcastScannerAction(context: Context, action: String, logTag: String) {
      listOf(
        Intent(action),
        Intent(action).setPackage(SCANNER_PACKAGE),
      ).forEach { intent ->
        runCatching {
          context.sendBroadcast(
            intent.apply {
              addFlags(Intent.FLAG_INCLUDE_STOPPED_PACKAGES)
            },
          )
          Log.d(logTag, "scanner broadcast -> action=$action pkg=${intent.`package` ?: "*"}")
        }.onFailure { e ->
          Log.w(logTag, "scanner broadcast failed for $action", e)
        }
      }
    }

    private val RFID_MODE_ENABLE_ACTIONS = listOf(
      "android.intent.action.ENABLE_FUNCTION_BARCODE_RFID",
      "com.rscja.scanner.action.ENABLE_FUNCTION_BARCODE_RFID",
    )

    private val RFID_MODE_DISABLE_ACTIONS = listOf(
      "android.intent.action.DISABLE_FUNCTION_BARCODE_RFID",
      "com.rscja.scanner.action.DISABLE_FUNCTION_BARCODE_RFID",
    )

    private val RFID_START_ACTIONS = listOf(
      "android.intent.action.OPEN_BARCODE_RFID",
      "android.intent.action.CONTINUOUS_SCAN_RFID",   // continuous multi-tag inventory
      "com.rscja.scanner.action.START_BARCODE_RFID",
    )

    private val RFID_STOP_ACTIONS = listOf(
      "android.intent.action.STOP_BARCODE_RFID",
      "android.intent.action.CLOSE_BARCODE_RFID",
      "com.rscja.scanner.action.STOP_BARCODE_RFID",
    )

    private val SCANNER_2D_DISABLE_ACTIONS = listOf(
      "ACTION_2DS_DISABLE",
      // BARCODELOCKSCANKEY locks the physical trigger entirely — this blocks UHF scanning too.
      // Do NOT send it when switching to RFID mode.
    )

    private val SCANNER_2D_ENABLE_ACTIONS = listOf(
      "ACTION_2DS_ENABLE",
      "android.intent.action.BARCODEUNLOCKSCANKEY",
    )
  }
}
