import 'dart:async';

import 'package:flutter/widgets.dart';

import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';

/// The physical trigger, delivered to exactly ONE screen: the last one that
/// asked for it and is still alive.
///
/// ## The bug this exists to prevent
///
/// Thirteen screens subscribe to the hardware trigger and most start or stop
/// the radio when it fires. They all subscribed to the raw stream, and at best
/// guarded on `mounted`.
///
/// `mounted` is the wrong test: it stays true for a screen sitting UNDERNEATH
/// another. `dispose()` runs when a route is popped, not when one is pushed on
/// top. So going Count -> Locate, or Locate -> Take an action -> Status
/// Change, left the screen below subscribed and handling every pull. One
/// trigger fired two handlers, the radio switched on from a screen nobody was
/// looking at, and the two fought — one stopping what the other started, the
/// background one re-asserting ITS power and ITS pre-filter.
///
/// ## Why a registry and not ModalRoute.isCurrent
///
/// The first attempt at this (1.2.158) filtered on
/// `ModalRoute.of(context)?.isCurrent`. That shipped as a dead trigger across
/// the whole app, for two reasons worth recording:
///
///   * It failed CLOSED. `route != null && route.isCurrent` suppresses every
///     event when the lookup returns null, so one unexpected null silenced the
///     trigger everywhere instead of degrading to the old behaviour.
///   * `ModalRoute.of` registers an inherited-widget dependency. It is meant
///     to be called from `build`, not from a stream callback firing at
///     arbitrary times, where it can throw — and a throw inside the filter
///     takes the whole subscription down.
///
/// This version asks a question it owns the answer to. Subscribers form a
/// stack; the newest still-mounted one wins. Pushing Locate over Count makes
/// Locate newest, so Locate gets the trigger; popping it hands the trigger
/// straight back to Count. No framework coupling, and crucially SOMEBODY
/// always receives the event as long as one screen is listening, so this can
/// never silence the trigger app-wide the way the last attempt did.
///
/// Known and accepted limit: a screen pushed on top that does NOT subscribe
/// (Settings, a report list) leaves the screen below as newest, so that screen
/// still responds. That is no worse than the behaviour before any of this, and
/// far better than the crossfire it replaces.
///
/// Use this instead of [RfidVendorChannel.hardwareTriggerStream] in any screen.
Stream<String> hardwareTriggerFor(State<StatefulWidget> state) {
  final entry = _TriggerSubscriber(state);
  StreamSubscription<String>? upstream;
  late final StreamController<String> controller;

  controller = StreamController<String>(
    onListen: () {
      _stack.add(entry);
      upstream = RfidVendorChannel.hardwareTriggerStream().listen(
        (event) {
          // Drop any screen that was disposed without cancelling, so a leak
          // can never permanently block the screens beneath it.
          _stack.removeWhere((e) => !e.state.mounted);
          if (_stack.isNotEmpty && identical(_stack.last, entry)) {
            controller.add(event);
          }
        },
        onError: (Object _) {/* never propagate: an upstream hiccup must not
                                kill this screen's trigger */},
      );
    },
    onCancel: () async {
      _stack.remove(entry);
      await upstream?.cancel();
    },
  );
  return controller.stream;
}

/// Newest last. Only the final still-mounted entry receives events.
final List<_TriggerSubscriber> _stack = <_TriggerSubscriber>[];

class _TriggerSubscriber {
  _TriggerSubscriber(this.state);
  final State<StatefulWidget> state;
}
