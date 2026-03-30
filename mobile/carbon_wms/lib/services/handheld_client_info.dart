import 'dart:io' show Platform;

import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:package_info_plus/package_info_plus.dart';

/// Fingerprint sent with [WmsApiClient.postDevicePing] so WMS can match a physical unit
/// (serial, Wi‑Fi MAC, radio/baseband, etc.). Best-effort: many fields are OEM-dependent.
class HandheldClientInfo {
  HandheldClientInfo._();

  static const _telemetry = MethodChannel('carbon_wms/device_telemetry');

  static Future<Map<String, dynamic>> collect() async {
    if (kIsWeb || !Platform.isAndroid) {
      return {};
    }
    final out = <String, dynamic>{};
    try {
      final pkg = await PackageInfo.fromPlatform();
      out['appVersion'] = '${pkg.version}+${pkg.buildNumber}';
    } catch (_) {}
    try {
      final di = DeviceInfoPlugin();
      final a = await di.androidInfo;
      out['manufacturer'] = a.manufacturer;
      out['model'] = a.model;
      out['brand'] = a.brand;
      out['product'] = a.product;
      out['device'] = a.device;
      out['hardware'] = a.hardware;
      out['androidRelease'] = a.version.release;
      out['sdkInt'] = a.version.sdkInt;
      final serial = a.serialNumber;
      if (serial.isNotEmpty && serial != 'unknown') {
        out['serialNumber'] = serial;
      }
    } catch (_) {}
    try {
      final snap = await _telemetry.invokeMethod<dynamic>('snapshot');
      if (snap is Map) {
        for (final key in <String>[
          'wifiMac',
          'bluetoothMac',
          'radioVersion',
          'fingerprint',
          'incremental',
        ]) {
          final v = snap[key]?.toString();
          if (v != null && v.isNotEmpty) {
            out[key] = v;
          }
        }
      }
    } catch (_) {}
    return out;
  }
}
