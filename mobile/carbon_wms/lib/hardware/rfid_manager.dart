import 'dart:async';

import 'package:flutter/foundation.dart';

import 'package:carbon_wms/hardware/chainway_scanner.dart';
import 'package:carbon_wms/hardware/rfid_scanner.dart';
import 'package:carbon_wms/hardware/zebra_scanner.dart';
import 'package:carbon_wms/network/wms_api_client.dart';

/// Selects the active sled, dedupes EPCs, surfaces session lists for ops screens,
/// and batches edge ingest every 500ms (pending queue only — session list is unchanged).
class RfidManager extends ChangeNotifier {
  RfidManager({required WmsApiClient api}) : _api = api {
    _flushTimer = Timer.periodic(const Duration(milliseconds: 500), (_) {
      unawaited(_flush());
    });
  }

  final WmsApiClient _api;

  RfidScanner? _active;
  StreamSubscription<String>? _epcSub;

  /// EPCs not yet successfully posted to `/api/edge/ingest`.
  final Set<String> _pendingIngest = <String>{};

  /// Ordered, deduped tags for the current operation (transfer, status, etc.).
  final List<String> _sessionOrder = <String>[];
  final Set<String> _sessionSeen = <String>{};

  /// Current UI module context (`TRANSFER`, `GEIGER_FIND`, …).
  String scanContext = 'TRANSFER';

  /// Merged into each edge ingest POST (e.g. origin/destination, status bucket).
  Map<String, dynamic> _ingestMetadata = <String, dynamic>{};

  Timer? _flushTimer;

  static final RegExp _epcHex24 = RegExp(r'^[0-9A-F]{24}$');

  RfidScanner? get activeScanner => _active;

  List<String> get sessionEpcs => List<String>.unmodifiable(_sessionOrder);

  int get sessionCount => _sessionOrder.length;

  void setIngestMetadata(Map<String, dynamic> meta) {
    _ingestMetadata = Map<String, dynamic>.from(meta);
    notifyListeners();
  }

  void clearIngestMetadata() {
    _ingestMetadata = <String, dynamic>{};
    notifyListeners();
  }

  Future<void> useChainway() async {
    await _swapScanner(ChainwayScanner());
  }

  Future<void> useZebra() async {
    await _swapScanner(ZebraScanner());
  }

  Future<void> clearScanner() async {
    await _epcSub?.cancel();
    _epcSub = null;
    await _active?.disconnect();
    _active = null;
    notifyListeners();
  }

  Future<void> _swapScanner(RfidScanner next) async {
    await _epcSub?.cancel();
    _epcSub = null;
    await _active?.disconnect();
    _active = next;
    await _active!.connect();
    _epcSub = _active!.epcStream.listen(_ingestIncoming, onError: (_) {});
    notifyListeners();
  }

  void _ingestIncoming(String raw) {
    final u = raw.trim().toUpperCase();
    if (!_epcHex24.hasMatch(u)) return;
    _pendingIngest.add(u);
    if (_sessionSeen.add(u)) {
      _sessionOrder.add(u);
    }
    notifyListeners();
  }

  /// Demo / hardware-off — same path as a live tag read.
  void addSimulatedEpc(String hex24) {
    _ingestIncoming(hex24);
  }

  void clearSessionScans() {
    _sessionOrder.clear();
    _sessionSeen.clear();
    notifyListeners();
  }

  Future<void> _flush() async {
    if (_pendingIngest.isEmpty) return;
    final batch = List<String>.from(_pendingIngest);
    _pendingIngest.clear();
    notifyListeners();

    try {
      final id = _active != null ? await _active!.getDeviceId() : 'HANDHELD_OFFLINE';
      await _api.postEdgeIngest(
        deviceId: id,
        scanContext: scanContext,
        epcs: batch,
        metadata: Map<String, dynamic>.from(_ingestMetadata),
      );
    } catch (e, st) {
      if (kDebugMode) {
        // ignore: avoid_print
        print('[RfidManager] ingest failed: $e\n$st');
      }
      _pendingIngest.addAll(batch);
      notifyListeners();
    }
  }

  Future<void> flushNow() => _flush();

  /// Explicit commit for ops screens (transfer / status) — full session list, once.
  Future<void> ingestSessionSnapshot() async {
    if (_sessionOrder.isEmpty) return;
    final batch = List<String>.from(_sessionOrder);
    try {
      final id = _active != null ? await _active!.getDeviceId() : 'HANDHELD_OFFLINE';
      await _api.postEdgeIngest(
        deviceId: id,
        scanContext: scanContext,
        epcs: batch,
        metadata: Map<String, dynamic>.from(_ingestMetadata),
      );
      for (final e in batch) {
        _pendingIngest.remove(e);
      }
    } catch (e, st) {
      if (kDebugMode) {
        // ignore: avoid_print
        print('[RfidManager] session snapshot failed: $e\n$st');
      }
      rethrow;
    } finally {
      notifyListeners();
    }
  }

  @override
  void dispose() {
    _flushTimer?.cancel();
    _epcSub?.cancel();
    unawaited(_active?.disconnect());
    super.dispose();
  }
}
