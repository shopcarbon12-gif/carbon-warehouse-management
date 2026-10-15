import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:carbon_wms/hardware/channel_fanout.dart';
import 'package:carbon_wms/hardware/rfid_tag_read.dart';
import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('ChannelFanout delivery', () {
    late StreamController<int> source;
    late int opens;
    late ChannelFanout<int> fanout;

    setUp(() {
      opens = 0;
      source = StreamController<int>.broadcast();
      fanout = ChannelFanout<int>(() {
        opens++;
        return source.stream;
      });
    });

    test('newest screen gets events; when it closes the one below gets them back', () async {
      final below = <int>[];
      final top = <int>[];
      final a = fanout.stream().listen(below.add); // Cloud + Geiger
      final b = fanout.stream().listen(top.add); // Geiger pushed on top
      source.add(1);
      await pumpEventQueue();
      await b.cancel(); // Geiger closed
      source.add(2);
      await pumpEventQueue();
      expect(top, [1]);
      expect(below, [2]); // used to be [] — the channel died
      expect(opens, 1);
      await a.cancel();
    });

    test('background (RfidManager) never takes reads back from screens', () async {
      final manager = <int>[];
      final screen = <int>[];
      final m = fanout.stream(background: true).listen(manager.add);
      source.add(1); // no screen yet: the manager hears it, as today
      await pumpEventQueue();
      final s = fanout.stream().listen(screen.add);
      source.add(2);
      await pumpEventQueue();
      await s.cancel();
      source.add(3); // screen gone: still not the manager (no new edge ingest)
      await pumpEventQueue();
      expect(manager, [1]);
      expect(screen, [2]);
      await m.cancel();
    });

    test('a background listener added later never steals from a screen', () async {
      final screen = <int>[];
      final manager = <int>[];
      final s = fanout.stream().listen(screen.add);
      final m = fanout.stream(background: true).listen(manager.add); // reconnect
      source.add(1);
      await pumpEventQueue();
      expect(screen, [1]);
      expect(manager, isEmpty);
      await s.cancel();
      await m.cancel();
    });

    test('one upstream: closed with the last listener, reopened by the next', () async {
      final a = fanout.stream().listen((_) {});
      final b = fanout.stream().listen((_) {});
      expect(opens, 1);
      await a.cancel();
      await b.cancel();
      expect(fanout.listenerCount, 0);
      expect(source.hasListener, isFalse);
      final got = <int>[];
      final c = fanout.stream().listen(got.add);
      expect(opens, 2);
      source.add(7);
      await pumpEventQueue();
      expect(got, [7]);
      await c.cancel();
    });
  });

  group('real channels (mocked phone side)', () {
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    const trigger = EventChannel('carbon_wms/hardware_trigger');
    const tags = EventChannel('carbon_wms/rfid_tag_stream');
    MockStreamHandlerEventSink? triggerSink;
    MockStreamHandlerEventSink? tagSink;
    var nativeCancels = 0;

    setUp(() {
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      messenger.setMockStreamHandler(
        trigger,
        MockStreamHandler.inline(
          onListen: (_, s) => triggerSink = s,
          onCancel: (_) {
            nativeCancels++;
            triggerSink = null;
          },
        ),
      );
      messenger.setMockStreamHandler(
        tags,
        MockStreamHandler.inline(
          onListen: (_, s) => tagSink = s,
          onCancel: (_) {
            nativeCancels++;
            tagSink = null;
          },
        ),
      );
    });

    tearDown(() {
      debugDefaultTargetPlatformOverride = null;
    });

    test('trigger: closing the top screen keeps the trigger alive below', () async {
      nativeCancels = 0;
      final below = <String>[];
      final a = RfidVendorChannel.hardwareTriggerStream().listen(below.add);
      await pumpEventQueue();
      final b = RfidVendorChannel.hardwareTriggerStream().listen((_) {});
      await pumpEventQueue();
      await b.cancel(); // Geiger closed
      await pumpEventQueue();
      triggerSink?.success('down');
      await pumpEventQueue();
      expect(nativeCancels, 0);
      expect(below, ['down']);
      await a.cancel();
      await pumpEventQueue();
    });

    test('tag reads: back on the screen below, reads arrive again', () async {
      nativeCancels = 0;
      final below = <RfidTagRead>[];
      final a = RfidVendorChannel.tagReadStream().listen(below.add);
      await pumpEventQueue();
      final b = RfidVendorChannel.tagReadStream().listen((_) {});
      await pumpEventQueue();
      await b.cancel();
      await pumpEventQueue();
      tagSink?.success(<String, dynamic>{'epc': 'F0A0B30E4F9D66F0000187E2', 'rssi': -51});
      await pumpEventQueue();
      expect(nativeCancels, 0);
      expect(below.map((r) => r.epcHex24), ['F0A0B30E4F9D66F0000187E2']);
      await a.cancel();
      await pumpEventQueue();
    });
  });
}
