import 'dart:async' show TimeoutException, unawaited;
import 'dart:io' show Platform, SocketException;

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

/// Light login layout aligned with `APK UI` mocks (rounded-md fields, gradient CTA).
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.onSuccess});

  final Future<void> Function() onSuccess;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  static const String kDefaultLoginEmail = 'user@carbonjeanscompany.com';
  static const double _fieldHeight = 64;

  /// Email leading icon slightly smaller; server / lock / eye share one size (28px — Lucide eye reads smaller than lock at 24).
  static const double _iconSizeEmailRow = 20;
  static const double _iconSizeFieldRow = 28;

  /// Mint wash like early CarbonWMS handheld mock (not pure white).
  static const Color _bg = Color(0xFFF5FAFA);
  static const Color _fieldFill = Color(0xFFF0F5F4);
  static const Color _pillFill = Color(0xFFFFFFFF);
  /// Thin dark edge on white pill (mock: pill inside grey tray).
  static const Color _pillBorder = Color(0xFF6D7979);
  static const Color _labelGrey = Color(0xFF6D7979);
  static const Color _labelAboveField = Color(0xFF3D4949);
  static const Color _textBlack = Color(0xFF171D1D);
  static const Color _primaryTeal = Color(0xFF006768);
  static const Color _primaryTealDeep = Color(0xFF008284);

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
  bool _offerBiometricSetupAfterSignIn = false;
  bool _bioCapableDevice = false;

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
    final offerBio = await LoginCredentialsStore.getOfferBiometricSetupAfterSignIn();
    final bioCapable = await LoginCredentialsStore.canUseBiometricPasswordVault();
    if (!mounted) return;
    if (_rememberEmail && saved != null && saved.isNotEmpty) {
      _email.text = saved;
    } else {
      _email.text = kDefaultLoginEmail;
    }
    setState(() {
      _offerBiometricSetupAfterSignIn = offerBio;
      _bioCapableDevice = bioCapable;
    });

    await _refreshVaultUi();
    await _loadDeviceApprovalLine();
  }

  Future<void> _applyRememberEmail(bool value) async {
    setState(() => _rememberEmail = value);
    await context.read<WmsApiClient>().setRememberLoginEmail(value);
  }

  Future<void> _applyOfferBiometric(bool value) async {
    setState(() => _offerBiometricSetupAfterSignIn = value);
    await LoginCredentialsStore.setOfferBiometricSetupAfterSignIn(value);
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

  TextStyle get _inputTextStyle => GoogleFonts.spaceGrotesk(
        fontSize: 16,
        fontWeight: FontWeight.w500,
        height: 1.25,
        color: _textBlack,
      );

  /// Password placeholder bullets (empty field); real input uses [_inputTextStyle] (black).
  TextStyle get _inputTextStyleMuted => GoogleFonts.spaceGrotesk(
        fontSize: 16,
        fontWeight: FontWeight.w500,
        height: 1.25,
        color: _labelGrey,
      );

  static const InputDecoration _pillFieldDeco = InputDecoration(
    border: InputBorder.none,
    isDense: true,
    filled: false,
    contentPadding: EdgeInsets.symmetric(horizontal: 4, vertical: 10),
  );

  /// White rounded pill (text lives here); icons stay in the outer grey [`_fieldFill`] tray.
  Widget _inputPill({required bool focused, required Widget child}) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: _pillFill,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(
          color: focused ? _primaryTeal : _pillBorder,
          width: focused ? 2 : 1,
        ),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.04),
            blurRadius: 4,
            offset: const Offset(0, 1),
          ),
        ],
      ),
      child: child,
    );
  }

  Widget _labeledRow({
    required String label,
    required IconData icon,
    required Widget field,
    Widget? trailing,
    FocusNode? focusNode,
    double leadingIconSize = _iconSizeFieldRow,
    double iconAfterGap = 12,
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
          ),
          padding: const EdgeInsets.only(left: 12, right: 8),
          alignment: Alignment.center,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              Icon(icon, size: leadingIconSize, color: _labelGrey),
              SizedBox(width: iconAfterGap),
              Expanded(
                child: _inputPill(
                  focused: focused,
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

  String _formatLoginFailure(Object e) {
    final t = e.runtimeType.toString();
    if (t.contains('LocalAuth') || e is PlatformException) {
      return 'Biometric setup failed. Open Android Settings → Security and ensure fingerprint '
          'or face unlock is set up, then try again.';
    }
    return 'Cannot reach server. Check Wi‑Fi and that the site is up.\n($t)';
  }

  /// Never throws; does not block navigation on biometric errors.
  Future<void> _maybeOfferBiometricEnrollment(String email, String password) async {
    if (!await LoginCredentialsStore.canUseBiometricPasswordVault()) {
      await LoginCredentialsStore.clearVault();
      await LoginCredentialsStore.setBiometricLoginEnabled(false);
      return;
    }
    if (!await LoginCredentialsStore.shouldOfferBiometricEnrollment()) return;
    if (!mounted) return;

    try {
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
        if (!mounted) return;
        if (bioOk) {
          await LoginCredentialsStore.setBiometricEnrollmentPromptSkipped(false);
          await LoginCredentialsStore.setBiometricLoginEnabled(true);
          await LoginCredentialsStore.storeVaultCredentials(email.trim(), password);
        } else {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text(
                'Biometric verification was cancelled or failed. You can try again from Handheld settings.',
              ),
            ),
          );
        }
      } else if (offer == false) {
        await LoginCredentialsStore.setBiometricEnrollmentPromptSkipped(true);
      }
    } catch (e, st) {
      debugPrint('Biometric enrollment UI: $e\n$st');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(_formatLoginFailure(e))),
        );
      }
    }
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

      await _maybeOfferBiometricEnrollment(email.trim(), password);

      _password.clear();
      await _refreshVaultUi();
      await widget.onSuccess();
    } on TimeoutException {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _err = 'Connection timed out. Check Wi‑Fi and try again.';
      });
    } on SocketException {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _err = 'Cannot reach server. Check Wi‑Fi and that the site is up.';
      });
    } on Object catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _err = _formatLoginFailure(e);
      });
    }
  }

  Future<void> _submit() async {
    await _submitWithCredentials(_email.text, _password.text);
  }

  Future<void> _biometricSignIn() async {
    try {
      final ok = await LoginCredentialsStore.authenticateWithBiometric();
      if (!ok || !mounted) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('Biometric sign-in was cancelled or is unavailable.'),
            ),
          );
        }
        return;
      }
      final email = await LoginCredentialsStore.readVaultEmail();
      final pass = await LoginCredentialsStore.readVaultPassword();
      if (email == null || pass == null || email.isEmpty || pass.isEmpty) return;
      await _submitWithCredentials(email, pass);
    } on Object catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(_formatLoginFailure(e))),
      );
    }
  }

  Widget _checkRow({
    required bool value,
    required ValueChanged<bool> onChanged,
    required String label,
  }) {
    return InkWell(
      onTap: () => onChanged(!value),
      borderRadius: BorderRadius.circular(8),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            SizedBox(
              width: 28,
              height: 28,
              child: Checkbox(
                value: value,
                activeColor: _primaryTeal,
                side: const BorderSide(color: _primaryTeal, width: 2),
                materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                visualDensity: VisualDensity.compact,
                onChanged: (v) => onChanged(v ?? false),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                label,
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
    );
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
                  padding: const EdgeInsets.only(left: 12, right: 12),
                  alignment: Alignment.center,
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.center,
                    children: [
                      const Icon(LucideIcons.server, size: _iconSizeFieldRow, color: _labelGrey),
                      const SizedBox(width: 12),
                      Expanded(
                        child: _inputPill(
                          focused: false,
                          child: TextField(
                            controller: _serverUrl,
                            readOnly: true,
                            enableInteractiveSelection: true,
                            style: _inputTextStyle,
                            decoration: _pillFieldDeco,
                          ),
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
                  leadingIconSize: _iconSizeEmailRow,
                  iconAfterGap: 4,
                  focusNode: _emailFocus,
                  field: TextField(
                    controller: _email,
                    focusNode: _emailFocus,
                    keyboardType: TextInputType.emailAddress,
                    autocorrect: false,
                    textAlignVertical: TextAlignVertical.center,
                    style: _inputTextStyle,
                    cursorColor: _textBlack,
                    decoration: _pillFieldDeco,
                    onChanged: (_) => unawaited(_refreshVaultUi()),
                  ),
                ),
                const SizedBox(height: 24),
                _labeledRow(
                  label: 'PASSWORD',
                  icon: LucideIcons.lock,
                  focusNode: _passwordFocus,
                  field: Builder(
                    builder: (context) {
                      final hasPassword = _password.text.isNotEmpty;
                      // Empty + obscureText:true makes Flutter paint bullets with [style] (black), not hintStyle.
                      // Grey dots = hint while empty; real input uses black + obscuring when non-empty.
                      return TextField(
                        controller: _password,
                        focusNode: _passwordFocus,
                        obscureText: hasPassword && _obscurePassword,
                        obscuringCharacter: '•',
                        textAlignVertical: TextAlignVertical.center,
                        style: _inputTextStyle,
                        cursorColor: _textBlack,
                        decoration: hasPassword
                            ? _pillFieldDeco
                            : InputDecoration(
                                border: InputBorder.none,
                                isDense: true,
                                filled: false,
                                contentPadding: const EdgeInsets.symmetric(horizontal: 4, vertical: 10),
                                hintText: '••••••••••••',
                                hintStyle: _inputTextStyleMuted,
                              ),
                        onChanged: (_) => setState(() {}),
                        onSubmitted: (_) {
                          if (!_busy) unawaited(_submit());
                        },
                      );
                    },
                  ),
                  trailing: Tooltip(
                    message: _obscurePassword ? 'Show password' : 'Hide password',
                    child: Material(
                      type: MaterialType.transparency,
                      child: InkWell(
                        onTap: () => setState(() => _obscurePassword = !_obscurePassword),
                        customBorder: const CircleBorder(),
                        child: SizedBox(
                          width: 48,
                          height: 48,
                          child: Center(
                            child: Icon(
                              _obscurePassword ? LucideIcons.eye : LucideIcons.eyeOff,
                              size: _iconSizeFieldRow,
                              color: _labelGrey,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                _checkRow(
                  value: _rememberEmail,
                  onChanged: (v) => unawaited(_applyRememberEmail(v)),
                  label: 'Remember email on this device',
                ),
                if (_bioCapableDevice) ...[
                  const SizedBox(height: 4),
                  _checkRow(
                    value: _offerBiometricSetupAfterSignIn,
                    onChanged: (v) => unawaited(_applyOfferBiometric(v)),
                    label: 'Biometric login',
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
                  child: Material(
                    color: Colors.transparent,
                    child: InkWell(
                      onTap: _busy ? null : _submit,
                      borderRadius: BorderRadius.circular(8),
                      child: Ink(
                        decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(8),
                          gradient: const LinearGradient(
                            begin: Alignment.topCenter,
                            end: Alignment.bottomCenter,
                            colors: [_primaryTeal, _primaryTealDeep],
                          ),
                          boxShadow: [
                            BoxShadow(
                              color: Colors.black.withValues(alpha: 0.12),
                              blurRadius: 12,
                              offset: const Offset(0, 4),
                            ),
                          ],
                        ),
                        child: Center(
                          child: Text(
                            _busy ? 'SIGNING IN…' : 'SIGN IN',
                            style: GoogleFonts.manrope(
                              fontSize: 16,
                              fontWeight: FontWeight.w800,
                              letterSpacing: 2,
                              color: Colors.white,
                            ),
                          ),
                        ),
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
