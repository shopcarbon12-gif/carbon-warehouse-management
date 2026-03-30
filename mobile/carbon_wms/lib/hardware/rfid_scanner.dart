import 'dart:async';

import 'package:carbon_wms/services/handheld_runtime_config.dart';

/// Hardware abstraction for RFID sleds (Chainway built-in, Zebra Bluetooth, etc.).
abstract class RfidScanner {
  Future<void> connect();

  Future<void> disconnect();

  Future<void> startScanning();

  Future<void> stopScanning();

  Future<String> getDeviceId();

  /// Raw 24-character hex EPC payloads (Carbon WMS on-tag encoding).
  Stream<String> get epcStream;

  bool get isConnected;

  /// Apply power / trigger hints from tenant handheld settings (native stack when wired).
  /// [scanContext] matches `RfidManager.scanContext` (e.g. `TRANSFER` uses transfer-out power when locked).
  Future<void> applyHandheldRuntimeSettings(
    HandheldRuntimeConfig config, {
    String scanContext = 'TRANSFER',
  });
}
