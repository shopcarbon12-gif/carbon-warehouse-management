package com.shopcarbon.wms

import android.os.Build
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel

/**
 * RFID MethodChannel (`carbon_wms/rfid`) + EventChannel (`carbon_wms/rfid_tag_stream`).
 * Vendor SDKs are optional: when AARs are added, replace NOT_IMPLEMENTED branches with real calls
 * and push maps `{"epc": "HEX24", "rssi": int}` to [tagEventSink].
 */
class MainActivity : FlutterActivity() {
  private var tagEventSink: EventChannel.EventSink? = null

  override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
    super.configureFlutterEngine(flutterEngine)
    val messenger = flutterEngine.dartExecutor.binaryMessenger

    EventChannel(messenger, "carbon_wms/rfid_tag_stream").setStreamHandler(
      object : EventChannel.StreamHandler {
        override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
          tagEventSink = events
        }

        override fun onCancel(arguments: Any?) {
          tagEventSink = null
        }
      },
    )

    MethodChannel(messenger, "carbon_wms/rfid").setMethodCallHandler { call, result ->
      when (call.method) {
        "ping" -> result.success("ok")
        "device.manufacturer" -> result.success(Build.MANUFACTURER ?: "")
        "zebra.sdkPresent" -> result.success(classPresent(ZEBRA_RFID_READER))
        "chainway.sdkPresent" -> result.success(classPresent(CHAINWAY_UHF_A) || classPresent(CHAINWAY_UHF_B))
        "zebra.connect" ->
          when {
            !classPresent(ZEBRA_RFID_READER) ->
              result.error(
                "NO_SDK",
                "Zebra RFID API3 (com.zebra.rfid.api3) not on classpath. Add vendor AAR + Gradle dependency.",
                null,
              )
            else ->
              result.error(
                "NOT_IMPLEMENTED",
                "SDK present: implement reader connection in MainActivity (RFIDReader / Readers).",
                null,
              )
          }
        "zebra.disconnect", "zebra.stopInventory" -> result.success(null)
        "zebra.startInventory" ->
          when {
            !classPresent(ZEBRA_RFID_READER) -> result.error("NO_SDK", "Zebra RFID API3 not present.", null)
            else -> result.error("NOT_IMPLEMENTED", "Wire inventory start; emit EPCs to rfid_tag_stream.", null)
          }
        "chainway.connect" ->
          when {
            !classPresent(CHAINWAY_UHF_A) && !classPresent(CHAINWAY_UHF_B) ->
              result.error(
                "NO_SDK",
                "Chainway deviceapi UHF class not found. Add vendor SDK for your device.",
                null,
              )
            else ->
              result.error(
                "NOT_IMPLEMENTED",
                "Chainway SDK present: implement RFIDWithUHFUART bridge and stream tags.",
                null,
              )
          }
        "chainway.disconnect", "chainway.stopInventory" -> result.success(null)
        "chainway.startInventory" ->
          when {
            !classPresent(CHAINWAY_UHF_A) && !classPresent(CHAINWAY_UHF_B) ->
              result.error("NO_SDK", "Chainway deviceapi not present.", null)
            else -> result.error("NOT_IMPLEMENTED", "Wire UHF inventory start.", null)
          }
        else -> result.notImplemented()
      }
    }
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
    const val CHAINWAY_UHF_A = "com.rscja.deviceapi.RFIDWithUHFUART"
    const val CHAINWAY_UHF_B = "com.rscja.deviceapi.module.RFIDWithUHFUART"
  }
}
