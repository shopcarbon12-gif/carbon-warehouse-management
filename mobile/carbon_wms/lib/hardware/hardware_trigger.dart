import 'package:flutter/widgets.dart';

import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';

/// The physical trigger, delivered ONLY to the screen the operator is actually
/// looking at.
///
/// ## The bug this exists to prevent
///
/// Thirteen screens subscribe to the hardware trigger, and most of them start
/// or stop the radio when it fires. They were all subscribing to the raw
/// stream, and at best guarded on `mounted`.
///
/// `mounted` is the wrong test. It stays true for a screen sitting UNDERNEATH
/// another one: `dispose()` runs when a route is popped, not when a route is
/// pushed on top of it. So the moment an operator went Count -> Locate, or
/// Locate -> Take an action -> Status Change, or Catalog -> EPC list ->
/// Locate, the screen below stayed subscribed and kept handling every trigger
/// pull.
///
/// The result: pulling the trigger fired two handlers. The radio switched on
/// from a screen nobody was looking at, and the two screens then fought — one
/// stopping what the other had just started, and the background screen
/// re-asserting ITS power and ITS pre-filter over the visible screen's. It
/// presents as "the reader turns itself on", and as scans that stop for no
/// reason mid-pass.
///
/// `ModalRoute.isCurrent` is true only for the topmost route, which is exactly
/// the question worth asking. It is also false while a dialog or bottom sheet
/// is open over the screen — deliberate: a trigger pull should not start a
/// scan behind a confirmation the operator has not answered yet.
///
/// Use this instead of [RfidVendorChannel.hardwareTriggerStream] in any
/// screen. Reaching for the raw stream re-opens the bug.
Stream<String> hardwareTriggerFor(State<StatefulWidget> state) {
  return RfidVendorChannel.hardwareTriggerStream().where((_) {
    // Evaluated per EVENT, not at subscribe time — which route is on top
    // changes constantly while the subscription stays alive.
    if (!state.mounted) return false;
    final route = ModalRoute.of(state.context);
    return route != null && route.isCurrent;
  });
}
