import 'dart:async';

import 'package:carbon_wms/hardware/rfid_tag_read.dart';
import 'package:carbon_wms/services/handheld_runtime_config.dart';

/// Hardware abstraction for RFID sleds (Chainway built-in, Zebra Bluetooth, etc.).
abstract class RfidScanner {
  Future<void> connect();

  Future<void> disconnect();

  Future<void> startScanning();

  Future<void> stopScanning();

  Future<String> getDeviceId();

  /// Raw tag reads including RSSI when the native stack provides it.
  Stream<RfidTagRead> get tagReadStream;

  /// EPC-only view of [tagReadStream] (backward compatible).
  Stream<String> get epcStream => tagReadStream.map((r) => r.epcHex24);

  bool get isConnected;

  /// Apply power / trigger hints from tenant handheld settings (native stack when wired).
  /// [scanContext] matches `RfidManager.scanContext` (e.g. `TRANSFER` uses transfer-out power when locked).
  /// [powerOverrideDbm], when non-null, takes precedence over the config-derived
  /// power — used by per-session screens (Count, Transfer In) whose gear is
  /// authoritative for the duration of the session. Cleared on screen dispose.
  Future<void> applyHandheldRuntimeSettings(
    HandheldRuntimeConfig config, {
    String scanContext = 'TRANSFER',
    int? powerOverrideDbm,
  });

  /// Stop active inventory but keep the reader initialized.
  /// Full teardown (BT disconnect / free()) only happens in [disconnect].
  /// Default delegates to [stopScanning]; concrete scanners may override for efficiency.
  Future<void> pauseScanning() => stopScanning();
}
