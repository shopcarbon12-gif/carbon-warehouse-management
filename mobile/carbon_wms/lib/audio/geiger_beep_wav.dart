import 'dart:math';
import 'dart:typed_data';

/// Short PCM beep for Geiger-style proximity feedback (in-memory WAV).
Uint8List buildGeigerBeepWav() {
  const sampleRate = 16000;
  const frequency = 920.0;
  const durationMs = 42;
  final nSamples = (sampleRate * durationMs / 1000).round();
  final dataSize = nSamples * 2;
  final fileLen = 36 + dataSize;

  final bd = ByteData(fileLen + 8);
  var o = 0;
  void w4(String s) {
    for (var i = 0; i < 4; i++) {
      bd.setUint8(o++, s.codeUnitAt(i));
    }
  }

  void le16(int v) {
    bd.setUint16(o, v, Endian.little);
    o += 2;
  }

  void le32(int v) {
    bd.setUint32(o, v, Endian.little);
    o += 4;
  }

  w4('RIFF');
  le32(fileLen);
  w4('WAVE');
  w4('fmt ');
  le32(16);
  le16(1);
  le16(1);
  le32(sampleRate);
  le32(sampleRate * 2);
  le16(2);
  le16(16);
  w4('data');
  le32(dataSize);

  final edge = max(1, (nSamples * 0.12).round());
  for (var i = 0; i < nSamples; i++) {
    final t = i / sampleRate;
    var env = 1.0;
    if (i < edge) env = i / edge;
    if (i > nSamples - edge) env = (nSamples - i) / edge;
    final s = (sin(2 * pi * frequency * t) * 0.45 * env * 32767).round().clamp(-32768, 32767);
    le16(s);
  }

  return bd.buffer.asUint8List();
}
