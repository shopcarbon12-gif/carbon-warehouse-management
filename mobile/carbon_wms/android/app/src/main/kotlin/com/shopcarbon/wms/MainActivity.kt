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
  private var senitronBridge: SenitronPluginBridge? = null


  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    startService(Intent(this, TaskRemovedSessionService::class.java))
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
    MainActivity.chainwayController = chainway
    hardwareBarcodeRelay = barcodeRelay
    hardwareTriggerRelay = triggerRelay

    EventChannel(messenger, "carbon_wms/hardware_barcode").setStreamHandler(barcodeRelay)
    EventChannel(messenger, "carbon_wms/hardware_trigger").setStreamHandler(triggerRelay)

    val bridge = SenitronPluginBridge(this)
    senitronBridge = bridge
    MainActivity.senitronBridge = bridge

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
          // Do NOT stop the logcat bridge on cancel — it must keep reading hqs:V lines
          // so EPCs are available when the stream is re-subscribed (e.g. screen re-enters).
        }
      },
    )

    MethodChannel(messenger, "carbon_wms/rfid").setMethodCallHandler { call, result ->
      when (call.method) {
        "ping" -> result.success("ok")
        "device.manufacturer" -> result.success(Build.MANUFACTURER ?: "")
        "zebra.sdkPresent" -> result.success(classPresent(ZEBRA_RFID_READER))
        "chainway.sdkPresent" -> {
          val c = chainway.resolveUhfClass()
          result.success(c != null)
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
          val chainwaySdk = chainway.resolveUhfClass() != null
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
          senitronBridge?.clearSeenEpcs()
          result.success(null)
        }
        "chainway.startInventory" -> {
          if (chainway.resolveUhfClass() == null) {
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
        else -> result.notImplemented()
      }
    }
  }

  override fun onDestroy() {
    if (!isChangingConfigurations && isFinishing) {
      SessionPrefsBridge.clearWmsSessionToken(this)
    }
    zebraController?.dispose()
    chainwayController?.dispose()
    hardwareBarcodeRelay?.dispose()
    hardwareTriggerRelay?.dispose()
    senitronBridge?.dispose()
    hardwareBarcodeRelay = null
    hardwareTriggerRelay = null
    zebraController = null
    chainwayController = null
    senitronBridge = null
    MainActivity.chainwayController = null
    MainActivity.senitronBridge = null
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
    const val ZEBRA_RFID_READER = "com.zebra.rfid.api3.RFIDReader"
    private const val SCANNER_PACKAGE = "com.rscja.scanner"
    @Volatile var chainwayController: CarbonChainwayRfidController? = null
    @Volatile var senitronBridge: SenitronPluginBridge? = null

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
      "android.intent.action.BARCODELOCKSCANKEY",
    )

    private val SCANNER_2D_ENABLE_ACTIONS = listOf(
      "ACTION_2DS_ENABLE",
      "android.intent.action.BARCODEUNLOCKSCANKEY",
    )
  }
}
