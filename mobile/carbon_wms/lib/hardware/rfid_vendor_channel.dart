import 'package:flutter/services.dart';

/// Android [MethodChannel] bridge (`carbon_wms/rfid`). Extend when wiring Zebra / Chainway SDKs.
class RfidVendorChannel {
  RfidVendorChannel._();

  static const MethodChannel _channel = MethodChannel('carbon_wms/rfid');

  static Future<String?> ping() async {
    try {
      final v = await _channel.invokeMethod<String>('ping');
      return v;
    } on MissingPluginException {
      return null;
    }
  }
}
