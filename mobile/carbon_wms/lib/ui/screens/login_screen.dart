import 'dart:async' show unawaited;
import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/handheld_client_info.dart';
import 'package:carbon_wms/services/handheld_device_identity.dart';
import 'package:carbon_wms/services/login_credentials_store.dart';

/// Light login layout aligned with `APK UI` mocks. Does not change app-wide theme.
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.onSuccess});

  final Future<void> Function() onSuccess;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  static const Color _bg = Color(0xFFF5FAFA);
  static const Color _fieldFill = Color(0xFFF0F5F4);
  static const Color _labelGrey = Color(0xFF6D7979);
  static const Color _textBlack = Color(0xFF171D1D);
  static const Color _primaryTeal = Color(0xFF006768);

  final _serverUrl = TextEditingController();
  final _email = TextEditingController();
  final _password = TextEditingController();

  bool _busy = false;
  String? _err;
  bool _obscurePassword = true;
  String? _deviceApprovalLine;
  bool _vaultReady = false;
  String? _vaultEmail;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _bootstrap());
  }

  Future<void> _bootstrap() async {
    await LoginCredentialsStore.enforceRuggedNoPasswordPolicy();
    if (!mounted) return;
    final api = context.read<WmsApiClient>();
    final locked = WmsApiClient.lockedServerUrl;
    await api.setBaseUrl(locked);
    if (!mounted) return;
    _serverUrl.text = locked;

    final saved = await api.getSavedLoginEmail();
    if (!mounted) return;
    if (saved != null && saved.isNotEmpty) {
      _email.text = saved;
    }

    await _refreshVaultUi();
    await _loadDeviceApprovalLine();
  }

  Future<void> _refreshVaultUi() async {
    final ready = await LoginCredentialsStore.hasVaultedCredentials();
    final ve = await LoginCredentialsStore.readVaultEmail();
    if (!mounted) return;
    setState(() {
      _vaultReady = ready;
      _vaultEmail = ve;
    });
  }

  Future<void> _loadDeviceApprovalLine() async {
    final api = context.read<WmsApiClient>();
    final androidId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
    Map<String, dynamic> clientInfo = {};
    if (Platform.isAndroid) {
      try {
        clientInfo = await HandheldClientInfo.collect();
      } catch (_) {
        /* ignore */
      }
    }

    String? line;
    final mac = clientInfo['wifiMac']?.toString().trim();
    if (mac != null && mac.isNotEmpty && mac != '02:00:00:00:00:00') {
      line = 'MAC $mac';
    } else if (androidId.isNotEmpty && androidId != 'HANDHELD_OFFLINE') {
      line = 'Android ID $androidId';
    }

    var showLine = true;
    try {
      final ver = (await PackageInfo.fromPlatform()).version;
      final st = await api.fetchMobileStatus(
        version: ver,
        androidId: androidId.isEmpty ? null : androidId,
      );
      final approved = st['authorized'] == true || st['bypassDeviceLock'] == true;
      showLine = !approved;
    } catch (_) {
      showLine = true;
    }

    if (!mounted) return;
    setState(() {
      _deviceApprovalLine = showLine ? line : null;
    });
  }

  @override
  void dispose() {
    _serverUrl.dispose();
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  InputDecoration _decoration({
    required String label,
    Widget? suffixIcon,
  }) {
    return InputDecoration(
      labelText: label.toUpperCase(),
      labelStyle: GoogleFonts.spaceGrotesk(
        fontSize: 11,
        fontWeight: FontWeight.w700,
        letterSpacing: 1.2,
        color: _labelGrey,
      ),
      floatingLabelBehavior: FloatingLabelBehavior.always,
      suffixIcon: suffixIcon,
      filled: true,
      fillColor: _fieldFill,
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 18),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: BorderSide.none,
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: BorderSide.none,
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: const BorderSide(color: _primaryTeal, width: 2),
      ),
    );
  }

  TextStyle get _inputTextStyle => GoogleFonts.spaceGrotesk(
        fontSize: 16,
        fontWeight: FontWeight.w500,
        color: _textBlack,
      );

  Future<void> _submitWithCredentials(String email, String password) async {
    setState(() {
      _busy = true;
      _err = null;
    });
    final api = context.read<WmsApiClient>();
    final base = WmsApiClient.lockedServerUrl;
    await api.setBaseUrl(base);
    try {
      final r = await api
          .login(email: email.trim(), password: password)
          .timeout(const Duration(seconds: 45));
      if (!mounted) return;
      setState(() => _busy = false);
      if (!r.ok) {
        setState(() => _err = r.error ?? 'Login failed');
        return;
      }

      await api.setSavedLoginEmail(email.trim());

      if (!r.bypass || !await LoginCredentialsStore.canUseBiometricPasswordVault()) {
        await LoginCredentialsStore.clearVault();
        await LoginCredentialsStore.setBiometricLoginEnabled(false);
      } else if (mounted) {
        final offer = await showDialog<bool>(
          context: context,
          builder: (ctx) => AlertDialog(
            title: const Text('Biometric sign-in'),
            content: const Text(
              'Save your password on this phone for Super Admin biometric sign-in? '
              'Passwords are never stored on rugged handheld scanners.',
            ),
            actions: [
              TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('No')),
              FilledButton(
                onPressed: () => Navigator.pop(ctx, true),
                child: const Text('Yes'),
              ),
            ],
          ),
        );
        if (offer == true) {
          final bioOk = await LoginCredentialsStore.authenticateWithBiometric();
          if (bioOk) {
            await LoginCredentialsStore.setBiometricLoginEnabled(true);
            await LoginCredentialsStore.storeVaultCredentials(email.trim(), password);
          }
        }
      }

      _password.clear();
      await _refreshVaultUi();
      await widget.onSuccess();
    } on Object catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _err =
            'Cannot reach server. Check Wi‑Fi and that the site is up.\n${e.runtimeType}';
      });
    }
  }

  Future<void> _submit() async {
    await _submitWithCredentials(_email.text, _password.text);
  }

  Future<void> _biometricSignIn() async {
    final ok = await LoginCredentialsStore.authenticateWithBiometric();
    if (!ok || !mounted) return;
    final email = await LoginCredentialsStore.readVaultEmail();
    final pass = await LoginCredentialsStore.readVaultPassword();
    if (email == null || pass == null || email.isEmpty || pass.isEmpty) return;
    await _submitWithCredentials(email, pass);
  }

  @override
  Widget build(BuildContext context) {
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.dark.copyWith(
        statusBarColor: Colors.transparent,
        systemNavigationBarColor: _bg,
      ),
      child: Scaffold(
        backgroundColor: _bg,
        body: SafeArea(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const SizedBox(height: 8),
                Center(
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(12),
                    child: Image.asset(
                      'assets/carbon_logo.png',
                      width: 128,
                      height: 128,
                      fit: BoxFit.cover,
                    ),
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  'CarbonWMS',
                  textAlign: TextAlign.center,
                  style: GoogleFonts.manrope(
                    fontSize: 22,
                    fontWeight: FontWeight.w900,
                    letterSpacing: 2,
                    color: Colors.black,
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  'WAREHOUSE MANAGEMENT SOFTWARE',
                  textAlign: TextAlign.center,
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 12,
                    fontWeight: FontWeight.w500,
                    letterSpacing: 2,
                    color: _labelGrey,
                  ),
                ),
                const SizedBox(height: 36),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Expanded(
                      child: Text(
                        'SERVER URL',
                        style: GoogleFonts.spaceGrotesk(
                          fontSize: 11,
                          fontWeight: FontWeight.w700,
                          letterSpacing: 1.2,
                          color: _labelGrey,
                        ),
                      ),
                    ),
                    Text(
                      'CONNECTED VIA SSL',
                      style: GoogleFonts.spaceGrotesk(
                        fontSize: 9,
                        fontWeight: FontWeight.w500,
                        letterSpacing: 0.5,
                        color: _labelGrey,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: _serverUrl,
                  readOnly: true,
                  enableInteractiveSelection: true,
                  style: _inputTextStyle,
                  decoration: InputDecoration(
                    filled: true,
                    fillColor: _fieldFill,
                    contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 18),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(8),
                      borderSide: BorderSide.none,
                    ),
                    enabledBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(8),
                      borderSide: BorderSide.none,
                    ),
                    focusedBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(8),
                      borderSide: const BorderSide(color: _primaryTeal, width: 2),
                    ),
                    prefixIcon: Padding(
                      padding: const EdgeInsets.only(left: 12, right: 8),
                      child: Icon(LucideIcons.server, size: 22, color: _labelGrey),
                    ),
                    prefixIconConstraints: const BoxConstraints(minWidth: 44, minHeight: 48),
                  ),
                ),
                if (_deviceApprovalLine != null) ...[
                  const SizedBox(height: 6),
                  Text(
                    _deviceApprovalLine!,
                    textAlign: TextAlign.center,
                    style: GoogleFonts.robotoMono(
                      fontSize: 15,
                      fontWeight: FontWeight.w500,
                      color: _textBlack,
                    ),
                  ),
                ],
                const SizedBox(height: 20),
                TextField(
                  controller: _email,
                  keyboardType: TextInputType.emailAddress,
                  autocorrect: false,
                  style: _inputTextStyle,
                  cursorColor: _textBlack,
                  decoration: _decoration(label: 'User email').copyWith(
                    prefixIcon: Padding(
                      padding: const EdgeInsets.only(left: 12, right: 8),
                      child: Icon(LucideIcons.user, size: 22, color: _labelGrey),
                    ),
                    prefixIconConstraints: const BoxConstraints(minWidth: 44, minHeight: 48),
                  ),
                  onChanged: (_) async => _refreshVaultUi(),
                ),
                const SizedBox(height: 16),
                TextField(
                  controller: _password,
                  obscureText: _obscurePassword,
                  obscuringCharacter: '•',
                  style: _inputTextStyle.copyWith(
                    color: _textBlack,
                  ),
                  cursorColor: _textBlack,
                  decoration: _decoration(label: 'Password').copyWith(
                    prefixIcon: Padding(
                      padding: const EdgeInsets.only(left: 12, right: 8),
                      child: Icon(LucideIcons.lock, size: 22, color: _labelGrey),
                    ),
                    prefixIconConstraints: const BoxConstraints(minWidth: 44, minHeight: 48),
                    suffixIcon: IconButton(
                      onPressed: () => setState(() => _obscurePassword = !_obscurePassword),
                      icon: Icon(
                        _obscurePassword ? LucideIcons.eye : LucideIcons.eyeOff,
                        size: 22,
                        color: _labelGrey,
                      ),
                    ),
                  ),
                  onSubmitted: (_) {
                    if (!_busy) unawaited(_submit());
                  },
                ),
                if (_err != null) ...[
                  const SizedBox(height: 14),
                  Text(
                    _err!,
                    style: GoogleFonts.inter(fontSize: 12, color: Colors.red.shade700, height: 1.35),
                  ),
                ],
                const SizedBox(height: 28),
                SizedBox(
                  height: 52,
                  child: FilledButton(
                    style: FilledButton.styleFrom(
                      backgroundColor: _primaryTeal,
                      foregroundColor: Colors.white,
                      disabledBackgroundColor: _primaryTeal.withValues(alpha: 0.5),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                    ),
                    onPressed: _busy ? null : _submit,
                    child: Text(
                      _busy ? 'SIGNING IN…' : 'SIGN IN',
                      style: GoogleFonts.manrope(
                        fontSize: 16,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 2,
                      ),
                    ),
                  ),
                ),
                if (_vaultReady) ...[
                  const SizedBox(height: 12),
                  TextButton.icon(
                    onPressed: _busy ? null : _biometricSignIn,
                    icon: Icon(Icons.fingerprint, color: _primaryTeal, size: 26),
                    label: Text(
                      _vaultEmail != null && _vaultEmail!.isNotEmpty
                          ? 'Biometric sign-in ($_vaultEmail)'
                          : 'Biometric sign-in',
                      style: GoogleFonts.inter(
                        fontWeight: FontWeight.w600,
                        color: _primaryTeal,
                      ),
                    ),
                  ),
                ],
                const SizedBox(height: 24),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
