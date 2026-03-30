import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';

import 'package:carbon_wms/hardware/rfid_scanner.dart';
import 'package:carbon_wms/hardware/rfid_tag_read.dart';
import 'package:carbon_wms/services/handheld_runtime_config.dart';

/// Stub: Android `MethodChannel` to Chainway RSCJA will replace this implementation.
class ChainwayScanner implements RfidScanner {
  ChainwayScanner() : _reads = StreamController<RfidTagRead>.broadcast();

  final StreamController<RfidTagRead> _reads;
  final Random _rand = Random();
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
        '[ChainwayScanner] ctx=$scanContext power=$power (outLock=${config.transferOutPowerLock}) '
        'hold=${config.triggerModeHoldRelease}',
      );
    }
  }

  @override
  bool get isConnected => _connected;

  @override
  Stream<RfidTagRead> get tagReadStream => _reads.stream;

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
  Future<String> getDeviceId() async => 'CHAINWAY_01';

  @override
  Future<void> startScanning() async {
    _scanning = true;
    // Native layer will push EPCs via channel; stub stays quiet.
  }

  @override
  Future<void> stopScanning() async {
    _scanning = false;
  }

  /// Test hook: simulate a tag read (remove when channel is live).
  void debugEmitEpc(String hex24, {int? rssi}) {
    if (!(_connected && _scanning)) return;
    final read = RfidTagRead.tryParse(
      hex24,
      rssi: rssi ?? -58 - _rand.nextInt(28),
    );
    if (read == null) return;
    _reads.add(read);
  }

  HandheldRuntimeConfig get lastRuntime => _runtime;
}
