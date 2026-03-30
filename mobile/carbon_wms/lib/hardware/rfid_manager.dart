import 'dart:async';

import 'package:flutter/foundation.dart';

import 'package:carbon_wms/hardware/chainway_scanner.dart';
import 'package:carbon_wms/hardware/manual_csv_row.dart';
import 'package:carbon_wms/hardware/rfid_scanner.dart';
import 'package:carbon_wms/hardware/zebra_scanner.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/mobile_settings_repository.dart';

/// Selects the active sled, dedupes EPCs, surfaces session lists for ops screens,
/// and batches edge ingest every 500ms (pending queue only — session list is unchanged).
class RfidManager extends ChangeNotifier {
  RfidManager({required WmsApiClient api, required MobileSettingsRepository settings})
      : _api = api,
        _settings = settings {
    _settings.addListener(_onSettingsChanged);
    _flushTimer = Timer.periodic(const Duration(milliseconds: 500), (_) {
      unawaited(_flush());
    });
  }

  final WmsApiClient _api;
  final MobileSettingsRepository _settings;

  RfidScanner? _active;
  StreamSubscription<String>? _epcSub;

  /// EPCs not yet successfully posted to `/api/edge/ingest`.
  final Set<String> _pendingIngest = <String>{};

  /// When true, RFID reads are kept local only (manual CSV upload flow).
  bool _suppressEdgeStreaming = false;

  /// First-seen EPCs with timestamps while [_suppressEdgeStreaming] is on.
  final List<ManualCsvRow> _manualCsvRows = <ManualCsvRow>[];

  /// Ordered, deduped tags for the current operation (transfer, status, etc.).
  final List<String> _sessionOrder = <String>[];
  final Set<String> _sessionSeen = <String>{};

  /// Current UI module context (`TRANSFER`, `GEIGER_FIND`, …).
  String _scanContext = 'TRANSFER';

  String get scanContext => _scanContext;

  set scanContext(String value) {
    final v = value.trim();
    if (v.isEmpty || v == _scanContext) return;
    _scanContext = v;
    notifyListeners();
    unawaited(reapplyHandheldHardwareSettings());
  }

  /// Merged into each edge ingest POST (e.g. origin/destination, status bucket).
  Map<String, dynamic> _ingestMetadata = <String, dynamic>{};

  Timer? _flushTimer;

  static final RegExp _epcHex24 = RegExp(r'^[0-9A-F]{24}$');

  void _onSettingsChanged() {
    unawaited(reapplyHandheldHardwareSettings());
  }

  RfidScanner? get activeScanner => _active;

  List<String> get sessionEpcs => List<String>.unmodifiable(_sessionOrder);

  int get sessionCount => _sessionOrder.length;

  bool get suppressEdgeStreaming => _suppressEdgeStreaming;

  set suppressEdgeStreaming(bool v) {
    if (v == _suppressEdgeStreaming) return;
    _suppressEdgeStreaming = v;
    if (v) {
      _manualCsvRows.clear();
      _pendingIngest.clear();
    }
    notifyListeners();
  }

  List<ManualCsvRow> get manualCsvRows => List<ManualCsvRow>.unmodifiable(_manualCsvRows);

  /// CSV with header `epc,timestamp,bin` for [POST /api/inventory/upload].
  String buildManualUploadCsv({String binColumn = ''}) {
    final b = StringBuffer('epc,timestamp,bin\n');
    for (final r in _manualCsvRows) {
      b.writeln('${r.epc},${r.at.toUtc().toIso8601String()},$binColumn');
    }
    return b.toString();
  }

  void clearManualCsvSession() {
    _manualCsvRows.clear();
    _sessionOrder.clear();
    _sessionSeen.clear();
    _pendingIngest.clear();
    notifyListeners();
  }

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
    await _active!.applyHandheldRuntimeSettings(_settings.config, scanContext: _scanContext);
    notifyListeners();
  }

  /// Re-apply antenna power / trigger hints after mobile-sync or prefs load.
  Future<void> reapplyHandheldHardwareSettings() async {
    final s = _active;
    if (s == null) return;
    await s.applyHandheldRuntimeSettings(_settings.config, scanContext: _scanContext);
    notifyListeners();
  }

  void _ingestIncoming(String raw) {
    final u = raw.trim().toUpperCase();
    if (!_epcHex24.hasMatch(u)) return;
    if (!_suppressEdgeStreaming) {
      _pendingIngest.add(u);
    }
    if (_sessionSeen.add(u)) {
      _sessionOrder.add(u);
      if (_suppressEdgeStreaming) {
        _manualCsvRows.add(ManualCsvRow(epc: u, at: DateTime.now().toUtc()));
      }
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
    _manualCsvRows.clear();
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
        scanContext: _scanContext,
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
        scanContext: _scanContext,
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
    _settings.removeListener(_onSettingsChanged);
    _flushTimer?.cancel();
    _epcSub?.cancel();
    unawaited(_active?.disconnect());
    super.dispose();
  }
}
