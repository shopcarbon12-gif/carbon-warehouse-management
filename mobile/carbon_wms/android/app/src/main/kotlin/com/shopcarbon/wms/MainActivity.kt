package com.shopcarbon.wms

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
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
    hardwareBarcodeRelay = barcodeRelay
    hardwareTriggerRelay = triggerRelay

    EventChannel(messenger, "carbon_wms/hardware_barcode").setStreamHandler(barcodeRelay)
    EventChannel(messenger, "carbon_wms/hardware_trigger").setStreamHandler(triggerRelay)

    EventChannel(messenger, "carbon_wms/rfid_tag_stream").setStreamHandler(
      object : EventChannel.StreamHandler {
        override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
          zebra.setTagSink(events)
          chainway.setTagSink(events)
        }

        override fun onCancel(arguments: Any?) {
          zebra.setTagSink(null)
          chainway.setTagSink(null)
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
          hardwareBarcodeRelay?.dispose()
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
    hardwareBarcodeRelay = null
    hardwareTriggerRelay = null
    zebraController = null
    chainwayController = null
    super.onDestroy()
  }

  private fun classPresent(name: String): Boolean =
    try {
      Class.forName(name)
      true
    } catch (_: Throwable) {
      false
    }

  private companion object {
    const val ZEBRA_RFID_READER = "com.zebra.rfid.api3.RFIDReader"
  }
}
