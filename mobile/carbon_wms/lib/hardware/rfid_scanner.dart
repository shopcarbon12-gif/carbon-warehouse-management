import 'dart:async';

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
}
