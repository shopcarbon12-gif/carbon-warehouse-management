import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'package:carbon_wms/hardware/rfid_tag_read.dart';

/// Outcome of attempting a native vendor RFID connection (Android only).
enum RfidNativeConnectResult {
  /// Native layer accepted connect (SDK bridge fully implemented).
  linked,

  /// NO_SDK, NOT_IMPLEMENTED, or non-Android — use Dart stub scanner.
  useStub,

  /// Channel not registered (e.g. iOS / tests).
  missingPlugin,
}

/// Android `MethodChannel` / `EventChannel` for Zebra API3 and Chainway UHF (optional vendor AARs).
class RfidVendorChannel {
  RfidVendorChannel._();

  static const MethodChannel _method = MethodChannel('carbon_wms/rfid');
  static const EventChannel _events = EventChannel('carbon_wms/rfid_tag_stream');

  static Future<String?> ping() async {
    try {
      return await _method.invokeMethod<String>('ping');
    } on MissingPluginException {
      return null;
    }
  }

  static Future<String?> deviceManufacturer() async {
    if (!_isAndroid) return null;
    try {
      return await _method.invokeMethod<String>('device.manufacturer');
    } on MissingPluginException {
      return null;
    }
  }

  static Future<bool> zebraSdkPresent() async {
    if (!_isAndroid) return false;
    try {
      final v = await _method.invokeMethod<bool>('zebra.sdkPresent');
      return v == true;
    } on MissingPluginException {
      return false;
    }
  }

  static Future<bool> chainwaySdkPresent() async {
    if (!_isAndroid) return false;
    try {
      final v = await _method.invokeMethod<bool>('chainway.sdkPresent');
      return v == true;
    } on MissingPluginException {
      return false;
    }
  }

  /// Optional [readerName] substring to pick one reader when multiple are paired (e.g. `RFD8500`).
  static Future<RfidNativeConnectResult> connectZebra({String? readerName}) async {
    if (!_isAndroid) return RfidNativeConnectResult.useStub;
    try {
      await _method.invokeMethod<void>('zebra.connect', <String, dynamic>{
        if (readerName != null && readerName.trim().isNotEmpty) 'readerName': readerName.trim(),
      });
      return RfidNativeConnectResult.linked;
    } on PlatformException catch (e) {
      if (e.code == 'NO_SDK' || e.code == 'NOT_IMPLEMENTED') {
        return RfidNativeConnectResult.useStub;
      }
      if (kDebugMode) {
        // ignore: avoid_print
        print('[RfidVendorChannel] zebra.connect: ${e.code} ${e.message}');
      }
      return RfidNativeConnectResult.useStub;
    } on MissingPluginException {
      return RfidNativeConnectResult.missingPlugin;
    }
  }

  static Future<RfidNativeConnectResult> connectChainway() async {
    if (!_isAndroid) return RfidNativeConnectResult.useStub;
    try {
      await _method.invokeMethod<void>('chainway.connect');
      return RfidNativeConnectResult.linked;
    } on PlatformException catch (e) {
      if (e.code == 'NO_SDK' || e.code == 'NOT_IMPLEMENTED') {
        return RfidNativeConnectResult.useStub;
      }
      return RfidNativeConnectResult.useStub;
    } on MissingPluginException {
      return RfidNativeConnectResult.missingPlugin;
    }
  }

  static Future<void> disconnectZebra() async {
    if (!_isAndroid) return;
    try {
      await _method.invokeMethod<void>('zebra.disconnect');
    } catch (_) {}
  }

  static Future<void> disconnectChainway() async {
    if (!_isAndroid) return;
    try {
      await _method.invokeMethod<void>('chainway.disconnect');
    } catch (_) {}
  }

  static Future<void> startZebraInventory() async {
    if (!_isAndroid) return;
    await _method.invokeMethod<void>('zebra.startInventory');
  }

  static Future<void> stopZebraInventory() async {
    if (!_isAndroid) return;
    try {
      await _method.invokeMethod<void>('zebra.stopInventory');
    } catch (_) {}
  }

  static Future<void> startChainwayInventory() async {
    if (!_isAndroid) return;
    await _method.invokeMethod<void>('chainway.startInventory');
  }

  static Future<void> stopChainwayInventory() async {
    if (!_isAndroid) return;
    try {
      await _method.invokeMethod<void>('chainway.stopInventory');
    } catch (_) {}
  }

  /// Tag reads from native layer (`epc` hex string, optional `rssi`).
  static Stream<RfidTagRead> tagReadStream() {
    return _events.receiveBroadcastStream().map((dynamic e) {
      if (e is! Map) return null;
      final m = Map<String, dynamic>.from(e);
      final hex = m['epc']?.toString().trim().toUpperCase() ?? '';
      final rssi = m['rssi'] is num ? (m['rssi'] as num).round() : null;
      return RfidTagRead.tryParse(hex, rssi: rssi);
    }).where((r) => r != null).cast<RfidTagRead>();
  }

  static bool get _isAndroid => !kIsWeb && defaultTargetPlatform == TargetPlatform.android;
}
