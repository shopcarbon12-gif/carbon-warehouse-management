import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/epc/epc_codec.dart';
import 'package:carbon_wms/services/live_catalog_cache.dart';
import 'package:carbon_wms/services/live_catalog_models.dart';
import 'package:carbon_wms/ui/widgets/item_line_format.dart';

const _sid1 = '210000006025';
const _sid4 = '210000007001';
const _tenant = 'tenant-1';

// EPCs that decode (primary F0A0B formula) to _sid1 — BIN/info lookups go
// through items.custom_sku_id, classification through the decoded system id.
final _e1 = buildEpc(210000006025, 1);
final _e2 = buildEpc(210000006025, 2);
final _e3 = buildEpc(210000006025, 3);
final _e4 = buildEpc(210000006025, 4);
final _e5 = buildEpc(210000006025, 5);
final _e6 = buildEpc(210000006025, 6);

Map<String, dynamic> _table(Map<String, List<Object?>> cols) => cols;

/// Columnar payload exactly as lib/server/live-catalog.ts emits it.
Map<String, dynamic> _payload({
  String kind = 'delta',
  bool reset = false,
  String cursor = 'v1.1760363000.200.',
  String tenantId = _tenant,
  String? locationId = 'L1',
  List<String> statuses = const [],
  Map<String, List<Object?>>? bins,
  Map<String, List<Object?>>? matrices,
  Map<String, List<Object?>>? skus,
  Map<String, List<Object?>>? items,
  List<String> tombItems = const [],
  List<String> tombSkus = const [],
}) {
  return <String, dynamic>{
    'v': 1,
    'kind': kind,
    'reset': reset,
    'cursor': cursor,
    'serverTime': '2026-10-13T12:00:00.000Z',
    'tenantId': tenantId,
    'locationId': locationId,
    'epcCfg': {
      'prefixHex': 'F0A0B',
      'prefixBits': 20,
      'assetBits': 40,
      'serialBits': 36,
      'assetPaddingDigits': 13,
    },
    'statuses': statuses,
    'locations': _table({
      'id': ['L1', 'L2'],
      'code': ['ORL', 'MIA'],
      'name': ['Orlando', 'Miami'],
    }),
    'bins': _table(bins ?? {'id': [], 'code': [], 'loc': [], 'archived': []}),
    'matrices': _table(matrices ?? {'id': [], 'name': []}),
    'skus': _table(skus ??
        {
          'id': [],
          'systemId': [],
          'sku': [],
          'color': [],
          'size': [],
          'matrix': [],
          'retail': [],
          'assignedBin': [],
          'archived': [],
        }),
    'items': _table(items ?? {'epc': [], 'status': [], 'sku': [], 'bin': [], 'loc': []}),
    'tombstones': {'items': tombItems, 'skus': tombSkus},
    'counts': {'items': items?['epc']?.length ?? 0, 'skus': skus?['id']?.length ?? 0},
  };
}

/// Bins (L1 unless noted): B1 3C05R, B2 1A01A, B3 2B02B archived, B4 9Z99Z at L2.
/// SKUs: S1 (sid1, colour C1251100402), S2 sibling colour, S3 non-C SKU,
///       S4 home bin B2, S5 home bin B4 (L2), S6 home bin B3 (archived).
/// Items of S1: e1 in-stock B1@L1, e2 in-stock B3(archived)@L1,
///              e3 in-stock B4@L2, e4 sold B2@L1, e5 in-stock B2@L1.
/// e6: 'unknown' row with no SKU.
Map<String, dynamic> _snapshot() => _payload(
      kind: 'snapshot',
      cursor: 'v1.1760363000.100.',
      statuses: ['in-stock', 'sold', 'unknown'],
      bins: {
        'id': ['B1', 'B2', 'B3', 'B4'],
        'code': ['3C05R', '1A01A', '2B02B', '9Z99Z'],
        'loc': [0, 0, 0, 1],
        'archived': [0, 0, 1, 0],
      },
      matrices: {
        'id': ['M1', 'M2'],
        'name': ['ELODIE TOP BLACK S', null],
      },
      skus: {
        'id': ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'],
        'systemId': [_sid1, '210000006026', '210000006027', _sid4, '210000007002', '210000007003'],
        'sku': ['C12511004024', 'C12511004025', '21000000101', 'C99999999991', 'C88888888881', 'C77777777771'],
        'color': ['BLACK', 'BLACK', null, 'RED', 'BLUE', 'GREEN'],
        'size': ['S', 'M', null, 'L', 'XL', 'XS'],
        'matrix': [0, 0, -1, 1, 1, 1],
        'retail': ['52.00', '52.00', null, '0', '10.5', null],
        'assignedBin': [-1, -1, -1, 1, 3, 2],
        'archived': [0, 0, 0, 0, 0, 1],
      },
      items: {
        'epc': [_e1, _e2, _e3, _e4, _e5, _e6],
        'status': [0, 0, 0, 1, 0, 2],
        'sku': [0, 0, 0, 0, 0, -1],
        'bin': [0, 2, 3, 1, 1, -1],
        'loc': [0, 0, 1, 0, 0, 0],
      },
    );

