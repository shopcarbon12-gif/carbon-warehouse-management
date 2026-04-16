import 'dart:async';
import 'dart:io' show Platform;

import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/foundation.dart';

import 'package:carbon_wms/hardware/chainway_scanner.dart';
import 'package:carbon_wms/hardware/manual_csv_row.dart';
import 'package:carbon_wms/hardware/rfid_scanner.dart';
import 'package:carbon_wms/hardware/rfid_tag_read.dart';
import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/hardware/zebra_scanner.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/handheld_device_identity.dart';
import 'package:carbon_wms/services/mobile_settings_repository.dart';

/// Selects the active sled, dedupes EPCs, surfaces session lists for ops screens,
/// and batches edge ingest every 500ms (pending queue only — session list is unchanged).
class RfidManager extends ChangeNotifier {
  RfidManager({required WmsApiClient api, required MobileSettingsRepository settings})
      : _api = api,
        _settings = settings {
    _settings.addListener(_onSettingsChanged);
    _flushTimer = Timer.periodic(const Duration(milliseconds: 500), (_) {
      unawaited(_flushVisibilityThenEdge());
    });
  }

  final WmsApiClient _api;
  final MobileSettingsRepository _settings;

  RfidScanner? _active;
  StreamSubscription<RfidTagRead>? _epcSub;
  StreamSubscription<String>? _fallbackBarcodeSub;
  final StreamController<RfidTagRead> _unifiedReads = StreamController<RfidTagRead>.broadcast();

  /// Raw reads while [scanContext] is `GEIGER_FIND` (no edge ingest / ghost filter).
  final StreamController<RfidTagRead> _geigerReads = StreamController<RfidTagRead>.broadcast();
  final StreamController<String> _visibleEpcs = StreamController<String>.broadcast();

  Stream<RfidTagRead> get geigerTagReads => _geigerReads.stream;
  Stream<RfidTagRead> get unifiedTagReads => _unifiedReads.stream;
  Stream<String> get visibleEpcs => _visibleEpcs.stream;

  /// EPCs not yet successfully posted to `/api/edge/ingest`.
  final Set<String> _pendingIngest = <String>{};

  /// When true, RFID reads are kept local only (manual CSV upload flow).
  bool _suppressEdgeStreaming = false;

  /// EPCs waiting for `/api/mobile/epc-visibility` (status-label ghost filter).
  final Set<String> _visibilityPending = <String>{};

  /// Cached: server said tag may appear in UI / CSV / edge queue.
  final Map<String, bool> _ghostPassCache = <String, bool>{};

  /// Cached: server said tag is hidden (silent drop).
  final Map<String, bool> _ghostDropCache = <String, bool>{};

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

  /// True only when a real native RFID link is established (Zebra BT or Chainway built-in).
  /// False on regular Android phones, simulators, or when hardware is not paired.
  bool get isHardwareLinked {
    final s = _active;
    if (s is ZebraScanner) return s.isNativeLinked;
    if (s is ChainwayScanner) return s.isNativeLinked;
    return false;
  }

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
    _visibilityPending.clear();
    _ghostPassCache.clear();
    _ghostDropCache.clear();
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

  /// Chainway manufacturer → native UHF; otherwise prefer Zebra BT RFD8500 path.
  Future<void> autoDetectHardware() async {
    if (kIsWeb) return;
    if (!Platform.isAndroid) {
      await useZebra();
      return;
    }
    try {
      final info = await DeviceInfoPlugin().androidInfo;
      final m = info.manufacturer.toLowerCase();
      final brand = info.brand.toLowerCase();
      final model = info.model.toLowerCase();
      final product = info.product.toLowerCase();
      final isChainwayHandset = m.contains('chainway') ||
          brand.contains('chainway') ||
          model.contains('c72') ||
          product.contains('c72') ||
          model.contains('chainway') ||
          product.contains('chainway');
      if (isChainwayHandset) {
        await useChainway();
        if (!isHardwareLinked) {
          await useZebra();
        }
        return;
      }
    } catch (_) {
      /* fall through */
    }
    await useZebra();
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
    await _fallbackBarcodeSub?.cancel();
    _fallbackBarcodeSub = null;
    await _active?.disconnect();
    _active = null;
    notifyListeners();
  }

  Future<void> _swapScanner(RfidScanner next) async {
    await _epcSub?.cancel();
    _epcSub = null;
    await _fallbackBarcodeSub?.cancel();
    _fallbackBarcodeSub = null;
    await _active?.disconnect();
    _active = next;
    await _active!.connect();
    _epcSub = _active!.tagReadStream.listen(_handleTagRead, onError: (_) {});
    await _active!.applyHandheldRuntimeSettings(_settings.config, scanContext: _scanContext);
    // Always merge OEM scan broadcasts: some devices report UHF only via rscja intents while
    // native SDK is linked to a dead path, or sled + built-in overlap.
    _fallbackBarcodeSub = RfidVendorChannel.hardwareBarcodeStream().listen(
      _handleFallbackBarcodeRead,
      onError: (_) {},
    );
    notifyListeners();
  }

