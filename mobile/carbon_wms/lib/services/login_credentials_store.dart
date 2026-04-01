import 'dart:io' show Platform;

import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/foundation.dart' show debugPrint, kIsWeb;
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:local_auth/local_auth.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Biometric unlock for **consumer-style phones** only (not Chainway/Zebra/etc.).
/// **Passwords are never read from or written to any persistent storage** (including
/// [FlutterSecureStorage]). Enrollment stores only a **session token** returned by the server.
class LoginCredentialsStore {
  LoginCredentialsStore._();

  static const _vaultEmail = 'wms_login_vault_email_v1';
  static const _vaultSessionToken = 'wms_login_vault_session_v1';
  static const _vaultPasswordLegacy = 'wms_login_vault_password_v1';

  static const _prefsBiometric = 'wms_biometric_superadmin_enabled_v1';
  static const _prefsSkipBioOffer = 'wms_skip_biometric_enrollment_offer_v1';
  static const _prefsOfferBioAfterSignIn = 'wms_offer_biometric_setup_after_sign_in_v1';

  static const FlutterSecureStorage _storage = FlutterSecureStorage();

  static final LocalAuthentication _auth = LocalAuthentication();

  static Future<bool> isRuggedHandheldProfile() async {
    if (kIsWeb || !Platform.isAndroid) return false;
    try {
      final a = await DeviceInfoPlugin().androidInfo;
      final m = a.manufacturer.toLowerCase();
      if (m.contains('chainway')) return true;
      if (m.contains('zebra')) return true;
      if (m.contains('honeywell')) return true;
      if (m.contains('urovo')) return true;
      if (m.contains('datalogic')) return true;
      if (m.contains('pointmobile')) return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  /// Phones with screen lock / biometrics: [canCheckBiometrics] alone is false on some OEMs
  /// even though [LocalAuthentication.authenticate] works with device credential fallback.
  static Future<bool> canUseBiometricPasswordVault() async {
    if (kIsWeb) return false;
    if (await isRuggedHandheldProfile()) return false;
    if (!Platform.isAndroid) return false;
    try {
      return await _auth.isDeviceSupported();
    } on PlatformException catch (_) {
      return false;
    } catch (_) {
      return false;
    }
  }

  static Future<bool> getOfferBiometricSetupAfterSignIn() async {
    final p = await SharedPreferences.getInstance();
    return p.getBool(_prefsOfferBioAfterSignIn) ?? false;
  }

  static Future<void> setOfferBiometricSetupAfterSignIn(bool value) async {
    final p = await SharedPreferences.getInstance();
    await p.setBool(_prefsOfferBioAfterSignIn, value);
  }

  static Future<bool> isBiometricLoginEnabled() async {
    final p = await SharedPreferences.getInstance();
    return p.getBool(_prefsBiometric) ?? false;
  }

  static Future<void> setBiometricLoginEnabled(bool value) async {
    final p = await SharedPreferences.getInstance();
    await p.setBool(_prefsBiometric, value);
    if (!value) await clearVault();
  }

  static Future<void> storeBiometricEnrollment({
    required String email,
    required String sessionToken,
  }) async {
    final t = sessionToken.trim();
    if (t.isEmpty) return;
    await _storage.write(key: _vaultEmail, value: email.trim());
    await _storage.write(key: _vaultSessionToken, value: t);
  }

  static Future<void> clearVault() async {
    await _storage.delete(key: _vaultEmail);
    await _storage.delete(key: _vaultSessionToken);
    await _storage.delete(key: _vaultPasswordLegacy);
  }

  static Future<String?> readVaultEmail() async => _storage.read(key: _vaultEmail);

  static Future<String?> readVaultSessionToken() async => _storage.read(key: _vaultSessionToken);

  /// True when a session token is stored for biometric sign-in.
  ///
  /// Does **not** require [LocalAuthentication.isDeviceSupported] — that API is false on some
  /// phones even though [authenticateWithBiometric] works; gating the login button on it hid
  /// biometrics after first-time setup.
  static Future<bool> hasVaultedCredentials() async {
    if (kIsWeb || !Platform.isAndroid) return false;
    if (await isRuggedHandheldProfile()) return false;
    final t = await readVaultSessionToken();
    return t != null && t.isNotEmpty;
  }

  static Future<bool> shouldOfferBiometricEnrollment() async {
    if (!await getOfferBiometricSetupAfterSignIn()) return false;
    if (!await canUseBiometricPasswordVault()) return false;
    if (await hasVaultedCredentials()) return false;
    final p = await SharedPreferences.getInstance();
    return p.getBool(_prefsSkipBioOffer) != true;
  }

  static Future<void> setBiometricEnrollmentPromptSkipped(bool skipped) async {
    final p = await SharedPreferences.getInstance();
    if (skipped) {
      await p.setBool(_prefsSkipBioOffer, true);
    } else {
      await p.remove(_prefsSkipBioOffer);
    }
  }

  /// [biometricOnly] false allows PIN/pattern when biometrics fail (better success on real devices).
  /// [sensitiveTransaction] false avoids extra face-ID confirmation flows that often confuse users.
  static Future<bool> authenticateWithBiometric() async {
    try {
      return await _auth.authenticate(
        localizedReason: 'Sign in to CarbonWMS',
        biometricOnly: false,
        sensitiveTransaction: false,
        persistAcrossBackgrounding: true,
      );
    } on LocalAuthException catch (e, st) {
      debugPrint('local_auth LocalAuthException: $e\n$st');
      return false;
    } on PlatformException catch (e, st) {
      debugPrint('local_auth PlatformException: ${e.code} ${e.message}\n$st');
      return false;
    } catch (e, st) {
      debugPrint('local_auth: $e\n$st');
      return false;
    }
  }

  /// Clears the biometric vault and disables the biometric pref. Use when the **session is
  /// invalid** (e.g. server revoked the token), not for a normal **user Logout** — users expect
  /// fingerprint/face sign-in again after logging out while keeping the saved session token.
  static Future<void> clearBiometricVaultOnLogout() async {
    await clearVault();
    final p = await SharedPreferences.getInstance();
    await p.setBool(_prefsBiometric, false);
  }

  /// No-op for secure storage: [WmsApiClient.setSessionToken] already ends the active session.
  /// Biometric vault + prefs stay so "Biometric sign-in" remains on the login screen.
  static Future<void> onUserLogout() async {}

  static Future<void> enforceRuggedNoPasswordPolicy() async {
    await _storage.delete(key: _vaultPasswordLegacy);
    if (await isRuggedHandheldProfile()) {
      await clearVault();
      await setBiometricLoginEnabled(false);
    }
  }
}
