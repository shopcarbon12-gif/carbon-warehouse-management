// Local copy of the tenant's live catalog (every EPC's items.status + the
// item info a line shows), so Add-On Catalog / Add-On Count decide each tag
// on the phone, instantly, with no network wait between a read and its beep.
//
// Freshness (owner decision 2026-10-13): loaded on screen ENTRY
// (ensureFresh), refreshed on every PAUSE (refresh) and every ~3 s while
// scanning (startAutoRefresh) through a tiny "what changed" delta.
//
// Server side: app/api/handheld/live-catalog/{snapshot,delta} built by
// lib/server/live-catalog.ts (payload shape documented there). Snapshot and
// delta share one columnar shape; every index points into the SAME payload.
// Tombstones and upserts are disjoint (the server guarantees it), so they can
// be applied in any order.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';

import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/add_on_catalog_classifier.dart';
import 'package:carbon_wms/services/epc/epc_codec.dart';
import 'package:carbon_wms/services/live_catalog_models.dart';

const int _kPayloadVersion = 1;
const Duration _kSnapshotTimeout = Duration(seconds: 60);
const Duration _kDeltaTimeout = Duration(seconds: 6);
// First delta after loading a copy from disk can carry hours of changes
// (≤ 25k items server-side, else a reset) — give it longer than a 3 s tick's.
const Duration _kCatchUpDeltaTimeout = Duration(seconds: 20);
const Duration _kAutoRefreshEvery = Duration(seconds: 3);
const Duration _kResnapshotAfter = Duration(hours: 12);
// After a failed snapshot the 3 s auto-refresh waits this long before trying
// the multi-MB download again (explicit ensureFresh/refresh calls don't).
const Duration _kSnapshotRetryBackoff = Duration(seconds: 15);
// Deltas bigger than this are JSON-decoded off the UI isolate.
const int _kInlineDecodeMaxBytes = 64 * 1024;
const String _kDirName = 'live_catalog';
const String _kSnapshotFile = 'snapshot_v1.json.gz';
const String _kMetaFile = 'meta_v1.json';
const String _kInStock = 'in-stock';
final RegExp _leadingZeros = RegExp(r'^0+');

class LiveCatalogCache extends ChangeNotifier {
  LiveCatalogCache({required WmsApiClient api}) : _api = api;

  final WmsApiClient _api;

  _CatalogState? _state;

  // A copy loaded from disk is not trusted for per-tag decisions until this
  // process has tried to sync it once (success or failure). Otherwise a tag
  // read in the first second after app start could be judged against data
  // that is hours old; screens queue reads while !isReady and drain them on
  // the next notify, so nothing is lost by waiting. If that first sync
  // fails (offline) the old copy is used and the indicator says so.
  bool _gateOpen = false;
  int _version = 0;
  // Bumped whenever _state is replaced or dropped, so a delta that started
  // against an older state never applies to a newer one.
  int _generation = 0;
  DateTime? _lastSyncedAt;
  String? _lastError;
  String? _lastLoggedError;
  bool _triedSaved = false;
  bool _loadingSaved = false;
  bool _disposed = false;
  DateTime? _snapshotFailedAt;
  String? _dirPath;
  bool _dirResolved = false;

  Future<void>? _ensureFuture;
  Future<bool>? _snapshotFuture;
  Future<_DeltaOutcome>? _deltaFuture;

  Timer? _autoTimer;
  int _autoHolders = 0;

  // Memoized per version (cleared on every data change): location → skuId → value.
  final Map<String?, Map<String, String?>> _binMemo = {};
  final Map<String?, Map<String, LiveItemInfo>> _infoMemo = {};

  final ValueNotifier<LiveCatalogSyncState> _sync = ValueNotifier<LiveCatalogSyncState>(
    const LiveCatalogSyncState(phase: LiveCatalogPhase.empty),
  );

  /// A snapshot (saved or fresh) is in memory and usable for decisions.
  bool get isReady => _state != null && _gateOpen;

  /// +1 whenever in-memory data changes (snapshot or non-empty delta).
  int get version => _version;
  String? get tenantId => _state?.tenantId;

  /// Server-reported location for BIN display.
  String? get locationId => _state?.locationId;

  /// Payload epcCfg, else [kFallbackEpcConfig].
  EpcConfig get epcConfig => _state?.epcCfg ?? kFallbackEpcConfig;
  DateTime? get lastSyncedAt => _lastSyncedAt;
  String? get lastError => _lastError;
  ValueListenable<LiveCatalogSyncState> get syncState => _sync;

  // ---------------------------------------------------------------------------
  // Freshness
  // ---------------------------------------------------------------------------

  /// Entry/warm-up. Loads the saved copy (if not in memory), then a delta — or a full
  /// snapshot when there is no saved copy, it is > 12 h old, the tenant/server changed, or
  /// the server says reset. Concurrent callers share one Future. Never throws.
  Future<void> ensureFresh() {
    if (_disposed) return Future<void>.value();
    final inFlight = _ensureFuture;
    if (inFlight != null) return inFlight;
    final f = _doEnsureFresh().whenComplete(() {
      _ensureFuture = null;
      _publishSync();
    });
    _ensureFuture = f;
    _publishSync();
    return f;
  }

  /// One delta now. In-flight guard: a call while one runs returns that same Future.
  /// Never throws; returns true on success. If not ready, behaves like ensureFresh().
  /// A reset response kicks off a background snapshot and returns false.
  Future<bool> refresh({Duration timeout = _kDeltaTimeout}) {
    if (_disposed) return Future<bool>.value(false);
    if (!isReady) {
      return ensureFresh().then((_) => isReady && _lastError == null);
    }
    return _runDelta(timeout).then((o) => o == _DeltaOutcome.ok);
  }

