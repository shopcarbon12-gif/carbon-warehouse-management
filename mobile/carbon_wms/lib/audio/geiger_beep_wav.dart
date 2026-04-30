import 'dart:math';
import 'dart:typed_data';

/// Synthesized Geiger-style scan beep: high-pitched, sharp, short (in-memory WAV).
Uint8List buildGeigerBeepWav() => _buildBeep(frequency: 1950.0, durationMs: 22);
Uint8List buildStartBeepWav() => _buildBeep(frequency: 1950.0, durationMs: 55);
Uint8List buildStopBeepWav()  => _buildBeep(frequency: 1950.0, durationMs: 55);

Uint8List _buildBeep({required double frequency, required int durationMs}) {
  const sampleRate = 22050;
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
  void le16(int v) { bd.setUint16(o, v, Endian.little); o += 2; }
  void le32(int v) { bd.setUint32(o, v, Endian.little); o += 4; }

  w4('RIFF'); le32(fileLen); w4('WAVE');
  w4('fmt '); le32(16); le16(1); le16(1);
  le32(sampleRate); le32(sampleRate * 2); le16(2); le16(16);
  w4('data'); le32(dataSize);

  // Hard attack (2ms), fast exponential decay — sharp Geiger click character.
  final attackSamples = max(1, (sampleRate * 0.002).round());
  for (var i = 0; i < nSamples; i++) {
    final t = i / sampleRate;
    final attack = i < attackSamples ? i / attackSamples : 1.0;
    final decay = exp(-6.0 * i / nSamples);
    final env = attack * decay;
    final s = (sin(2 * pi * frequency * t) * 0.85 * env * 32767).round().clamp(-32768, 32767);
    le16(s);
  }
  return bd.buffer.asUint8List();
}
