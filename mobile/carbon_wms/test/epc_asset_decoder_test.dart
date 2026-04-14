import 'package:flutter_test/flutter_test.dart';

import 'package:carbon_wms/services/epc_asset_decoder.dart';

void main() {
  test('decodeAssetFromEpc decodes prefix/item/serial by configured bit layout',
      () {
    const epc = 'F0A0B30E4F9B8BC0000006B7';
    final d = decodeAssetFromEpc(epc);
    expect(d.prefixHex, 'F0A0B');
    expect(d.assetId, '210000001212');
    expect(d.serial, 1719);
  });

  test('decodeAssetFromEpc returns INVALID for malformed EPC length', () {
    final d = decodeAssetFromEpc('F0A0B123');
    expect(d.assetId, 'INVALID');
    expect(d.serial, 0);
  });
}