  /// Ref-counted 3 s auto-refresh (Timer.periodic(3s) → refresh() when no refresh is in flight).
  /// Each screen calls start when its scan starts and stop exactly once when it stops/leaves.
  void startAutoRefresh() {
    if (_disposed) return;
    _autoHolders++;
    if (_autoTimer == null) {
      _autoTimer = Timer.periodic(_kAutoRefreshEvery, (_) => _autoTick());
      // A scan is starting: pull the latest changes now rather than deciding its
      // first ~3 s against a copy as old as the last pause.
      _autoTick();
    }
  }

  void stopAutoRefresh() {
    if (_autoHolders == 0) return;
    _autoHolders--;
    if (_autoHolders == 0) {
      _autoTimer?.cancel();
      _autoTimer = null;
    }
  }

  void _autoTick() {
    if (_disposed) return;
    if (_ensureFuture != null || _deltaFuture != null) return;
    if (!isReady) {
      if (_snapshotFuture != null) return;
      final failedAt = _snapshotFailedAt;
      if (failedAt != null && DateTime.now().difference(failedAt) < _kSnapshotRetryBackoff) {
        return;
      }
    }
    unawaited(refresh());
  }

  Future<void> _doEnsureFresh() async {
    try {
      final base = await _currentBaseUrl();
      if (_disposed) return;
      if (_state == null && !_triedSaved) {
        _triedSaved = true;
        await _loadSaved(base);
        if (_disposed) return;
      }
      final st = _state;
      if (st != null && st.baseUrl != base) {
        debugPrint('[LiveCatalog] server changed — dropping the local copy');
        _dropState();
        await clearPersisted();
      }
      if (_state == null) {
        await _runSnapshot(base);
        return;
      }
      final outcome = await _runDelta(_gateOpen ? _kDeltaTimeout : _kCatchUpDeltaTimeout);
      if (outcome == _DeltaOutcome.needsSnapshot) {
        await _runSnapshot(base);
      } else if (_savedCopyTooOld()) {
        // Twice-a-day re-baseline. The delta above already brought the copy
        // current, so this downloads in the background and swaps in atomically.
        unawaited(_runSnapshot(base));
      }
    } catch (e) {
      _noteError('sync', e);
    } finally {
      if (!_disposed && _state != null && !_gateOpen) {
        _gateOpen = true;
        _publishSync();
        notifyListeners();
      }
    }
  }

  bool _savedCopyTooOld() {
    final st = _state;
    if (st == null) return false;
    final age = DateTime.now().millisecondsSinceEpoch - st.savedAtMs;
    return age > _kResnapshotAfter.inMilliseconds;
  }

  Future<String> _currentBaseUrl() async =>
      WmsApiClient.normalizeBaseUrl(await _api.resolveBaseUrl());

  // ---------------------------------------------------------------------------
  // Delta
  // ---------------------------------------------------------------------------

  Future<_DeltaOutcome> _runDelta(Duration timeout) {
    final inFlight = _deltaFuture;
    if (inFlight != null) return inFlight;
    final f = _doDelta(timeout).whenComplete(() {
      _deltaFuture = null;
      _publishSync();
    });
    _deltaFuture = f;
    _publishSync();
    return f;
  }

  Future<_DeltaOutcome> _doDelta(Duration timeout) async {
    final st = _state;
    if (st == null) return _DeltaOutcome.failed;
    final gen = _generation;
    try {
      final base = await _currentBaseUrl();
      if (_disposed || gen != _generation) return _DeltaOutcome.superseded;
      if (base != st.baseUrl) {
        debugPrint('[LiveCatalog] server changed — dropping the local copy');
        _dropState();
        await clearPersisted();
        unawaited(_runSnapshot(base));
        return _DeltaOutcome.needsSnapshot;
      }
      final bytes = await _api.fetchLiveCatalogDeltaBytes(st.cursor, timeout: timeout);
      final Object? json = bytes.length > _kInlineDecodeMaxBytes
          ? await _decodeInIsolate(bytes)
          : _decodeJsonBytes(bytes);
      if (_disposed || gen != _generation) return _DeltaOutcome.superseded;
      final outcome = _acceptDelta(st, _parsePayload(json));
      switch (outcome) {
        case _DeltaOutcome.reset:
          debugPrint('[LiveCatalog] delta reset — fetching a fresh snapshot');
          unawaited(_runSnapshot(base));
          return _DeltaOutcome.needsSnapshot;
        case _DeltaOutcome.tenantChanged:
          debugPrint('[LiveCatalog] tenant changed — dropping the local copy');
          _dropState();
          await clearPersisted();
          unawaited(_runSnapshot(base));
          return _DeltaOutcome.needsSnapshot;
        default:
          return outcome;
      }
    } catch (e) {
      if (!_disposed && gen == _generation) _noteError('delta', e);
      return _DeltaOutcome.failed;
    }
  }

  /// Applies a parsed delta to [st] (the live state) unless it is a reset or
  /// belongs to another tenant — those leave the data untouched.
  _DeltaOutcome _acceptDelta(_CatalogState st, _ParsedPayload p) {
    if (p.reset) return _DeltaOutcome.reset;
    if (p.tenantId != st.tenantId) return _DeltaOutcome.tenantChanged;
    final changed = _applyPayload(st, p);
    _lastSyncedAt = DateTime.now();
    _clearError();
    if (changed) {
      _dataChanged();
    } else {
      _publishSync();
    }
    return _DeltaOutcome.ok;
  }

