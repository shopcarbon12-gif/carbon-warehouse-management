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

  /// Operator-friendly handheld name for the cycle-count workspace
  /// source filter. Prefers the build's `brand` + `model` ("Samsung
  /// SM-S938U" → reads as "Samsung S938U" in the dropdown), falling
  /// back to the raw model when brand is empty (Chainway units
  /// usually have just a model). Returns an empty string on iOS /
  /// web / failure so the server's "mobile" default kicks in.
  static Future<String> displayName() async {
    if (kIsWeb || !Platform.isAndroid) return '';
    try {
      final a = await DeviceInfoPlugin().androidInfo;
      final brand = a.brand.trim();
      final model = a.model.trim();
      if (brand.isEmpty && model.isEmpty) return '';
      if (brand.isEmpty) return model;
      if (model.isEmpty) return brand;
      // "samsung" + "SM-S938U" → "Samsung SM-S938U"
      final brandPretty = brand.length > 1
          ? '${brand[0].toUpperCase()}${brand.substring(1).toLowerCase()}'
          : brand.toUpperCase();
      // Strip the brand prefix from the model if it already includes it.
      final modelStripped =
          model.toLowerCase().startsWith(brand.toLowerCase())
              ? model.substring(brand.length).trim()
              : model;
      return '$brandPretty $modelStripped'.trim();
    } catch (_) {
      return '';
    }
  }

}
