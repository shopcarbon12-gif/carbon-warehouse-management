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
  static const String kDefaultLoginEmail = 'user@carbonjeanscompany.com';
  static const double _fieldHeight = 64;

  static const Color _bg = Color(0xFFFFFFFF);
  static const Color _fieldFill = Color(0xFFF0F5F4);
  static const Color _labelGrey = Color(0xFF6D7979);
  static const Color _labelAboveField = Color(0xFF3D4949);
  static const Color _textBlack = Color(0xFF171D1D);
  static const Color _primaryTeal = Color(0xFF006768);

  final _serverUrl = TextEditingController();
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _emailFocus = FocusNode();
  final _passwordFocus = FocusNode();

  bool _busy = false;
  String? _err;
  bool _obscurePassword = true;
  String? _deviceApprovalLine;
  bool _vaultReady = false;
  String? _vaultEmail;
  bool _rememberEmail = true;
  bool _showBioHint = false;

  @override
  void initState() {
    super.initState();
    _emailFocus.addListener(_refocusDecoration);
    _passwordFocus.addListener(_refocusDecoration);
    WidgetsBinding.instance.addPostFrameCallback((_) => _bootstrap());
  }

  void _refocusDecoration() {
    if (mounted) setState(() {});
  }

  Future<void> _bootstrap() async {
    await LoginCredentialsStore.enforceRuggedNoPasswordPolicy();
    if (!mounted) return;
    final api = context.read<WmsApiClient>();
    final locked = WmsApiClient.lockedServerUrl;
    await api.setBaseUrl(locked);
    if (!mounted) return;
    _serverUrl.text = locked;

    _rememberEmail = await api.getRememberLoginEmail();
    final saved = await api.getSavedLoginEmail();
    if (!mounted) return;
    if (_rememberEmail && saved != null && saved.isNotEmpty) {
      _email.text = saved;
    } else {
      _email.text = kDefaultLoginEmail;
    }

    await _refreshVaultUi();
    await _loadDeviceApprovalLine();
    await _refreshBioHint();
  }

  Future<void> _refreshBioHint() async {
    final can = await LoginCredentialsStore.canUseBiometricPasswordVault();
    final vaulted = await LoginCredentialsStore.hasVaultedCredentials();
    if (!mounted) return;
    setState(() => _showBioHint = can && !vaulted);
  }

  Future<void> _applyRememberEmail(bool value) async {
    setState(() => _rememberEmail = value);
    await context.read<WmsApiClient>().setRememberLoginEmail(value);
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
    _emailFocus.removeListener(_refocusDecoration);
    _passwordFocus.removeListener(_refocusDecoration);
    _emailFocus.dispose();
    _passwordFocus.dispose();
    _serverUrl.dispose();
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  TextStyle get _fieldLabelStyle => GoogleFonts.spaceGrotesk(
        fontSize: 11,
        fontWeight: FontWeight.w700,
        letterSpacing: 1.2,
        color: _labelAboveField,
      );

  /// Same nominal font size as mock (`text-base`); [height] improves descender room inside fixed row.
  TextStyle get _inputTextStyle => GoogleFonts.spaceGrotesk(
        fontSize: 16,
        fontWeight: FontWeight.w500,
        height: 1.25,
        color: _textBlack,
      );

  static const InputDecoration _plainFieldDeco = InputDecoration(
    border: InputBorder.none,
    isDense: true,
    filled: false,
    contentPadding: EdgeInsets.zero,
  );

  Widget _labeledRow({
    required String label,
    required IconData icon,
    required Widget field,
    Widget? trailing,
    FocusNode? focusNode,
  }) {
    final focused = focusNode?.hasFocus ?? false;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(label, style: _fieldLabelStyle),
        const SizedBox(height: 8),
        Container(
          height: _fieldHeight,
          decoration: BoxDecoration(
            color: _fieldFill,
            borderRadius: BorderRadius.circular(8),
            border: focused ? Border.all(color: _primaryTeal, width: 2) : null,
          ),
          padding: const EdgeInsets.symmetric(horizontal: 16),
          clipBehavior: Clip.none,
          alignment: Alignment.center,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              Icon(icon, size: 20, color: _labelGrey),
              const SizedBox(width: 12),
              Expanded(
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: field,
                ),
              ),
              if (trailing != null) trailing,
            ],
          ),
        ),
      ],
    );
  }

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

      await api.setRememberLoginEmail(_rememberEmail);
      if (_rememberEmail) {
        await api.setSavedLoginEmail(email.trim());
      }

      if (!await LoginCredentialsStore.canUseBiometricPasswordVault()) {
        await LoginCredentialsStore.clearVault();
        await LoginCredentialsStore.setBiometricLoginEnabled(false);
      } else {
        if (!mounted) return;
        final offerEnrollment = await LoginCredentialsStore.shouldOfferBiometricEnrollment();
        if (!mounted) return;
        if (offerEnrollment) {
          final offer = await showDialog<bool>(
            context: context,
            builder: (ctx) => AlertDialog(
              title: const Text('Fingerprint or face sign-in'),
              content: const Text(
                'Save your password on this device and sign in next time with fingerprint or face unlock? '
                'Passwords are never stored on rugged handheld scanners.',
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(ctx, false),
                  child: const Text('Not now'),
                ),
                FilledButton(
                  onPressed: () => Navigator.pop(ctx, true),
                  child: const Text('Turn on'),
                ),
              ],
            ),
          );
          if (offer == true) {
            final bioOk = await LoginCredentialsStore.authenticateWithBiometric();
            if (bioOk) {
              await LoginCredentialsStore.setBiometricEnrollmentPromptSkipped(false);
              await LoginCredentialsStore.setBiometricLoginEnabled(true);
              await LoginCredentialsStore.storeVaultCredentials(email.trim(), password);
            }
          } else if (offer == false) {
            await LoginCredentialsStore.setBiometricEnrollmentPromptSkipped(true);
          }
        }
      }

      _password.clear();
      await _refreshVaultUi();
      await _refreshBioHint();
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
                          color: _labelAboveField,
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
                Container(
                  height: _fieldHeight,
                  decoration: BoxDecoration(
                    color: _fieldFill,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  alignment: Alignment.center,
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.center,
                    children: [
                      Icon(LucideIcons.server, size: 20, color: _labelGrey),
                      const SizedBox(width: 12),
                      Expanded(
                        child: TextField(
                          controller: _serverUrl,
                          readOnly: true,
                          enableInteractiveSelection: true,
                          style: _inputTextStyle,
                          decoration: _plainFieldDeco,
                        ),
                      ),
                    ],
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
                const SizedBox(height: 24),
                _labeledRow(
                  label: 'USER EMAIL',
                  icon: LucideIcons.user,
                  focusNode: _emailFocus,
                  field: TextField(
                    controller: _email,
                    focusNode: _emailFocus,
                    keyboardType: TextInputType.emailAddress,
                    autocorrect: false,
                    textAlignVertical: TextAlignVertical.center,
                    style: _inputTextStyle,
                    cursorColor: _textBlack,
                    decoration: _plainFieldDeco,
                    onChanged: (_) => unawaited(_refreshVaultUi()),
                  ),
                ),
                const SizedBox(height: 24),
                _labeledRow(
                  label: 'PASSWORD',
                  icon: LucideIcons.lock,
                  focusNode: _passwordFocus,
                  field: TextField(
                    controller: _password,
                    focusNode: _passwordFocus,
                    obscureText: _obscurePassword,
                    obscuringCharacter: '•',
                    textAlignVertical: TextAlignVertical.center,
                    style: _inputTextStyle,
                    cursorColor: _textBlack,
                    decoration: _plainFieldDeco,
                    onSubmitted: (_) {
                      if (!_busy) unawaited(_submit());
                    },
                  ),
                  trailing: IconButton(
                    padding: EdgeInsets.zero,
                    constraints: const BoxConstraints(minWidth: 40, minHeight: 40),
                    onPressed: () => setState(() => _obscurePassword = !_obscurePassword),
                    icon: Icon(
                      _obscurePassword ? LucideIcons.eye : LucideIcons.eyeOff,
                      size: 22,
                      color: _labelGrey,
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                InkWell(
                  onTap: () => unawaited(_applyRememberEmail(!_rememberEmail)),
                  borderRadius: BorderRadius.circular(8),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.center,
                      children: [
                        SizedBox(
                          width: 24,
                          height: 24,
                          child: Checkbox(
                            value: _rememberEmail,
                            activeColor: _primaryTeal,
                            materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                            visualDensity: VisualDensity.compact,
                            onChanged: (v) => unawaited(_applyRememberEmail(v ?? true)),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            'Remember email on this device',
                            style: GoogleFonts.inter(
                              fontSize: 14,
                              fontWeight: FontWeight.w500,
                              color: _textBlack,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                if (_showBioHint) ...[
                  const SizedBox(height: 8),
                  Text(
                    'After you sign in, you can turn on fingerprint or face sign-in for faster login.',
                    style: GoogleFonts.inter(
                      fontSize: 12,
                      color: _labelGrey,
                      height: 1.35,
                    ),
                  ),
                ],
                if (_err != null) ...[
                  const SizedBox(height: 14),
                  Text(
                    _err!,
                    style: GoogleFonts.inter(fontSize: 12, color: Colors.red.shade700, height: 1.35),
                  ),
                ],
                const SizedBox(height: 28),
                SizedBox(
                  height: _fieldHeight,
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
                    icon: const Icon(Icons.fingerprint, color: _primaryTeal, size: 26),
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