  // ---------------------------------------------------------------------------
  // Snapshot + persistence
  // ---------------------------------------------------------------------------

  Future<bool> _runSnapshot(String base) {
    final inFlight = _snapshotFuture;
    if (inFlight != null) return inFlight;
    final f = _doSnapshot(base).whenComplete(() {
      _snapshotFuture = null;
      _publishSync();
    });
    _snapshotFuture = f;
    _publishSync();
    return f;
  }

  Future<bool> _doSnapshot(String base) async {
    final sw = Stopwatch()..start();
    try {
      final dirPath = await _catalogDirPath();
      final bytes = await _api.fetchLiveCatalogSnapshotBytes(timeout: _kSnapshotTimeout);
      if (_disposed) return false;
      final savedAtMs = DateTime.now().millisecondsSinceEpoch;
      final built = await _buildInIsolate(_SnapshotJob(bytes, dirPath, base, savedAtMs));
      if (_disposed) return false;
      _generation++;
      _state = built.state;
      _gateOpen = true;
      _lastSyncedAt = DateTime.now();
      _snapshotFailedAt = null;
      _clearError();
      _dataChanged();
      debugPrint('[LiveCatalog] snapshot loaded items=${built.state.items.length} '
          'skus=${built.state.skus.length} kb=${bytes.length ~/ 1024} ms=${sw.elapsedMilliseconds}'
          '${built.persistError != null ? ' (not saved: ${built.persistError})' : ''}');
      return true;
    } catch (e) {
      if (_disposed) return false;
      _snapshotFailedAt = DateTime.now();
      _noteError('snapshot', e);
      return false;
    }
  }

  Future<void> _loadSaved(String base) async {
    final dirPath = await _catalogDirPath();
    if (dirPath == null || _disposed) return;
    _loadingSaved = true;
    _publishSync();
    final sw = Stopwatch()..start();
    try {
      final r = await _loadInIsolate(_LoadJob(dirPath, base));
      // A snapshot that finished meanwhile is newer than anything on disk.
      if (_disposed || _state != null) return;
      final st = r.state;
      if (st == null) {
        if (r.note != null) debugPrint('[LiveCatalog] saved copy discarded: ${r.note}');
        return;
      }
      _generation++;
      _state = st;
      _gateOpen = false;
      _lastSyncedAt = DateTime.fromMillisecondsSinceEpoch(st.savedAtMs);
      _dataChanged();
      final ageMin = (DateTime.now().millisecondsSinceEpoch - st.savedAtMs) ~/ 60000;
      debugPrint('[LiveCatalog] saved copy loaded items=${st.items.length} '
          'ageMin=$ageMin ms=${sw.elapsedMilliseconds}');
    } catch (e) {
      debugPrint('[LiveCatalog] saved copy unreadable: $e');
    } finally {
      _loadingSaved = false;
      _publishSync();
    }
  }

  Future<String?> _catalogDirPath() async {
    if (_dirResolved) return _dirPath;
    try {
      final d = await getApplicationDocumentsDirectory();
      _dirPath = '${d.path}/$_kDirName';
    } catch (_) {
      // No platform dir (tests / unsupported host): run memory-only.
      _dirPath = null;
    }
    _dirResolved = true;
    return _dirPath;
  }

  Future<void> clearPersisted() async {
    final dirPath = await _catalogDirPath();
    if (dirPath == null) return;
    try {
      final d = Directory(dirPath);
      if (await d.exists()) await d.delete(recursive: true);
    } catch (e) {
      debugPrint('[LiveCatalog] clearPersisted failed: $e');
    }
  }

  // Static so the closures sent to the worker isolate never capture `this`
  // (a ChangeNotifier with timers is not sendable).
  static Future<_BuiltSnapshot> _buildInIsolate(_SnapshotJob job) =>
      Isolate.run(() => _buildSnapshotJob(job), debugName: 'live-catalog-snapshot');

  static Future<_LoadResult> _loadInIsolate(_LoadJob job) =>
      Isolate.run(() => _loadSavedJob(job), debugName: 'live-catalog-load');

  static Future<Object?> _decodeInIsolate(Uint8List bytes) =>
      Isolate.run(() => _decodeJsonBytes(bytes), debugName: 'live-catalog-delta');

  // ---------------------------------------------------------------------------
  // State bookkeeping
  // ---------------------------------------------------------------------------

  void _dropState() {
    if (_state == null) return;
    _generation++;
    _state = null;
    _gateOpen = false;
    _dataChanged();
  }

  void _dataChanged() {
    _version++;
    _binMemo.clear();
    _infoMemo.clear();
    _publishSync();
    if (!_disposed) notifyListeners();
  }

  void _noteError(String what, Object e) {
    var msg = '$what: $e';
    if (msg.length > 200) msg = '${msg.substring(0, 200)}…';
    _lastError = msg;
    // Offline, the 3 s refresh fails every tick — log each distinct error once.
    if (msg != _lastLoggedError) {
      _lastLoggedError = msg;
      debugPrint('[LiveCatalog] $msg');
    }
    _publishSync();
  }

  void _clearError() {
    _lastError = null;
    _lastLoggedError = null;
  }

  bool get _busy =>
      _ensureFuture != null || _snapshotFuture != null || _deltaFuture != null || _loadingSaved;

  LiveCatalogPhase get _phase {
    if (isReady) return LiveCatalogPhase.ready;
    if (_busy) return LiveCatalogPhase.loading;
    if (_lastError != null) return LiveCatalogPhase.error;
    return LiveCatalogPhase.empty;
  }

