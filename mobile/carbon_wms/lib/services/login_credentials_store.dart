import 'dart:io' show Platform;

import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:local_auth/local_auth.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Biometric + encrypted password vault for **consumer-style phones** only (not Chainway/Zebra/etc.).
/// Rugged handhelds never persist passwords.
class LoginCredentialsStore {
  LoginCredentialsStore._();

  static const _vaultEmail = 'wms_login_vault_email_v1';
  static const _vaultPassword = 'wms_login_vault_password_v1';
  static const _prefsBiometric = 'wms_biometric_superadmin_enabled_v1';
  static const _prefsSkipBioOffer = 'wms_skip_biometric_enrollment_offer_v1';
  /// User opted in (login checkbox or settings) to see the post–password setup prompt.
  static const _prefsOfferBioAfterSignIn = 'wms_offer_biometric_setup_after_sign_in_v1';

  static const FlutterSecureStorage _storage = FlutterSecureStorage();

  static final LocalAuthentication _auth = LocalAuthentication();

  /// Chainway / Zebra / common enterprise scanners — no password vault.
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

  static Future<bool> canUseBiometricPasswordVault() async {
    if (await isRuggedHandheldProfile()) return false;
    if (!Platform.isAndroid) return false;
    try {
      final supported = await _auth.isDeviceSupported();
      final can = await _auth.canCheckBiometrics;
      return supported && can;
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

  static Future<void> storeVaultCredentials(String email, String password) async {
    await _storage.write(key: _vaultEmail, value: email.trim());
    await _storage.write(key: _vaultPassword, value: password);
  }

  static Future<void> clearVault() async {
    await _storage.delete(key: _vaultEmail);
    await _storage.delete(key: _vaultPassword);
  }

  static Future<String?> readVaultEmail() async => _storage.read(key: _vaultEmail);

  static Future<String?> readVaultPassword() async => _storage.read(key: _vaultPassword);

  static Future<bool> hasVaultedCredentials() async {
    if (!await isBiometricLoginEnabled()) return false;
    final p = await readVaultPassword();
    return p != null && p.isNotEmpty;
  }

  /// Offer setup only if the user opted in on the login screen (or settings) and did not dismiss permanently.
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

  static Future<bool> authenticateWithBiometric() async {
    try {
      return await _auth.authenticate(
        localizedReason: 'Sign in to CarbonWMS',
        biometricOnly: true,
        persistAcrossBackgrounding: true,
      );
    } on LocalAuthException catch (_) {
      return false;
    } on PlatformException catch (_) {
      return false;
    } catch (_) {
      return false;
    }
  }

  /// Clears vault when switching to a rugged profile (e.g. after OS update mis-detected).
  static Future<void> enforceRuggedNoPasswordPolicy() async {
    if (await isRuggedHandheldProfile()) {
      await clearVault();
      await setBiometricLoginEnabled(false);
    }
  }
}
