import 'package:flutter_test/flutter_test.dart';

import 'package:carbon_wms/services/epc/epc_codec.dart';

void main() {
  test('decodeSystemId matches verified live-hardware samples', () {
    expect(decodeSystemId('F0A0B30E4F9CB8900001358E'), equals(210000006025));
    expect(decodeSystemId('F0A0B30E4F9B93A000012CB5'), equals(210000001338));
    expect(decodeSystemId('F0A0B30E4F9C589000018A66'), equals(210000004489));
  });

  test('decodeSerial matches verified live-hardware samples', () {
    expect(decodeSerial('F0A0B30E4F9CB8900001358E'), equals(79246));
  });

  test('buildEpc round-trips system_id and serial', () {
    expect(buildEpc(210000006025, 79246), equals('F0A0B30E4F9CB8900001358E'));
  });

  test('isCurrentFormat recognises F0A0B-prefixed 24-char EPCs', () {
    expect(isCurrentFormat('F0A0B30E4F9CB8900001358E'), isTrue);
    expect(isCurrentFormat('C12511004024211069556920'), isFalse);
  });

  test('extractCustomSku slices legacy EPC by 1-indexed inclusive positions', () {
    expect(
      extractCustomSku('C12511004024211069556920', 1, 13),
      equals('C125110040242'),
    );
  });
}
