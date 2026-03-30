import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';

import 'package:carbon_wms/hardware/rfid_scanner.dart';
import 'package:carbon_wms/hardware/rfid_tag_read.dart';
import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/services/handheld_runtime_config.dart';

/// Tries Android **Zebra RFID API3** via [RfidVendorChannel]; falls back to simulated reads.
class ZebraScanner implements RfidScanner {
  ZebraScanner() : _reads = StreamController<RfidTagRead>.broadcast();

  final StreamController<RfidTagRead> _reads;
  final Random _rand = Random();
  bool _connected = false;
  bool _scanning = false;
  bool _nativeLinked = false;
  StreamSubscription<RfidTagRead>? _nativeSub;
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
  Stream<RfidTagRead> get tagReadStream => _reads.stream;

  @override
  Stream<String> get epcStream => tagReadStream.map((r) => r.epcHex24);

  @override
  Future<void> connect() async {
    await _tryNativeBridge();
    if (!_nativeLinked) {
      await Future<void>.delayed(const Duration(milliseconds: 50));
    }
    _connected = true;
  }

  Future<void> _tryNativeBridge() async {
    if (!(!kIsWeb && defaultTargetPlatform == TargetPlatform.android)) return;
    final r = await RfidVendorChannel.connectZebra();
    if (r != RfidNativeConnectResult.linked) return;
    _nativeLinked = true;
    await _nativeSub?.cancel();
    _nativeSub = RfidVendorChannel.tagReadStream().listen(_reads.add, onError: (_) {});
  }

  @override
  Future<void> disconnect() async {
    _scanning = false;
    _connected = false;
    await _nativeSub?.cancel();
    _nativeSub = null;
    if (_nativeLinked) {
      await RfidVendorChannel.stopZebraInventory();
      await RfidVendorChannel.disconnectZebra();
      _nativeLinked = false;
    }
  }

  @override
  Future<String> getDeviceId() async => 'ZEBRA_RFD8500_01';

  @override
  Future<void> startScanning() async {
    _scanning = true;
    if (_nativeLinked) {
      try {
        await RfidVendorChannel.startZebraInventory();
      } catch (_) {
        /* native bridge optional */
      }
    }
  }

  @override
  Future<void> stopScanning() async {
    _scanning = false;
    if (_nativeLinked) {
      try {
        await RfidVendorChannel.stopZebraInventory();
      } catch (_) {
        /* optional */
      }
    }
  }

  void debugEmitEpc(String hex24, {int? rssi}) {
    if (!(_connected && _scanning)) return;
    final read = RfidTagRead.tryParse(
      hex24,
      rssi: rssi ?? -58 - _rand.nextInt(28),
    );
    if (read == null) return;
    _reads.add(read);
  }

  /// Last applied config (for native API3 wiring).
  HandheldRuntimeConfig get lastRuntime => _runtime;
}
