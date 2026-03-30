import 'dart:async';

import 'package:flutter/foundation.dart';

import 'package:carbon_wms/hardware/rfid_scanner.dart';
import 'package:carbon_wms/services/handheld_runtime_config.dart';

/// Stub: Zebra API3 + Bluetooth stack will replace this implementation.
class ZebraScanner implements RfidScanner {
  ZebraScanner() : _epc = StreamController<String>.broadcast();

  final StreamController<String> _epc;
  bool _connected = false;
  bool _scanning = false;
  HandheldRuntimeConfig _runtime = HandheldRuntimeConfig.fallback;

  @override
  Future<void> applyHandheldRuntimeSettings(
    HandheldRuntimeConfig config, {
    String scanContext = 'TRANSFER',
  }) async {
    _runtime = config;
    final useOut =
        config.transferOutPowerLock && scanContext.toUpperCase().contains('TRANSFER');
    final power = useOut ? config.transferOutAntennaPower : config.transferInAntennaPower;
    if (kDebugMode) {
      // ignore: avoid_print
      print(
        '[ZebraScanner] ctx=$scanContext power=$power (outLock=${config.transferOutPowerLock}) '
        'hold=${config.triggerModeHoldRelease}',
      );
    }
  }

  @override
  bool get isConnected => _connected;

  @override
  Stream<String> get epcStream => _epc.stream;

  @override
  Future<void> connect() async {
    await Future<void>.delayed(const Duration(milliseconds: 50));
    _connected = true;
  }

  @override
  Future<void> disconnect() async {
    _scanning = false;
    _connected = false;
  }

  @override
  Future<String> getDeviceId() async => 'ZEBRA_RFD8500_01';

  @override
  Future<void> startScanning() async {
    _scanning = true;
  }

  @override
  Future<void> stopScanning() async {
    _scanning = false;
  }

  void debugEmitEpc(String hex24) {
    if (_connected && _scanning) {
      _epc.add(hex24);
    }
  }

  /// Last applied config (for native API3 wiring).
  HandheldRuntimeConfig get lastRuntime => _runtime;
}