  void _publishSync() {
    if (_disposed) return;
    _sync.value = LiveCatalogSyncState(
      phase: _phase,
      lastSyncedAt: _lastSyncedAt,
      error: _lastError,
      itemCount: _state?.items.length ?? 0,
      refreshing: _busy,
    );
  }

  @override
  void dispose() {
    _disposed = true;
    _autoTimer?.cancel();
    _autoTimer = null;
    _sync.dispose();
    super.dispose();
  }

  // ---------------------------------------------------------------------------
  // Lookups: synchronous, in-memory, O(1) (bin computation memoized per version)
  // ---------------------------------------------------------------------------

  static String _key(String epc) => epc.trim().toUpperCase();

  /// null = no items row (check [isReady] first).
  String? statusForEpc(String epc) => _state?.items[_key(epc)]?.status;

  bool hasItemRow(String epc) => _state?.items.containsKey(_key(epc)) ?? false;

  /// Via items.custom_sku_id.
  LiveItemInfo? itemInfoForEpc(String epc, {String? locationId}) {
    final skuId = _state?.items[_key(epc)]?.skuId;
    if (skuId == null) return null;
    return _infoForSku(skuId, locationId ?? this.locationId);
  }

  /// Via custom_skus.ls_system_id (decimal text; leading zeros tolerated).
  LiveItemInfo? itemInfoForSystemId(String systemId, {String? locationId}) {
    final skuId = _skuIdForSystemId(systemId);
    if (skuId == null) return null;
    return _infoForSku(skuId, locationId ?? this.locationId);
  }

  String? binDisplayForSku(String skuId, {String? locationId}) {
    final st = _state;
    if (st == null) return null;
    final loc = locationId ?? this.locationId;
    final byLoc = _binMemo.putIfAbsent(loc, () => <String, String?>{});
    if (byLoc.containsKey(skuId)) return byLoc[skuId];
    final v = _computeBinDisplay(st, skuId, loc);
    byLoc[skuId] = v;
    return v;
  }

  /// null when ![isReady].
  AddOnCatalogDecision? classifyForAddOnCatalog(String epc, {String? locationId}) {
    if (!isReady) return null;
    final st = _state!;
    final loc = locationId ?? st.locationId;
    final e = _key(epc);
    return classifyAddOnCatalog(
      epc: e,
      status: st.items[e]?.status,
      cfg: epcConfig,
      skuBySystemId: (sid) {
        final skuId = st.skuIdBySystemId[sid];
        return skuId == null ? null : _infoForSku(skuId, loc);
      },
    );
  }

  String? _skuIdForSystemId(String systemId) {
    final map = _state?.skuIdBySystemId;
    if (map == null) return null;
    final k = systemId.trim();
    final hit = map[k];
    if (hit != null || !k.startsWith('0')) return hit;
    // Callers sometimes hold the display form padded to the catalog width.
    final stripped = k.replaceFirst(_leadingZeros, '');
    return stripped.isEmpty ? null : map[stripped];
  }

  LiveItemInfo? _infoForSku(String skuId, String? loc) {
    final st = _state;
    if (st == null) return null;
    final byLoc = _infoMemo.putIfAbsent(loc, () => <String, LiveItemInfo>{});
    final hit = byLoc[skuId];
    if (hit != null) return hit;
    final s = st.skus[skuId];
    if (s == null) return null;
    final mId = s.matrixId;
    final info = LiveItemInfo(
      skuId: s.id,
      systemId: s.systemId,
      sku: s.sku,
      name: mId != null ? (st.matrixName[mId] ?? '') : '',
      color: s.color ?? '',
      size: s.size ?? '',
      retailPrice: s.retail,
      binDisplay: binDisplayForSku(skuId, locationId: loc),
      archived: s.archived,
    );
    byLoc[skuId] = info;
    return info;
  }

  // ---------------------------------------------------------------------------
  // Test hooks
  // ---------------------------------------------------------------------------

  /// A ready cache built synchronously from a snapshot payload (decoded JSON).
  @visibleForTesting
  static LiveCatalogCache debugFromPayloadJson(
    Map<String, dynamic> snapshot, {
    WmsApiClient? api,
    String baseUrl = '',
  }) {
    final c = LiveCatalogCache(api: api ?? WmsApiClient());
    final st = _CatalogState(baseUrl: baseUrl, savedAtMs: DateTime.now().millisecondsSinceEpoch);
    _applyPayload(st, _parsePayload(snapshot));
    c._state = st;
    c._gateOpen = true;
    c._generation++;
    c._dataChanged();
    return c;
  }

  /// Applies a delta payload exactly as a 3 s refresh does once the bytes are
  /// decoded. Returns true when applied; false for a reset or another tenant
  /// (data untouched — the real refresh would then fetch a snapshot).
  @visibleForTesting
  bool debugApplyDeltaJson(Map<String, dynamic> delta) {
    final st = _state;
    if (st == null) return false;
    return _acceptDelta(st, _parsePayload(delta)) == _DeltaOutcome.ok;
  }

  @visibleForTesting
  String? get debugCursor => _state?.cursor;
}

enum _DeltaOutcome { ok, failed, superseded, reset, tenantChanged, needsSnapshot }

// =============================================================================
// In-memory state (built in a worker isolate for snapshots; mutated in place
// on the UI isolate for deltas).
// =============================================================================

class _Item {
  _Item(this.status, this.skuId, this.binId, this.locId);
  String status; // interned from the payload dictionary
  String? skuId;
  String? binId;
  String? locId;
}