  /// Some rugged devices expose UHF EPC via scanner broadcast when native RFID SDK is absent.
  /// Accept either pure EPC or payloads containing a 24-hex EPC substring.
  void _handleFallbackBarcodeRead(String raw) {
    final s = raw.trim().toUpperCase();
    if (s.isEmpty) return;
    final compact = s.replaceAll(RegExp(r'\s+'), '');
    var read = RfidTagRead.tryParse(compact);
    if (read == null) {
      final m = RegExp(r'([0-9A-F]{24})').firstMatch(compact);
      if (m == null) return;
      read = RfidTagRead.tryParse(m.group(1)!);
    }
    if (read == null) {
      final exactDec = RegExp(r'^\d{6,15}$').firstMatch(compact)?.group(0);
      final decToken = exactDec ??
          RegExp(r'(\d{6,15})')
              .allMatches(compact)
              .map((m) => m.group(1)!)
              .fold<String>('', (best, next) => next.length > best.length ? next : best);
      if (decToken.isNotEmpty) {
        final synthetic = _decimalAssetToSyntheticEpc(decToken);
        if (synthetic != null) {
          read = RfidTagRead.tryParse(synthetic);
        }
      }
    }
    if (read == null) return;
    _handleTagRead(read);
  }

  /// Converts decimal asset-id scans to a synthetic EPC96 payload:
  /// prefix=00000, item=asset-id (40-bit), serial=0.
  String? _decimalAssetToSyntheticEpc(String dec) {
    try {
      final n = BigInt.parse(dec);
      final max40 = (BigInt.one << 40) - BigInt.one;
      if (n < BigInt.zero || n > max40) return null;
      final itemHex = n.toRadixString(16).toUpperCase().padLeft(10, '0');
      return '00000${itemHex}000000000';
    } catch (_) {
      return null;
    }
  }

  /// Re-apply antenna power / trigger hints after mobile-sync or prefs load.
  Future<void> reapplyHandheldHardwareSettings() async {
    final s = _active;
    if (s == null) return;
    await s.applyHandheldRuntimeSettings(_settings.config, scanContext: _scanContext);
    notifyListeners();
  }

  void _commitVisibleEpc(String u) {
    if (!_visibleEpcs.isClosed) _visibleEpcs.add(u);
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

  Future<void> _flushGhostBatch() async {
    if (_visibilityPending.isEmpty) return;
    final batch = List<String>.from(_visibilityPending);
    _visibilityPending.clear();
    notifyListeners();
    try {
      final id = await HandheldDeviceIdentity.primaryDeviceIdForServer();
      final rows = await _api.postEpcVisibility(deviceId: id, epcs: batch);
      for (final r in rows) {
        if (r.visible) {
          _ghostPassCache[r.epc] = true;
          _commitVisibleEpc(r.epc);
        } else {
          _ghostDropCache[r.epc] = true;
        }
      }
    } catch (e, st) {
      if (kDebugMode) {
        // ignore: avoid_print
        print('[RfidManager] epc-visibility failed: $e\n$st');
      }
      _visibilityPending.addAll(batch);
      notifyListeners();
    }
  }

  Future<void> _flushVisibilityThenEdge() async {
    await _flushGhostBatch();
    await _flush();
  }

  void _handleTagRead(RfidTagRead read) {
    final u = read.epcHex24;
    if (!_epcHex24.hasMatch(u)) return;
    if (!_unifiedReads.isClosed) _unifiedReads.add(read);

    if (_scanContext == 'GEIGER_FIND') {
      if (!_geigerReads.isClosed) _geigerReads.add(read);
      return;
    }

    if (_ghostDropCache[u] == true) return;
    if (_ghostPassCache[u] == true) {
      _commitVisibleEpc(u);
      return;
    }
    _visibilityPending.add(u);
    notifyListeners();
  }

  /// Start continuous inventory on the sled (hold-to-locate).
  Future<void> startLocateScanning() async {
    await _active?.startScanning();
  }

  /// Stop inventory on the sled.
  Future<void> stopLocateScanning() async {
    await _active?.stopScanning();
  }

  /// Demo pulse for locate UI (stub hardware / QA).
  void debugPulseLocateRead(String hex24, {required int rssi}) {
    final read = RfidTagRead.tryParse(hex24, rssi: rssi);
    if (read == null) return;
    if (_scanContext != 'GEIGER_FIND') return;
    if (!_geigerReads.isClosed) _geigerReads.add(read);
  }

  /// Demo / hardware-off — same path as a live tag read.
  void addSimulatedEpc(String hex24) {
    final read = RfidTagRead.tryParse(hex24);
    if (read == null) return;
    _handleTagRead(read);
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
      final id = await HandheldDeviceIdentity.primaryDeviceIdForServer();
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

  Future<void> flushNow() => _flushVisibilityThenEdge();

  /// Explicit commit for ops screens (transfer / status) — full session list, once.
  Future<void> ingestSessionSnapshot() async {
    await _flushGhostBatch();
    if (_sessionOrder.isEmpty) return;
    final batch = List<String>.from(_sessionOrder);
    try {
      final id = await HandheldDeviceIdentity.primaryDeviceIdForServer();
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
    _fallbackBarcodeSub?.cancel();
    unawaited(_active?.disconnect());
    unawaited(_geigerReads.close());
    unawaited(_unifiedReads.close());
    unawaited(_visibleEpcs.close());
    super.dispose();
  }
}
