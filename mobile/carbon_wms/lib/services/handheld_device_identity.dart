import 'dart:io' show Platform;

import 'package:android_id/android_id.dart';
import 'package:flutter/foundation.dart';

/// WMS `deviceId` for edge ingest, mobile-sync, and epc-visibility: **Android ID** rows in `devices.android_id`.
/// (RFID scanner labels like ZEBRA_* are not used for server registration.)
class HandheldDeviceIdentity {
  HandheldDeviceIdentity._();

  static Future<String> primaryDeviceIdForServer() async {
    if (kIsWeb) return 'HANDHELD_OFFLINE';
    if (!Platform.isAndroid) return 'HANDHELD_OFFLINE';
    try {
      final raw = await const AndroidId().getId();
      final s = raw?.trim() ?? '';
      if (s.isNotEmpty) return s;
    } catch (_) {
      /* fall through */
    }
    return 'HANDHELD_OFFLINE';
  }
}