class _Sku {
  _Sku({
    required this.id,
    required this.systemId,
    required this.sku,
    required this.color,
    required this.size,
    required this.matrixId,
    required this.retail,
    required this.assignedBinId,
    required this.archived,
  });
  final String id;
  String? systemId;
  String sku;
  String? color;
  String? size;
  String? matrixId;
  String? retail;
  String? assignedBinId;
  bool archived;
}

class _Bin {
  _Bin(this.code, this.locId, this.archived);
  String code;
  String? locId;
  bool archived;
}

class _CatalogState {
  _CatalogState({required this.baseUrl, required this.savedAtMs});

  final String baseUrl;
  // When the snapshot this state started from was downloaded (drives the
  // 12 h re-baseline); deltas don't move it.
  int savedAtMs;
  String cursor = '';
  String tenantId = '';
  String? locationId;
  EpcConfig? epcCfg;

  final Map<String, _Item> items = {}; // EPC (upper) → item
  final Map<String, _Sku> skus = {}; // custom_skus.id → sku
  final Map<String, String> skuIdBySystemId = {};
  final Map<String, String> matrixName = {}; // matrices.id → description
  final Map<String, _Bin> bins = {};
  final Map<String, Set<String>> epcsBySku = {}; // skuId → EPCs (every status)
  final Map<String, Set<String>> skusByColour = {}; // colour prefix → skuIds
  final Map<String, String> statusIntern = {};
}

/// Port of lib/server/inventory-catalog.ts skuPrefix: a colour is the SKU's
/// first 11 chars for 'C…' SKUs, else the first 9 (whole string if shorter).
String _colourPrefix(String sku) {
  final n = sku.startsWith('C') ? 11 : 9;
  return sku.length <= n ? sku : sku.substring(0, n);
}

/// BIN rule, port of lib/server/inventory-catalog.ts (`bin_location` →
/// colour inheritance → assigned home bin) for SKU [skuId] at location [loc]:
///  1. distinct codes of non-archived bins holding this SKU's in-stock items at [loc];
///  2. else the same over every SKU sharing the colour prefix;
///  3. else the SKU's assigned bin when it is at [loc] and not archived;
///  4. else null.
/// Codes sorted ascending and joined ', ' (same shape as the catalog string_agg).
String? _computeBinDisplay(_CatalogState st, String skuId, String? loc) {
  if (loc == null) return null;
  final codes = <String>{};
  _collectInStockBins(st, skuId, loc, codes);
  final s = st.skus[skuId];
  if (codes.isEmpty && s != null) {
    final siblings = st.skusByColour[_colourPrefix(s.sku)];
    if (siblings != null) {
      for (final sib in siblings) {
        _collectInStockBins(st, sib, loc, codes);
      }
    }
  }
  if (codes.isEmpty) {
    final assigned = s?.assignedBinId;
    if (assigned == null) return null;
    final b = st.bins[assigned];
    if (b == null || b.archived || b.locId != loc) return null;
    return b.code;
  }
  final sorted = codes.toList()..sort();
  return sorted.join(', ');
}

void _collectInStockBins(_CatalogState st, String skuId, String loc, Set<String> out) {
  final epcs = st.epcsBySku[skuId];
  if (epcs == null) return;
  for (final e in epcs) {
    final it = st.items[e];
    if (it == null || it.status != _kInStock || it.locId != loc) continue;
    final binId = it.binId;
    if (binId == null) continue;
    final b = st.bins[binId];
    if (b == null || b.archived) continue;
    out.add(b.code);
  }
}

// =============================================================================
// Payload parsing. Everything is validated BEFORE a delta touches the live
// state, so a malformed payload can never leave it half-applied.
// =============================================================================

class _ParsedPayload {
  _ParsedPayload({
    required this.reset,
    required this.cursor,
    required this.tenantId,
    required this.locationId,
    required this.epcCfg,
  });

  final bool reset;
  final String cursor;
  final String tenantId;
  final String? locationId;
  final EpcConfig? epcCfg;

  List<dynamic> statuses = const [];
  List<dynamic> locId = const [];
  List<dynamic> binId = const [], binCode = const [], binLoc = const [], binArchived = const [];
  List<dynamic> mxId = const [], mxName = const [];
  List<dynamic> skuId = const [],
      skuSystemId = const [],
      skuSku = const [],
      skuColor = const [],
      skuSize = const [],
      skuMatrix = const [],
      skuRetail = const [],
      skuAssignedBin = const [],
      skuArchived = const [];
  List<dynamic> itemEpc = const [],
      itemStatus = const [],
      itemSku = const [],
      itemBin = const [],
      itemLoc = const [];
  List<dynamic> tombItems = const [], tombSkus = const [];
}

Object? _decodeJsonBytes(List<int> bytes) => utf8.decoder.fuse(json.decoder).convert(bytes);

FormatException _bad(String what) => FormatException('live catalog payload: $what');

Map<String, dynamic> _obj(Object? v, String what) {
  if (v is Map<String, dynamic>) return v;
  if (v is Map) return v.cast<String, dynamic>();
  throw _bad('$what missing');
}

List<dynamic> _col(Map<String, dynamic> table, String key, String what, int? n) {
  final v = table[key];
  if (v is! List) throw _bad('$what.$key missing');
  if (n != null && v.length != n) throw _bad('$what.$key length ${v.length} != $n');
  return v;
}

