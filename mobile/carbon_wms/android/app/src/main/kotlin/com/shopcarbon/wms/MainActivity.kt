package com.shopcarbon.wms

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * Placeholder channel for future Zebra / Chainway vendor SDK bridges.
 * Dart: [RfidVendorChannel] (`carbon_wms/rfid`).
 */
class MainActivity : FlutterActivity() {
  override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
    super.configureFlutterEngine(flutterEngine)
    MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "carbon_wms/rfid").setMethodCallHandler { call, result ->
      when (call.method) {
        "ping" -> result.success("ok")
        else -> result.notImplemented()
      }
    }
  }
}
