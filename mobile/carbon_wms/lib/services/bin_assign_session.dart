/// In-memory holder for the Bin Assign manual-mode toggle and its
/// sub-options. Lives for the lifetime of the Dart isolate, which means
/// it survives navigation and screen rebuilds but **resets to defaults
/// when the app is fully closed (process killed)** — exactly what the
/// operator asked for: "stay for the session until app is completely
/// closed."
///
/// Sub-options are coupled to the master:
///   - master ON  → manualBin / manualAddItem default to true; operator
///     may then independently toggle either off via the settings screen.
///   - master OFF → all sub-options reset to false.
///
/// We deliberately do NOT touch SharedPreferences for these flags any
/// more. The previous design persisted manual-mode across app restarts,
/// which made fresh logins surface the "unexpected manual mode" trap on
/// the next session. For other persistent flags (camera enabled,
/// scanner source) the consumer screens still own SharedPreferences.
library;

import 'package:flutter/foundation.dart';

class BinAssignSession {
  BinAssignSession._();

  /// Notifier so screens can rebuild on toggle without a full rewire.
  static final ValueNotifier<bool> resetVersion = ValueNotifier<bool>(false);

  static bool _enabled = false;
  static bool _manualBin = false;
  static bool _manualAddItem = false;
  static bool _externalScanner = false;

  /// True when manual-mode is on for this app session.
  static bool get manualModeEnabled => _enabled;
  static bool get manualBin => _manualBin;
  static bool get manualAddItem => _manualAddItem;
  static bool get externalScanner => _externalScanner;

  /// Master toggle. Setting true cascades sub-options on; setting false
  /// resets every sub-option AND bumps `resetVersion` so the bin assign
  /// screen knows it should drop any in-progress state next time it
  /// becomes visible (operator-asked behaviour: "starting a whole new
  /// fresh screen" after disable).
  static void setManualMode(bool v) {
    if (_enabled == v) return;
    _enabled = v;
    if (v) {
      _manualBin = true;
      _manualAddItem = true;
    } else {
      _manualBin = false;
      _manualAddItem = false;
      _externalScanner = false;
      // Toggling resetVersion (true ↔ false) is enough — the value
      // itself is irrelevant; listeners react to any change. No need
      // for an int counter.
      resetVersion.value = !resetVersion.value;
    }
  }

  static void setManualBin(bool v) {
    _manualBin = v;
  }

  static void setManualAddItem(bool v) {
    _manualAddItem = v;
  }

  static void setExternalScanner(bool v) {
    _externalScanner = v;
  }

  /// Hard reset — used at login so a returning operator never inherits
  /// the previous user's session state. Different from setManualMode(false)
  /// in that it never bumps resetVersion (no screen needs to react to a
  /// login-time wipe).
  static void resetForLogin() {
    _enabled = false;
    _manualBin = false;
    _manualAddItem = false;
    _externalScanner = false;
  }
}