void _checkStrings(List<dynamic> l, String what, {bool nullable = false}) {
  for (final x in l) {
    if (x is String || (nullable && x == null)) continue;
    throw _bad('$what has a non-string');
  }
}

void _checkNumText(List<dynamic> l, String what) {
  for (final x in l) {
    if (x == null || x is String || x is num) continue;
    throw _bad('$what has a non-numeric');
  }
}

void _checkIndexes(List<dynamic> l, String what, int targetLen, {bool allowNone = true}) {
  for (final x in l) {
    if (x is int && x < targetLen && (x >= 0 || (allowNone && x == -1))) continue;
    throw _bad('$what has an out-of-range index');
  }
}

void _checkFlags(List<dynamic> l, String what) {
  for (final x in l) {
    if (x is int || x is bool) continue;
    throw _bad('$what has a non-flag');
  }
}

EpcConfig? _parseEpcCfg(Object? raw) {
  if (raw is! Map) return null;
  return EpcConfig.fromMobileSyncRoot(<String, dynamic>{'epc_config': raw});
}

_ParsedPayload _parsePayload(Object? decoded) {
  final j = _obj(decoded, 'root');
  final v = j['v'];
  if (v != _kPayloadVersion) throw _bad('unsupported version $v');
  final cursor = j['cursor'];
  if (cursor is! String || cursor.isEmpty) throw _bad('cursor missing');
  final tenantId = j['tenantId'];
  if (tenantId is! String || tenantId.isEmpty) throw _bad('tenantId missing');
  final locationId = j['locationId'];
  if (locationId != null && locationId is! String) throw _bad('locationId not a string');
  final p = _ParsedPayload(
    reset: j['reset'] == true,
    cursor: cursor,
    tenantId: tenantId,
    locationId: locationId as String?,
    epcCfg: _parseEpcCfg(j['epcCfg']),
  );
  // A reset carries empty tables and must not be applied anyway.
  if (p.reset) return p;

  final statuses = j['statuses'];
  if (statuses is! List) throw _bad('statuses missing');
  _checkStrings(statuses, 'statuses');
  p.statuses = statuses;

  final loc = _obj(j['locations'], 'locations');
  p.locId = _col(loc, 'id', 'locations', null);
  _checkStrings(p.locId, 'locations.id');

  final bins = _obj(j['bins'], 'bins');
  p.binId = _col(bins, 'id', 'bins', null);
  final nb = p.binId.length;
  p.binCode = _col(bins, 'code', 'bins', nb);
  p.binLoc = _col(bins, 'loc', 'bins', nb);
  p.binArchived = _col(bins, 'archived', 'bins', nb);
  _checkStrings(p.binId, 'bins.id');
  _checkStrings(p.binCode, 'bins.code', nullable: true);
  _checkIndexes(p.binLoc, 'bins.loc', p.locId.length);
  _checkFlags(p.binArchived, 'bins.archived');

  final mx = _obj(j['matrices'], 'matrices');
  p.mxId = _col(mx, 'id', 'matrices', null);
  p.mxName = _col(mx, 'name', 'matrices', p.mxId.length);
  _checkStrings(p.mxId, 'matrices.id');
  _checkStrings(p.mxName, 'matrices.name', nullable: true);

  final skus = _obj(j['skus'], 'skus');
  p.skuId = _col(skus, 'id', 'skus', null);
  final ns = p.skuId.length;
  p.skuSystemId = _col(skus, 'systemId', 'skus', ns);
  p.skuSku = _col(skus, 'sku', 'skus', ns);
  p.skuColor = _col(skus, 'color', 'skus', ns);
  p.skuSize = _col(skus, 'size', 'skus', ns);
  p.skuMatrix = _col(skus, 'matrix', 'skus', ns);
  p.skuRetail = _col(skus, 'retail', 'skus', ns);
  p.skuAssignedBin = _col(skus, 'assignedBin', 'skus', ns);
  p.skuArchived = _col(skus, 'archived', 'skus', ns);
  _checkStrings(p.skuId, 'skus.id');
  _checkNumText(p.skuSystemId, 'skus.systemId');
  _checkStrings(p.skuSku, 'skus.sku', nullable: true);
  _checkStrings(p.skuColor, 'skus.color', nullable: true);
  _checkStrings(p.skuSize, 'skus.size', nullable: true);
  _checkIndexes(p.skuMatrix, 'skus.matrix', p.mxId.length);
  _checkNumText(p.skuRetail, 'skus.retail');
  _checkIndexes(p.skuAssignedBin, 'skus.assignedBin', nb);
  _checkFlags(p.skuArchived, 'skus.archived');

  final items = _obj(j['items'], 'items');
  p.itemEpc = _col(items, 'epc', 'items', null);
  final ni = p.itemEpc.length;
  p.itemStatus = _col(items, 'status', 'items', ni);
  p.itemSku = _col(items, 'sku', 'items', ni);
  p.itemBin = _col(items, 'bin', 'items', ni);
  p.itemLoc = _col(items, 'loc', 'items', ni);
  _checkStrings(p.itemEpc, 'items.epc');
  _checkIndexes(p.itemStatus, 'items.status', statuses.length, allowNone: false);
  _checkIndexes(p.itemSku, 'items.sku', ns);
  _checkIndexes(p.itemBin, 'items.bin', nb);
  _checkIndexes(p.itemLoc, 'items.loc', p.locId.length);

  final tomb = j['tombstones'];
  if (tomb is Map) {
    final t = tomb.cast<String, dynamic>();
    final ti = t['items'];
    final ts = t['skus'];
    if (ti is List) {
      _checkStrings(ti, 'tombstones.items');
      p.tombItems = ti;
    }
    if (ts is List) {
      _checkStrings(ts, 'tombstones.skus');
      p.tombSkus = ts;
    }
  }
  return p;
}

