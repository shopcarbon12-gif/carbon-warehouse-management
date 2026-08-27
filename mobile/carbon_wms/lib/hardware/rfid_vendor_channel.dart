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
  static const EventChannel _events =
      EventChannel('carbon_wms/rfid_tag_stream');
  static const EventChannel _hardwareBarcodeEvents =
      EventChannel('carbon_wms/hardware_barcode');
  static const EventChannel _hardwareTriggerEvents =
      EventChannel('carbon_wms/hardware_trigger');
  static const EventChannel _deviceMotionEvents =
      EventChannel('carbon_wms/device_motion');

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

  static Future<Map<String, dynamic>> deviceDiagnostics() async {
    if (!_isAndroid) return const <String, dynamic>{};
    try {
      final m = await _method.invokeMethod<dynamic>('device.diagnostics');
      if (m is Map) return Map<String, dynamic>.from(m);
      return const <String, dynamic>{};
    } on MissingPluginException {
      return const <String, dynamic>{};
    } catch (_) {
      return const <String, dynamic>{};
    }
  }

  static Future<void> scannerStart2d() async {
    if (!_isAndroid) return;
    try {
      await _method.invokeMethod<void>('scanner.start2d');
    } catch (_) {}
  }

  static Future<void> scannerStop2d() async {
    if (!_isAndroid) return;
    try {
      await _method.invokeMethod<void>('scanner.stop2d');
    } catch (_) {}
  }

  /// Registers a native KEY_DOWN receiver in Kotlin that toggles RFID inventory directly.
  static Future<void> enableNativeTrigger() async {
    if (!_isAndroid) return;
    try { await _method.invokeMethod<void>('scanner.enableNativeTrigger'); } catch (_) {}
  }

  /// Unregisters the native KEY_DOWN trigger receiver.
  static Future<void> disableNativeTrigger() async {
    if (!_isAndroid) return;
    try { await _method.invokeMethod<void>('scanner.disableNativeTrigger'); } catch (_) {}
  }

  /// Tells com.rscja.scanner to switch to RFID-only mode (no 2D laser on KEY_DOWN).
  static Future<void> enableRfidFunctionMode() async {
    if (!_isAndroid) return;
    try {
      await _method.invokeMethod<void>('scanner.enableRfidFunctionMode');
    } catch (_) {}
  }

  /// Restores com.rscja.scanner to normal 2D barcode mode.
  static Future<void> disableRfidFunctionMode() async {
    if (!_isAndroid) return;
    try {
      await _method.invokeMethod<void>('scanner.disableRfidFunctionMode');
    } catch (_) {}
  }

  /// Physically closes (powers off) the 2D barcode engine on Chainway C72E.
  /// Use in RFID-only screens so the laser never fires regardless of trigger state.
  static Future<void> close2dBarcode() async {
    if (!_isAndroid) return;
    try {
      await _method.invokeMethod<void>('scanner.close2dBarcode');
    } catch (_) {}
  }

  /// Re-opens the 2D barcode engine after [close2dBarcode].
  static Future<void> open2dBarcode() async {
    if (!_isAndroid) return;
    try {
      await _method.invokeMethod<void>('scanner.open2dBarcode');
    } catch (_) {}
  }

  static Future<void> scannerEnableTriggerRelay() async {
    if (!_isAndroid) return;
    try {
      await _method.invokeMethod<void>('scanner.enableTriggerRelay');
    } catch (_) {}
  }

  static Future<void> scannerDisableTriggerRelay() async {
    if (!_isAndroid) return;
    try {
      await _method.invokeMethod<void>('scanner.disableTriggerRelay');
    } catch (_) {}
  }

  /// Optional [readerName] substring to pick one reader when multiple are paired (e.g. `RFD8500`).
  static Future<RfidNativeConnectResult> connectZebra(
      {String? readerName}) async {
    if (!_isAndroid) return RfidNativeConnectResult.useStub;
    try {
      await _method.invokeMethod<void>('zebra.connect', <String, dynamic>{
        if (readerName != null && readerName.trim().isNotEmpty)
          'readerName': readerName.trim(),
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

  /// Flip the RFD8500 hardware trigger to fire the 2D imager (barcode mode).
  /// While in this mode trigger pulls do not perform UHF inventory; barcode
  /// decodes flow back via [hardwareBarcodeStream] (or via HID keyboard if the
  /// sled is paired in keyboard mode). No-op if Zebra reader is not connected.
  static Future<void> setZebraTriggerMode2D() async {
    if (!_isAndroid) return;
    try {
      await _method.invokeMethod<void>('zebra.setTriggerMode2D');
    } catch (_) {}
  }

  /// Flip the RFD8500 hardware trigger back to fire UHF (RFID mode).
  /// Inverse of [setZebraTriggerMode2D]. No-op if reader not connected.
  static Future<void> setZebraTriggerModeRfid() async {
    if (!_isAndroid) return;
    try {
      await _method.invokeMethod<void>('zebra.setTriggerModeRfid');
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

  static Future<void> clearChainwaySeenEpcs() async {
    if (!_isAndroid) return;
    try {
      await _method.invokeMethod<void>('chainway.clearSeenEpcs');
    } catch (_) {}
  }

  /// Write a new 24-hex EPC to a physical UHF tag.
  /// [targetEpc] is the EPC currently on the tag (used by the native SDK to single-target the write
  /// via an EPC-match select; some SDKs require it, some fall back to "nearest tag").
  /// Returns `false` on any native / vendor failure (tag missing, write failure, no SDK, etc.).
  static Future<bool> writeEpcTag({
    required String targetEpc,
    required String newEpc,
  }) async {
    if (!_isAndroid) return false;
    try {
      final ok = await _method.invokeMethod<bool>(
        'rfid.writeEpc',
        <String, dynamic>{
          'targetEpc': targetEpc,
          'newEpc': newEpc,
        },
      ).timeout(
        // Belt outside the native watchdog (~9s). If the platform channel goes
        // dead (native thread wedged on a half-open BT link and even the
        // watchdog can't answer), fail the write here so the UI never freezes
        // on "writing…" and force-closing the app is never required.
        const Duration(seconds: 12),
        onTimeout: () => false,
      );
      return ok == true;
    } on MissingPluginException {
      return false;
    } on PlatformException {
      return false;
    } catch (_) {
      return false;
    }
  }

  /// Read the active radio's achievable power range in integer dBm. Used
  /// by the Status Change slider to clamp itself to what the connected
  /// reader can actually accept. RFD8500 transmitPowerLevelValues bottoms
  /// out at ~5 dBm; Chainway C72E is hard-capped at 5..23 dBm. Pre-fix
  /// the slider went 1..30 regardless of hardware, so values below the
  /// radio floor were silently lifted and the operator saw "3 dBm" on
  /// the bar while the radio was at 5 dBm. Returns null when no reader
  /// is ready (caller should fall back to a safe default).
  static Future<({int minDbm, int maxDbm})?> getPowerRangeDbm() async {
    if (!_isAndroid) return null;
    try {
      final r = await _method.invokeMapMethod<String, dynamic>('rfid.getPowerRangeDbm');
      if (r == null) return null;
      final mn = (r['minDbm'] as num?)?.toInt();
      final mx = (r['maxDbm'] as num?)?.toInt();
      if (mn == null || mx == null || mx < mn) return null;
      return (minDbm: mn, maxDbm: mx);
    } on MissingPluginException {
      return null;
    } catch (_) {
      return null;
    }
  }

  /// Forward **0–30 dBm** to native Zebra/Chainway controllers (no scaling).
  static Future<void> setAntennaPowerDbm(int dbm) async {
    if (!_isAndroid) return;
    final p = dbm.clamp(0, 30);
    try {
      await _method.invokeMethod<void>(
          'rfid.setAntennaPower', <String, dynamic>{'dbm': p});
    } on MissingPluginException {
      /* iOS / unit tests */
    } catch (_) {
      /* optional vendor bridge */
    }
  }

  /// Switch the Zebra radio's singulation session at runtime. Locate-Tag
  /// uses S0 (tag responds on every query — continuous proximity) on
  /// entry; every other screen sticks with the connect-time S1 (better
  /// inventory throughput for multi-tag passes). Returns true if the
  /// flip was accepted by the radio.
  static Future<bool> setSingulationSession({required bool useSessionZero}) async {
    if (!_isAndroid) return false;
    try {
      final ok = await _method.invokeMethod<bool>(
        'rfid.setSingulationSession',
        <String, dynamic>{'useSessionZero': useSessionZero},
      );
      return ok == true;
    } catch (_) {
      return false;
    }
  }

  /// Install a Zebra PreFilter so the radio only responds to the given
  /// EPC. Matching tags go to inventory state A (responsive), everyone
  /// else goes to state B (silent) — radio dedicates all its time slots
  /// to the target. Pass `null` to clear the filter.
  ///
  /// Used by Locate-Tag on entry to make RSSI stable when the warehouse
  /// has hundreds of other tags in the field, and cleared on exit so
  /// other screens see normal inventory.
  static Future<bool> setEpcInventoryFilter(String? epc) async {
    if (!_isAndroid) return false;
    try {
      final ok = await _method.invokeMethod<bool>(
        'rfid.setEpcInventoryFilter',
        <String, dynamic>{'epc': epc},
      );
      return ok == true;
    } catch (_) {
      return false;
    }
  }

  /// Tag reads from the native layer (`epc` hex string, optional `rssi`).
  ///
  /// Accepts BOTH wire shapes: a single `{epc, rssi}` map, and a list of them.
  /// The Zebra controller batches a whole read-event into one message because
  /// at Locate read rates (hundreds/sec for one tag behind a pre-filter) a
  /// message per tag backed the platform channel up badly. Older emitters that
  /// still send one map at a time keep working unchanged.
  static Stream<RfidTagRead> tagReadStream() {
    return _events.receiveBroadcastStream().expand<RfidTagRead>((dynamic e) {
      if (e is Map) {
        final r = _parseTagRead(e);
        return r == null ? const <RfidTagRead>[] : <RfidTagRead>[r];
      }
      if (e is List) {
        final out = <RfidTagRead>[];
        for (final item in e) {
          if (item is! Map) continue;
          final r = _parseTagRead(item);
          if (r != null) out.add(r);
        }
        return out;
      }
      return const <RfidTagRead>[];
    });
  }

  static RfidTagRead? _parseTagRead(Map<dynamic, dynamic> m) {
    final hex = m['epc']?.toString().trim().toUpperCase() ?? '';
    if (hex.isEmpty) return null;
    final raw = m['rssi'];
    final rssi = raw is num ? raw.round() : null;
    return RfidTagRead.tryParse(hex, rssi: rssi);
  }

  static Stream<String> hardwareBarcodeStream() {
    if (!_isAndroid) return const Stream<String>.empty();
    return _hardwareBarcodeEvents.receiveBroadcastStream().map((dynamic e) {
      final s = e?.toString() ?? '';
      return s.trim();
    }).where((s) => s.isNotEmpty);
  }

  static Stream<String> hardwareTriggerStream() {
    if (!_isAndroid) return const Stream<String>.empty();
    return _hardwareTriggerEvents.receiveBroadcastStream().map((dynamic e) {
      return (e?.toString() ?? '').trim().toLowerCase();
    }).where((s) => s == 'down' || s == 'up');
  }

  /// Live radio state, straight from the native controllers.
  ///
  /// [inventoryActive] is the radio's OWN view of whether it is transmitting —
  /// set only when the SDK's inventory call actually succeeded, cleared when it
  /// stops or its retries are exhausted. It is not derived from what any screen
  /// requested, so it stays honest when a screen believes it is scanning but
  /// the radio quietly isn't.
  static Future<({bool connected, bool inventoryActive, String stack})?>
      readerStatus() async {
    if (!_isAndroid) return null;
    try {
      final m = await _method.invokeMapMethod<String, dynamic>('rfid.readerStatus');
      if (m == null) return null;
      return (
        connected: m['connected'] == true,
        inventoryActive: m['inventoryActive'] == true,
        stack: m['stack']?.toString() ?? 'none',
      );
    } on MissingPluginException {
      return null;
    } catch (_) {
      return null;
    }
  }

  /// Handheld yaw in degrees (rotation about the world vertical axis), for
  /// Locate-Tag direction finding. Sourced from the gyro+accelerometer fusion,
  /// NOT the compass — see [CarbonMotionRelay]. The native sensor is only
  /// registered while this stream has a listener.
  static Stream<double> deviceYawStream() {
    if (!_isAndroid) return const Stream<double>.empty();
    return _deviceMotionEvents
        .receiveBroadcastStream()
        .map((dynamic e) => e is num ? e.toDouble() : double.nan)
        .where((v) => v.isFinite);
  }

  static bool get _isAndroid =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.android;
}
