import 'package:shared_preferences/shared_preferences.dart';

/// Per-device Locate rollout switch (Locate 2.0 stage F).
/// ON (default) = the new Locate screen; OFF = the classic screen, kept for
/// rollback and for the side-by-side comparison. Stored on the handheld.
class LocatePrefs {
  static const String _key = 'locate_v2_enabled';
  static bool? _cached;

  static Future<bool> useNewLocate() async {
    if (_cached != null) return _cached!;
    try {
      final p = await SharedPreferences.getInstance();
      _cached = p.getBool(_key) ?? true;
    } catch (_) {
      _cached = true;
    }
    return _cached!;
  }

  static Future<void> setUseNewLocate(bool on) async {
    _cached = on;
    try {
      final p = await SharedPreferences.getInstance();
      await p.setBool(_key, on);
    } catch (_) {}
  }
}
