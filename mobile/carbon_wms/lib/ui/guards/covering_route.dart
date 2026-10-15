import 'dart:async';

import 'package:flutter/widgets.dart';

/// Resolves once the screen that was pushed on top of [route] has finished
/// closing AND been disposed.
///
/// `await Navigator.push(...)` returns the moment pop() is called — BEFORE
/// the popped screen's `dispose()` runs, which only happens after its ~300 ms
/// exit animation. Locate / Bulk Geiger hand the radio back in dispose (stop
/// inventory, power override off, per-tag beep back on), so anything the
/// screen underneath re-applied "on return" was undone a moment later, and a
/// trigger pull in that window was stopped again by the leaving screen.
///
/// Wait for this, then re-apply the radio setup.
Future<void> coveringRouteGone(ModalRoute<dynamic>? route) async {
  final anim = route?.secondaryAnimation;
  if (anim != null && anim.status != AnimationStatus.dismissed) {
    final done = Completer<void>();
    void onStatus(AnimationStatus s) {
      if (s == AnimationStatus.dismissed && !done.isCompleted) done.complete();
    }

    anim.addStatusListener(onStatus);
    // Never hang a screen on an animation that does not finish.
    await done.future.timeout(const Duration(seconds: 2), onTimeout: () {});
    anim.removeStatusListener(onStatus);
  }
  // The finished route is removed from the overlay, and its State.dispose
  // runs when its elements unmount in the following frame.
  await WidgetsBinding.instance.endOfFrame;
  await WidgetsBinding.instance.endOfFrame;
}
