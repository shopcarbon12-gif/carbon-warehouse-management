import 'package:flutter_test/flutter_test.dart';

import 'package:carbon_wms/services/add_on_catalog_classifier.dart';
import 'package:carbon_wms/services/epc/epc_codec.dart';
import 'package:carbon_wms/services/live_catalog_models.dart';

// Verified live-hardware sample (test/epc/epc_codec_test.dart): system_id 210000006025.
const _knownEpc = 'F0A0B30E4F9CB8900001358E';
const _knownSid = '210000006025';
// Same tail under a foreign prefix: the primary formula rejects it
// (wrongPrefix) but legacy int(epc[5:15],16) still lands on 210000006025.
const _legacyOnlyEpc = 'C0A0B30E4F9CB8900001358E';

const _info = LiveItemInfo(
  skuId: 'sku-1',
  systemId: _knownSid,
  sku: 'C12511004024',
  name: 'ELODIE TOP',
  color: 'BLACK',
  size: 'S',
  retailPrice: '52.00',
);

LiveItemInfo? _catalog(String sid) => sid == _knownSid ? _info : null;
LiveItemInfo? _emptyCatalog(String sid) => null;

AddOnCatalogDecision _classify(
  String epc,
  String? status, {
  LiveItemInfo? Function(String)? lookup,
  EpcConfig cfg = kFallbackEpcConfig,
}) =>
    classifyAddOnCatalog(
      epc: epc,
      status: status,
      cfg: cfg,
      skuBySystemId: lookup ?? _catalog,
    );

