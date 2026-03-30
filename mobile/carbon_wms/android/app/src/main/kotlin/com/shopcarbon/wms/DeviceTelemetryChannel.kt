package com.shopcarbon.wms

import android.bluetooth.BluetoothAdapter
import android.content.Context
import android.net.wifi.WifiManager
import android.os.Build
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * Best-effort Wi‑Fi / Bluetooth MAC for WMS device binding (OEM-dependent; often blocked on newer Android).
 */
object DeviceTelemetryChannel {
  private const val CHANNEL = "carbon_wms/device_telemetry"

  fun register(flutterEngine: FlutterEngine, context: Context) {
    val app = context.applicationContext
    MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL).setMethodCallHandler { call, result ->
      when (call.method) {
        "snapshot" -> {
          val out = HashMap<String, String>()
          try {
            @Suppress("DEPRECATION")
            val wm = app.getSystemService(Context.WIFI_SERVICE) as WifiManager
            @Suppress("DEPRECATION")
            val mac = wm.connectionInfo?.macAddress?.trim().orEmpty()
            if (mac.isNotEmpty() && !mac.equals("02:00:00:00:00:00", ignoreCase = true)) {
              out["wifiMac"] = mac.uppercase()
            }
          } catch (_: Exception) {
            /* ignore */
          }
          try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
              @Suppress("DEPRECATION")
              val a = BluetoothAdapter.getDefaultAdapter()
              @Suppress("DEPRECATION")
              val bm = a?.address?.trim().orEmpty()
              if (bm.isNotEmpty() && !bm.equals("02:00:00:00:00:00", ignoreCase = true)) {
                out["bluetoothMac"] = bm.uppercase()
              }
            }
          } catch (_: Exception) {
            /* ignore */
          }
          try {
            val inc = Build.VERSION.INCREMENTAL?.trim().orEmpty()
            if (inc.isNotEmpty()) {
              out["incremental"] = inc
            }
            val fp = Build.FINGERPRINT?.trim().orEmpty()
            if (fp.isNotEmpty()) {
              out["fingerprint"] = fp
            }
            val radio = Build.getRadioVersion()?.trim().orEmpty()
            if (radio.isNotEmpty()) {
              out["radioVersion"] = radio
            }
          } catch (_: Exception) {
            /* ignore */
          }
          result.success(out)
        }
        else -> result.notImplemented()
      }
    }
  }
}