String? _strOrNull(Object? v) => v is String ? v : v?.toString();
String _str(Object? v) => v is String ? v : (v?.toString() ?? '');
bool _flag(Object? v) => v == true || v == 1;

void _removeFromIndex(Map<String, Set<String>> index, String key, String value) {
  final set = index[key];
  if (set == null) return;
  set.remove(value);
  if (set.isEmpty) index.remove(key);
}

bool _sameCfg(EpcConfig? a, EpcConfig b) =>
    a != null &&
    a.prefixHex == b.prefixHex &&
    a.prefixBits == b.prefixBits &&
    a.assetBits == b.assetBits &&
    a.serialBits == b.serialBits &&
    a.assetPaddingDigits == b.assetPaddingDigits;

/// Applies a validated payload to [st]. For a snapshot [st] is brand new; for
/// a delta it is the live state (synchronous, so lookups never see a half
/// apply). Order: tombstones → bins → matrices → SKUs → items → header.
/// Returns true when anything observable changed.
bool _applyPayload(_CatalogState st, _ParsedPayload p) {
  var changed = false;

  // 1. Tombstones.
  for (final raw in p.tombItems) {
    final epc = (raw as String).toUpperCase();
    final it = st.items.remove(epc);
    if (it == null) continue;
    changed = true;
    final sid = it.skuId;
    if (sid != null) _removeFromIndex(st.epcsBySku, sid, epc);
  }
  for (final raw in p.tombSkus) {
    final s = st.skus.remove(raw as String);
    if (s == null) continue;
    changed = true;
    final sys = s.systemId;
    if (sys != null && st.skuIdBySystemId[sys] == s.id) st.skuIdBySystemId.remove(sys);
    _removeFromIndex(st.skusByColour, _colourPrefix(s.sku), s.id);
  }

  // 2. Bins (locations only translate indexes; the phone keeps location ids).
  for (var i = 0; i < p.binId.length; i++) {
    final id = p.binId[i] as String;
    final code = _str(p.binCode[i]);
    final li = p.binLoc[i] as int;
    final locId = li >= 0 ? p.locId[li] as String : null;
    final archived = _flag(p.binArchived[i]);
    final cur = st.bins[id];
    if (cur == null) {
      st.bins[id] = _Bin(code, locId, archived);
      changed = true;
    } else if (cur.code != code || cur.locId != locId || cur.archived != archived) {
      cur
        ..code = code
        ..locId = locId
        ..archived = archived;
      changed = true;
    }
  }

  // 3. Matrices (the product name on a line).
  for (var i = 0; i < p.mxId.length; i++) {
    final id = p.mxId[i] as String;
    final name = _str(p.mxName[i]);
    if (st.matrixName[id] != name) {
      st.matrixName[id] = name;
      changed = true;
    }
  }

  // 4. SKUs — re-map systemId and colour prefix when they change.
  for (var i = 0; i < p.skuId.length; i++) {
    final id = p.skuId[i] as String;
    final sysId = _strOrNull(p.skuSystemId[i]);
    final skuText = _str(p.skuSku[i]);
    final color = _strOrNull(p.skuColor[i]);
    final size = _strOrNull(p.skuSize[i]);
    final mi = p.skuMatrix[i] as int;
    final matrixId = mi >= 0 ? p.mxId[mi] as String : null;
    final retail = _strOrNull(p.skuRetail[i]);
    final bi = p.skuAssignedBin[i] as int;
    final assignedBinId = bi >= 0 ? p.binId[bi] as String : null;
    final archived = _flag(p.skuArchived[i]);

    final cur = st.skus[id];
    if (cur == null) {
      st.skus[id] = _Sku(
        id: id,
        systemId: sysId,
        sku: skuText,
        color: color,
        size: size,
        matrixId: matrixId,
        retail: retail,
        assignedBinId: assignedBinId,
        archived: archived,
      );
      (st.skusByColour[_colourPrefix(skuText)] ??= <String>{}).add(id);
      changed = true;
    } else {
      if (cur.systemId != sysId) {
        final old = cur.systemId;
        // Only release the old mapping if it still points here: in a swap,
        // another SKU processed earlier in this payload may already own it.
        if (old != null && st.skuIdBySystemId[old] == id) st.skuIdBySystemId.remove(old);
        cur.systemId = sysId;
        changed = true;
      }
      if (cur.sku != skuText) {
        final oldPrefix = _colourPrefix(cur.sku);
        final newPrefix = _colourPrefix(skuText);
        if (oldPrefix != newPrefix) {
          _removeFromIndex(st.skusByColour, oldPrefix, id);
          (st.skusByColour[newPrefix] ??= <String>{}).add(id);
        }
        cur.sku = skuText;
        changed = true;
      }
      if (cur.color != color ||
          cur.size != size ||
          cur.matrixId != matrixId ||
          cur.retail != retail ||
          cur.assignedBinId != assignedBinId ||
          cur.archived != archived) {
        cur
          ..color = color
          ..size = size
          ..matrixId = matrixId
          ..retail = retail
          ..assignedBinId = assignedBinId
          ..archived = archived;
        changed = true;
      }
    }
    if (sysId != null && st.skuIdBySystemId[sysId] != id) {
      st.skuIdBySystemId[sysId] = id;
      changed = true;
    }
  }

  // 5. Items — move between skuId → EPC sets when the SKU changes.
  final statuses = [
    for (final s in p.statuses) st.statusIntern.putIfAbsent(s as String, () => s),
  ];
  for (var i = 0; i < p.itemEpc.length; i++) {
    final epc = (p.itemEpc[i] as String).toUpperCase();
    final status = statuses[p.itemStatus[i] as int];
    final si = p.itemSku[i] as int;
    final skuId = si >= 0 ? p.skuId[si] as String : null;
    final bi = p.itemBin[i] as int;
    final binId = bi >= 0 ? p.binId[bi] as String : null;
    final li = p.itemLoc[i] as int;
    final locId = li >= 0 ? p.locId[li] as String : null;

    final cur = st.items[epc];
    if (cur == null) {
      st.items[epc] = _Item(status, skuId, binId, locId);
      if (skuId != null) (st.epcsBySku[skuId] ??= <String>{}).add(epc);
      changed = true;
      continue;
    }
    if (cur.skuId != skuId) {
      final old = cur.skuId;
      if (old != null) _removeFromIndex(st.epcsBySku, old, epc);
      if (skuId != null) (st.epcsBySku[skuId] ??= <String>{}).add(epc);
      cur.skuId = skuId;
      changed = true;
    }
    if (cur.status != status || cur.binId != binId || cur.locId != locId) {
      cur
        ..status = status
        ..binId = binId
        ..locId = locId;
      changed = true;
    }
  }

  // 6. Header.
  final cfg = p.epcCfg;
  if (cfg != null && !_sameCfg(st.epcCfg, cfg)) {
    st.epcCfg = cfg;
    changed = true;
  }
  if (st.locationId != p.locationId) {
    st.locationId = p.locationId;
    changed = true;
  }
  st.tenantId = p.tenantId;
  st.cursor = p.cursor;
  return changed;
}