void main() {
  group('decision table', () {
    test('no row + resolved → qualify', () {
      final d = _classify(_knownEpc, null);
      expect(d.verdict, AddOnCatalogVerdict.qualify);
      expect(d.reason, 'no_row_resolved');
      expect(d.status, isNull);
      expect(d.systemId, _knownSid);
      expect(d.viaLegacy, isFalse);
      expect(d.info, same(_info));
    });

    test('no row + unresolved (catalog miss) → defective', () {
      final d = _classify(_knownEpc, null, lookup: _emptyCatalog);
      expect(d.verdict, AddOnCatalogVerdict.defective);
      expect(d.reason, 'no_row_unresolved');
      expect(d.systemId, _knownSid); // primary decode still reported
      expect(d.info, isNull);
    });

    test("'unknown' + resolved → qualify", () {
      final d = _classify(_knownEpc, 'unknown');
      expect(d.verdict, AddOnCatalogVerdict.qualify);
      expect(d.reason, 'unknown_resolved');
      expect(d.status, 'unknown');
      expect(d.info, isNotNull);
    });

    test("'unknown' + unresolved → ignore", () {
      final d = _classify(_knownEpc, 'unknown', lookup: _emptyCatalog);
      expect(d.verdict, AddOnCatalogVerdict.ignore);
      expect(d.reason, 'unknown_unresolved');
    });

    test('in-stock (already LIVE) → ignore, resolved or not', () {
      for (final lookup in [_catalog, _emptyCatalog]) {
        final d = _classify(_knownEpc, 'in-stock', lookup: lookup);
        expect(d.verdict, AddOnCatalogVerdict.ignore);
        expect(d.reason, 'status:in-stock');
      }
    });

    test('tag_killed / damaged / stolen → ignore (owner decision 2026-10-13)', () {
      for (final status in ['tag_killed', 'damaged', 'stolen']) {
        for (final lookup in [_catalog, _emptyCatalog]) {
          final d = _classify(_knownEpc, status, lookup: lookup);
          expect(d.verdict, AddOnCatalogVerdict.ignore, reason: status);
          expect(d.reason, 'status:$status');
          expect(d.status, status);
        }
      }
    });

    test('sold / return / in-transit / pending_* / anything else → ignore', () {
      for (final status in [
        'sold',
        'return',
        'in-transit',
        'pending_visibility',
        'pending_transaction',
        'some_future_status',
      ]) {
        final d = _classify(_knownEpc, status);
        expect(d.verdict, AddOnCatalogVerdict.ignore, reason: status);
        expect(d.reason, 'status:$status');
      }
    });
  });

  group('resolution', () {
    test('legacy-only resolution qualifies with viaLegacy', () {
      expect(decodeEpc(_legacyOnlyEpc, kFallbackEpcConfig).valid, isFalse);
      final d = _classify(_legacyOnlyEpc, null);
      expect(d.verdict, AddOnCatalogVerdict.qualify);
      expect(d.viaLegacy, isTrue);
      expect(d.systemId, _knownSid);
      expect(d.info, same(_info));
    });

    test('legacy-only resolution of an unknown row qualifies too', () {
      final d = _classify(_legacyOnlyEpc, 'unknown');
      expect(d.verdict, AddOnCatalogVerdict.qualify);
      expect(d.viaLegacy, isTrue);
    });

    test('primary hit wins; legacy is not consulted', () {
      // 8/40/48 layout: primary asset = epc[2:12], legacy = epc[5:15] — they differ.
      const cfg = EpcConfig(
        prefixHex: 'F0',
        prefixBits: 8,
        assetBits: 40,
        serialBits: 48,
        assetPaddingDigits: 13,
      );
      const epc = 'F00000000001000000000002';
      final primary = decodeEpc(epc, cfg).systemId.toString();
      final legacy = legacyEpcSystemId(epc).toString();
      expect(primary, isNot(legacy));
      final asked = <String>[];
      final d = _classify(epc, null, cfg: cfg, lookup: (sid) {
        asked.add(sid);
        return sid == primary || sid == legacy ? _info : null;
      });
      expect(asked, [primary]);
      expect(d.verdict, AddOnCatalogVerdict.qualify);
      expect(d.viaLegacy, isFalse);
      expect(d.systemId, primary);
    });

    test('primary valid but SKU missing and legacy missing → defective', () {
      final asked = <String>[];
      final d = _classify(_knownEpc, null, lookup: (sid) {
        asked.add(sid);
        return null;
      });
      // F0A0B layout: the legacy slice is the same asset field, asked twice.
      expect(asked, [_knownSid, _knownSid]);
      expect(d.verdict, AddOnCatalogVerdict.defective);
      expect(d.viaLegacy, isFalse);
      expect(d.systemId, _knownSid);
    });

    test('bad length → defective, no system id', () {
      final d = _classify('ABC', null);
      expect(d.verdict, AddOnCatalogVerdict.defective);
      expect(d.systemId, isNull);
      expect(d.info, isNull);
    });

    test('bad length with a legacy-decodable head still resolves via legacy', () {
      // 16 chars: primary rejects (badLength), legacy reads epc[5:15].
      final d = _classify('C0A0B30E4F9CB890', null);
      expect(d.verdict, AddOnCatalogVerdict.qualify);
      expect(d.viaLegacy, isTrue);
    });

    test('a catalog row with an empty SKU does not count as resolved', () {
      const blank = LiveItemInfo(skuId: 'sku-x', sku: '  ', name: '', color: '', size: '');
      final d = _classify(_knownEpc, null, lookup: (_) => blank);
      expect(d.verdict, AddOnCatalogVerdict.defective);
      expect(d.info, isNull);
    });

    test('input is trimmed and upper-cased', () {
      final d = _classify('  ${_knownEpc.toLowerCase()} ', null);
      expect(d.verdict, AddOnCatalogVerdict.qualify);
      expect(d.systemId, _knownSid);
    });
  });

  group('legacyEpcSystemId', () {
    test('int(epc[5:15],16)', () {
      expect(legacyEpcSystemId(_knownEpc), BigInt.parse(_knownSid));
      expect(legacyEpcSystemId(_legacyOnlyEpc), BigInt.parse(_knownSid));
    });

    test('trims and upper-cases', () {
      expect(legacyEpcSystemId('  ${_knownEpc.toLowerCase()}\n'), BigInt.parse(_knownSid));
    });

    test('shorter than 15 → null; exactly 15 is enough', () {
      expect(legacyEpcSystemId(''), isNull);
      expect(legacyEpcSystemId('F0A0B30E4F9CB8'), isNull); // 14
      expect(legacyEpcSystemId('F0A0B30E4F9CB89'), BigInt.parse(_knownSid)); // 15
    });

    test('non-hex in the slice → null (outside it is fine)', () {
      expect(legacyEpcSystemId('F0A0B30E4F9CG8900001358E'), isNull);
      expect(legacyEpcSystemId('ZZZZZ30E4F9CB89ZZZZZZZZZ'), BigInt.parse(_knownSid));
    });
  });
}