/// Serves canned payloads in place of the server (no HTTP).
class _FakeApi extends WmsApiClient {
  _FakeApi(this.snapshot, {this.baseUrl = 'https://wms.test'});

  final String baseUrl;

  Map<String, dynamic> snapshot;
  final List<Object> deltas = []; // payload maps or exceptions, consumed in order
  final List<String> cursors = [];
  int snapshotCalls = 0;

  @override
  Future<String> resolveBaseUrl() async => baseUrl;

  @override
  Future<Uint8List> fetchLiveCatalogSnapshotBytes({
    Duration timeout = const Duration(seconds: 60),
  }) async {
    snapshotCalls++;
    await Future<void>.delayed(const Duration(milliseconds: 5));
    return utf8.encode(jsonEncode(snapshot));
  }

  @override
  Future<Uint8List> fetchLiveCatalogDeltaBytes(
    String cursor, {
    Duration timeout = const Duration(seconds: 6),
  }) async {
    cursors.add(cursor);
    await Future<void>.delayed(const Duration(milliseconds: 5));
    final next = deltas.removeAt(0);
    if (next is Exception) throw next;
    return utf8.encode(jsonEncode(next));
  }
}

Future<void> _waitFor(bool Function() done) async {
  for (var i = 0; i < 300 && !done(); i++) {
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
}

void main() {
  late LiveCatalogCache cache;

  setUp(() {
    cache = LiveCatalogCache.debugFromPayloadJson(_snapshot());
  });

  tearDown(() => cache.dispose());

  group('snapshot', () {
    test('ready with header fields', () {
      expect(cache.isReady, isTrue);
      expect(cache.tenantId, _tenant);
      expect(cache.locationId, 'L1');
      expect(cache.epcConfig.prefixHex, 'F0A0B');
      expect(cache.debugCursor, 'v1.1760363000.100.');
      expect(cache.syncState.value.phase, LiveCatalogPhase.ready);
      expect(cache.syncState.value.itemCount, 6);
    });

    test('status lookups are case-insensitive; null = no row', () {
      expect(cache.statusForEpc(_e1.toLowerCase()), 'in-stock');
      expect(cache.statusForEpc(_e4), 'sold');
      expect(cache.hasItemRow(_e6), isTrue);
      expect(cache.statusForEpc(buildEpc(210000006025, 999)), isNull);
      expect(cache.hasItemRow(buildEpc(210000006025, 999)), isFalse);
    });

    test('item info via EPC and via system id (padded form too)', () {
      final a = cache.itemInfoForEpc(_e1)!;
      expect(a.skuId, 'S1');
      expect(a.systemId, _sid1);
      expect(a.sku, 'C12511004024');
      expect(a.name, 'ELODIE TOP BLACK S');
      expect(a.color, 'BLACK');
      expect(a.size, 'S');
      expect(a.retailPrice, '52.00');
      expect(stripNameSizeSuffix(a.name, size: a.size, color: a.color), 'ELODIE TOP');
      expect(formatRetailPrice(a.retailPrice), r'$52.00');
      expect(cache.itemInfoForSystemId(_sid1)!.skuId, 'S1');
      expect(cache.itemInfoForSystemId('0$_sid1')!.skuId, 'S1');
      expect(cache.itemInfoForSystemId('999'), isNull);
      expect(cache.itemInfoForEpc(_e6), isNull); // row without a SKU
      final s3 = cache.itemInfoForSystemId('210000006027')!;
      expect(s3.name, ''); // no matrix
      expect(s3.color, '');
      expect(s3.size, '');
      expect(cache.itemInfoForSystemId('210000007003')!.archived, isTrue);
    });

    test('classification uses the local copy', () {
      expect(cache.classifyForAddOnCatalog(_e1)!.verdict, AddOnCatalogVerdict.ignore);
      final fresh = cache.classifyForAddOnCatalog(buildEpc(210000006025, 999))!;
      expect(fresh.verdict, AddOnCatalogVerdict.qualify);
      expect(fresh.info!.skuId, 'S1');
      expect(fresh.info!.binDisplay, '1A01A, 3C05R');
      // 'unknown' row whose EPC resolves by system id → qualify.
      expect(cache.classifyForAddOnCatalog(_e6)!.verdict, AddOnCatalogVerdict.qualify);
      // Unknown system id, no row → defective.
      expect(
        cache.classifyForAddOnCatalog(buildEpc(219999999999, 1))!.verdict,
        AddOnCatalogVerdict.defective,
      );
    });
  });

  group('BIN rule', () {
    test('1: own in-stock bins at the location, archived bins and other locations excluded', () {
      // e1 B1 + e5 B2 count; e2 (archived B3), e3 (L2), e4 (sold) do not.
      expect(cache.binDisplayForSku('S1'), '1A01A, 3C05R');
      expect(formatBinDisplay(cache.binDisplayForSku('S1')), '1-A-01-A x2');
      expect(cache.binDisplayForSku('S1', locationId: 'L2'), '9Z99Z');
    });

    test('2: colour inheritance from in-stock siblings', () {
      expect(cache.binDisplayForSku('S2'), '1A01A, 3C05R');
      expect(cache.itemInfoForSystemId('210000006026')!.binDisplay, '1A01A, 3C05R');
    });

    test('3: assigned home bin only when at the location and not archived', () {
      expect(cache.binDisplayForSku('S4'), '1A01A');
      expect(cache.binDisplayForSku('S5'), isNull); // home bin is at L2
      expect(cache.binDisplayForSku('S5', locationId: 'L2'), '9Z99Z');
      expect(cache.binDisplayForSku('S6'), isNull); // home bin archived
    });

    test('4: nothing → null', () {
      expect(cache.binDisplayForSku('S3'), isNull);
      expect(cache.binDisplayForSku('nope'), isNull);
    });
  });

  group('delta', () {
    test('upsert moves an EPC to another SKU and recomputes bins', () {
      final v0 = cache.version;
      var notified = 0;
      cache.addListener(() => notified++);
      final ok = cache.debugApplyDeltaJson(_payload(
        statuses: ['in-stock'],
        bins: {
          'id': ['B2'],
          'code': ['1A01A'],
          'loc': [0],
          'archived': [0],
        },
        matrices: {
          'id': ['M1'],
          'name': ['ELODIE TOP BLACK S'],
        },
        skus: {
          'id': ['S2'],
          'systemId': ['210000006026'],
          'sku': ['C12511004025'],
          'color': ['BLACK'],
          'size': ['M'],
          'matrix': [0],
          'retail': ['52.00'],
          'assignedBin': [-1],
          'archived': [0],
        },
        items: {
          'epc': [_e1],
          'status': [0],
          'sku': [0],
          'bin': [0],
          'loc': [0],
        },
      ));
      expect(ok, isTrue);
      expect(cache.version, greaterThan(v0));
      expect(notified, 1);
      expect(cache.debugCursor, 'v1.1760363000.200.');
      expect(cache.itemInfoForEpc(_e1)!.skuId, 'S2');
      // S1 keeps only e5 (B2); S2 now owns e1 (B2) itself.
      expect(cache.binDisplayForSku('S1'), '1A01A');
      expect(cache.binDisplayForSku('S2'), '1A01A');
    });

    test('new rows: an unknown EPC appears and qualifies', () {
      final e9 = buildEpc(210000007001, 9);
      expect(cache.classifyForAddOnCatalog(e9)!.verdict, AddOnCatalogVerdict.qualify);
      cache.debugApplyDeltaJson(_payload(
        statuses: ['in-stock'],
        items: {
          'epc': [e9],
          'status': [0],
          'sku': [-1],
          'bin': [-1],
          'loc': [0],
        },
      ));
      expect(cache.statusForEpc(e9), 'in-stock');
      expect(cache.classifyForAddOnCatalog(e9)!.verdict, AddOnCatalogVerdict.ignore);
    });

    test('status change flips a decision (in-stock → tag_killed stays silent)', () {
      cache.debugApplyDeltaJson(_payload(
        statuses: ['tag_killed'],
        items: {
          'epc': [_e5],
          'status': [0],
          'sku': [-1],
          'bin': [-1],
          'loc': [0],
        },
      ));
      expect(cache.statusForEpc(_e5), 'tag_killed');
      expect(cache.classifyForAddOnCatalog(_e5)!.verdict, AddOnCatalogVerdict.ignore);
      // e5 left S1 and its bin: S1 is down to e1's B1.
      expect(cache.binDisplayForSku('S1'), '3C05R');
    });

    test('tombstones remove items and SKUs (and their system-id mapping)', () {
      final ok = cache.debugApplyDeltaJson(_payload(tombItems: [_e5.toLowerCase()], tombSkus: ['S3']));
      expect(ok, isTrue);
      expect(cache.statusForEpc(_e5), isNull);
      expect(cache.hasItemRow(_e5), isFalse);
      expect(cache.binDisplayForSku('S1'), '3C05R');
      expect(cache.itemInfoForSystemId('210000006027'), isNull);
      // Tombstoned EPC is "no row" again → resolves → qualifies.
      expect(cache.classifyForAddOnCatalog(_e5)!.verdict, AddOnCatalogVerdict.qualify);
    });

    test('system id remap (swap between two SKUs in one delta)', () {
      cache.debugApplyDeltaJson(_payload(
        skus: {
          'id': ['S1', 'S4'],
          'systemId': [_sid4, _sid1],
          'sku': ['C12511004024', 'C99999999991'],
          'color': ['BLACK', 'RED'],
          'size': ['S', 'L'],
          'matrix': [-1, -1],
          'retail': ['52.00', '0'],
          'assignedBin': [-1, -1],
          'archived': [0, 0],
        },
      ));
      expect(cache.itemInfoForSystemId(_sid1)!.skuId, 'S4');
      expect(cache.itemInfoForSystemId(_sid4)!.skuId, 'S1');
      // Matrix reference dropped → name falls back to ''.
      expect(cache.itemInfoForSystemId(_sid4)!.name, '');
    });

    test('SKU text change moves it to another colour group', () {
      cache.debugApplyDeltaJson(_payload(
        skus: {
          'id': ['S2'],
          'systemId': ['210000006026'],
          'sku': ['C55555555551'],
          'color': ['BLACK'],
          'size': ['M'],
          'matrix': [-1],
          'retail': ['52.00'],
          'assignedBin': [-1],
          'archived': [0],
        },
      ));
      // No longer a sibling of S1 and has no stock / home bin of its own.
      expect(cache.binDisplayForSku('S2'), isNull);
    });

    test('bin archived by a delta drops out of the BIN line', () {
      cache.debugApplyDeltaJson(_payload(bins: {
        'id': ['B1'],
        'code': ['3C05R'],
        'loc': [0],
        'archived': [1],
      }));
      expect(cache.binDisplayForSku('S1'), '1A01A');
    });

    test('empty delta moves the cursor without a notify', () {
      final v0 = cache.version;
      var notified = 0;
      cache.addListener(() => notified++);
      expect(cache.debugApplyDeltaJson(_payload(cursor: 'v1.1760363003.300.')), isTrue);
      expect(cache.version, v0);
      expect(notified, 0);
      expect(cache.debugCursor, 'v1.1760363003.300.');
    });

    test('reset:true leaves the data untouched', () {
      final v0 = cache.version;
      final ok = cache.debugApplyDeltaJson(_payload(reset: true, cursor: 'v1.1760363009.900.'));
      expect(ok, isFalse);
      expect(cache.version, v0);
      expect(cache.debugCursor, 'v1.1760363000.100.');
      expect(cache.statusForEpc(_e1), 'in-stock');
      expect(cache.isReady, isTrue);
    });

    test('another tenant is not applied', () {
      final v0 = cache.version;
      final ok = cache.debugApplyDeltaJson(_payload(
        tenantId: 'tenant-2',
        tombItems: [_e1],
      ));
      expect(ok, isFalse);
      expect(cache.version, v0);
      expect(cache.statusForEpc(_e1), 'in-stock');
    });

    test('a malformed delta throws before touching anything', () {
      final v0 = cache.version;
      expect(
        () => cache.debugApplyDeltaJson(_payload(
          tombItems: [_e1],
          statuses: ['sold'],
          items: {
            'epc': [_e5],
            'status': [0],
            'sku': [7], // out of range for this payload
            'bin': [-1],
            'loc': [0],
          },
        )),
        throwsFormatException,
      );
      expect(cache.version, v0);
      expect(cache.statusForEpc(_e1), 'in-stock'); // tombstone not applied
      expect(cache.statusForEpc(_e5), 'in-stock');
    });

    test('location change re-targets the BIN line', () {
      cache.debugApplyDeltaJson(_payload(locationId: 'L2'));
      expect(cache.locationId, 'L2');
      expect(cache.itemInfoForEpc(_e1)!.binDisplay, '9Z99Z');
    });
  });

  group('network paths (fake server)', () {
    TestWidgetsFlutterBinding.ensureInitialized();

    late _FakeApi api;
    late LiveCatalogCache live;

    setUp(() {
      api = _FakeApi(_snapshot());
      live = LiveCatalogCache(api: api);
    });

    tearDown(() => live.dispose());

    test('ensureFresh: concurrent callers share one snapshot load', () async {
      expect(live.isReady, isFalse);
      final a = live.ensureFresh();
      final b = live.ensureFresh();
      expect(identical(a, b), isTrue);
      expect(live.syncState.value.phase, LiveCatalogPhase.loading);
      await a;
      expect(api.snapshotCalls, 1);
      expect(live.isReady, isTrue);
      expect(live.statusForEpc(_e1), 'in-stock');
      expect(live.syncState.value.phase, LiveCatalogPhase.ready);
      expect(live.syncState.value.refreshing, isFalse);
      expect(live.lastSyncedAt, isNotNull);
    });

    test('refresh pulls a delta from the current cursor; concurrent calls share it', () async {
      await live.ensureFresh();
      api.deltas.add(_payload(
        cursor: 'v1.1760363003.300.',
        statuses: ['sold'],
        items: {
          'epc': [_e1],
          'status': [0],
          'sku': [-1],
          'bin': [-1],
          'loc': [0],
        },
      ));
      final a = live.refresh();
      final b = live.refresh();
      expect(await a, isTrue);
      expect(await b, isTrue);
      expect(api.cursors, ['v1.1760363000.100.']);
      expect(live.statusForEpc(_e1), 'sold');
      expect(live.debugCursor, 'v1.1760363003.300.');
    });

    test('a failed delta keeps the data and reports the error', () async {
      await live.ensureFresh();
      api.deltas.add(Exception('offline'));
      expect(await live.refresh(), isFalse);
      expect(live.isReady, isTrue);
      expect(live.statusForEpc(_e1), 'in-stock');
      expect(live.lastError, contains('offline'));
      expect(live.syncState.value.error, isNotNull);
      expect(live.syncState.value.phase, LiveCatalogPhase.ready);
      // Next success clears it.
      api.deltas.add(_payload(cursor: 'v1.1760363006.400.'));
      expect(await live.refresh(), isTrue);
      expect(live.lastError, isNull);
    });

    test('reset → returns false, keeps data, re-snapshots in the background', () async {
      await live.ensureFresh();
      api.snapshot = _payload(
        kind: 'snapshot',
        cursor: 'v1.1760369999.999.',
        statuses: ['sold'],
        items: {
          'epc': [_e1],
          'status': [0],
          'sku': [-1],
          'bin': [-1],
          'loc': [0],
        },
      );
      api.deltas.add(_payload(reset: true, cursor: 'v1.1760369999.999.'));
      expect(await live.refresh(), isFalse);
      expect(live.statusForEpc(_e1), 'in-stock'); // untouched until the swap
      await _waitFor(() => live.debugCursor == 'v1.1760369999.999.');
      expect(api.snapshotCalls, 2);
      expect(live.statusForEpc(_e1), 'sold');
      expect(live.hasItemRow(_e5), isFalse); // brand-new state, not merged
    });

    test('another tenant on a delta drops the copy and reloads', () async {
      await live.ensureFresh();
      api.snapshot = _payload(kind: 'snapshot', tenantId: 'tenant-2', cursor: 'v1.1760369999.5.');
      api.deltas.add(_payload(tenantId: 'tenant-2'));
      expect(await live.refresh(), isFalse);
      await _waitFor(() => live.tenantId == 'tenant-2');
      expect(live.isReady, isTrue);
      expect(live.hasItemRow(_e1), isFalse);
    });

    test('auto-refresh is ref-counted', () async {
      await live.ensureFresh();
      live.startAutoRefresh();
      live.startAutoRefresh();
      live.stopAutoRefresh();
      api.deltas.add(_payload(cursor: 'v1.1760363003.301.'));
      await _waitFor(() => api.cursors.isNotEmpty);
      expect(api.cursors, hasLength(1)); // still running with one holder
      live.stopAutoRefresh();
      live.stopAutoRefresh(); // extra stop is harmless
      await Future<void>.delayed(const Duration(milliseconds: 3200));
      expect(api.cursors, hasLength(1)); // stopped
    });
  });

  group('persistence', () {
    TestWidgetsFlutterBinding.ensureInitialized();
    const channel = MethodChannel('plugins.flutter.io/path_provider');
    late Directory tmp;

    setUp(() {
      tmp = Directory.systemTemp.createTempSync('live_catalog_test');
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async => tmp.path);
    });

    tearDown(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null);
      tmp.deleteSync(recursive: true);
    });

    test('snapshot is saved; next start loads it and pulls a delta from its cursor', () async {
      final first = LiveCatalogCache(api: _FakeApi(_snapshot()));
      await first.ensureFresh();
      first.dispose();
      expect(File('${tmp.path}/live_catalog/snapshot_v1.json.gz').existsSync(), isTrue);
      final meta = jsonDecode(File('${tmp.path}/live_catalog/meta_v1.json').readAsStringSync());
      expect(meta['cursor'], 'v1.1760363000.100.');
      expect(meta['tenantId'], _tenant);
      expect(meta['baseUrl'], 'https://wms.test');
      expect(meta['itemCount'], 6);

      final api2 = _FakeApi(_snapshot());
      api2.deltas.add(_payload(cursor: 'v1.1760363050.500.'));
      final second = LiveCatalogCache(api: api2);
      await second.ensureFresh();
      expect(api2.snapshotCalls, 0);
      expect(api2.cursors, ['v1.1760363000.100.']);
      expect(second.isReady, isTrue);
      expect(second.statusForEpc(_e1), 'in-stock');
      expect(second.debugCursor, 'v1.1760363050.500.');
      second.dispose();
    });

    test('saved copy from another server is discarded', () async {
      final first = LiveCatalogCache(api: _FakeApi(_snapshot()));
      await first.ensureFresh();
      first.dispose();

      final api2 = _FakeApi(_payload(kind: 'snapshot', cursor: 'v1.1760369999.7.'),
          baseUrl: 'https://other.test');
      final second = LiveCatalogCache(api: api2);
      await second.ensureFresh();
      expect(api2.snapshotCalls, 1);
      expect(api2.cursors, isEmpty);
      expect(second.debugCursor, 'v1.1760369999.7.');
      expect(second.hasItemRow(_e1), isFalse);
      second.dispose();
    });

    test('offline at start: the saved copy is used once the first sync fails', () async {
      final first = LiveCatalogCache(api: _FakeApi(_snapshot()));
      await first.ensureFresh();
      first.dispose();

      final api2 = _FakeApi(_snapshot());
      api2.deltas.add(Exception('no network'));
      final second = LiveCatalogCache(api: api2);
      await second.ensureFresh();
      expect(second.isReady, isTrue);
      expect(second.lastError, contains('no network'));
      expect(second.statusForEpc(_e1), 'in-stock');
      second.dispose();
    });
  });
}