// =============================================================================
// Worker-isolate jobs (top-level: only plain data crosses the boundary).
// =============================================================================

class _SnapshotJob {
  const _SnapshotJob(this.bytes, this.dirPath, this.baseUrl, this.savedAtMs);
  final Uint8List bytes;
  final String? dirPath;
  final String baseUrl;
  final int savedAtMs;
}

class _BuiltSnapshot {
  const _BuiltSnapshot(this.state, this.persistError);
  final _CatalogState state;
  final String? persistError;
}

class _LoadJob {
  const _LoadJob(this.dirPath, this.baseUrl);
  final String dirPath;
  final String baseUrl;
}

class _LoadResult {
  const _LoadResult(this.state, this.note);
  final _CatalogState? state;
  final String? note;
}

/// Decode + build a brand-new state, then save the snapshot (gzipped) in the
/// same isolate so the multi-MB bytes are never copied back.
_BuiltSnapshot _buildSnapshotJob(_SnapshotJob job) {
  final p = _parsePayload(_decodeJsonBytes(job.bytes));
  if (p.reset) throw _bad('snapshot flagged reset');
  final st = _CatalogState(baseUrl: job.baseUrl, savedAtMs: job.savedAtMs);
  _applyPayload(st, p);
  String? persistError;
  final dirPath = job.dirPath;
  if (dirPath != null) {
    try {
      Directory(dirPath).createSync(recursive: true);
      _atomicWrite(File('$dirPath/$_kSnapshotFile'), GZipCodec(level: 4).encode(job.bytes));
      _atomicWrite(
        File('$dirPath/$_kMetaFile'),
        utf8.encode(jsonEncode(<String, dynamic>{
          'v': 1,
          'cursor': st.cursor,
          'savedAtMs': job.savedAtMs,
          'tenantId': st.tenantId,
          'baseUrl': job.baseUrl,
          'itemCount': st.items.length,
        })),
      );
    } catch (e) {
      persistError = '$e';
    }
  }
  return _BuiltSnapshot(st, persistError);
}

void _atomicWrite(File target, List<int> bytes) {
  final tmp = File('${target.path}.tmp');
  tmp.writeAsBytesSync(bytes, flush: true);
  tmp.renameSync(target.path);
}

void _deleteSaved(String dirPath) {
  for (final name in [_kMetaFile, _kSnapshotFile]) {
    try {
      final f = File('$dirPath/$name');
      if (f.existsSync()) f.deleteSync();
    } catch (_) {/* best effort */}
  }
}

_LoadResult _loadSavedJob(_LoadJob job) {
  final metaFile = File('${job.dirPath}/$_kMetaFile');
  final snapFile = File('${job.dirPath}/$_kSnapshotFile');
  if (!metaFile.existsSync() || !snapFile.existsSync()) {
    return const _LoadResult(null, null);
  }
  try {
    final meta = jsonDecode(metaFile.readAsStringSync());
    if (meta is! Map || meta['v'] != 1) throw _bad('meta version');
    if (meta['baseUrl'] != job.baseUrl) {
      _deleteSaved(job.dirPath);
      return const _LoadResult(null, 'saved for another server');
    }
    final savedAtMs = meta['savedAtMs'];
    if (savedAtMs is! num) throw _bad('meta savedAtMs');
    final p = _parsePayload(_decodeJsonBytes(gzip.decode(snapFile.readAsBytesSync())));
    if (p.reset || meta['tenantId'] != p.tenantId) throw _bad('meta does not match snapshot');
    final st = _CatalogState(baseUrl: job.baseUrl, savedAtMs: savedAtMs.toInt());
    _applyPayload(st, p);
    return _LoadResult(st, null);
  } catch (e) {
    _deleteSaved(job.dirPath);
    return _LoadResult(null, '$e');
  }
}
