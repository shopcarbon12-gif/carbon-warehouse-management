import 'dart:async' show TimeoutException, unawaited;
import 'dart:io' show Platform, SocketException;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/handheld_client_info.dart';
import 'package:carbon_wms/services/handheld_device_identity.dart';
import 'package:carbon_wms/services/login_credentials_store.dart';

/// Login only — mock-aligned tray fields, light local theme (no app-wide green M3 inputs).
/// Form scrolls inside [SingleChildScrollView] when the keyboard needs space; no [FittedBox] shrink.
///
/// **Device authorization line:** hidden when `GET /api/mobile/status` returns `authorized: true`
/// or `bypassDeviceLock: true` (see [_loadDeviceApprovalLine]).
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.onSuccess});

  final Future<void> Function() onSuccess;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> with WidgetsBindingObserver {
  static const String kDefaultLoginEmail = 'user@carbonjeanscompany.com';
  static const String kLockedServerDisplay = 'https://wms.shopcarbon.com';

  /// Bundled from brand kit: `Neuzeit Grotesk W01 Regular.otf` (bold via [FontWeight.w700]).
  static const String _kBrandFontFamily = 'NeuzeitGrotesk';
  static const double _logoCornerRadius = 14;
  /// Smaller on-screen square; [BoxFit.cover] zooms the mark inside the clip.
  static const double _logoDisplaySize = 120;
  /// Reserved height for MAC / Android ID so USER EMAIL lines up whether or not the line shows.
  static const double _deviceLineReserveHeight = 48;

  static const double _fieldHeight = 52;

  static const double _iconPerson = 20;
  static const double _iconDnsLockEye = 22;

  static const Color _bg = Color(0xFFF5F5F5);
  static const Color _fieldFill = Color(0xFFECECEC);
  static const Color _labelGrey = Color(0xFF8A9090);
  static const Color _labelAboveField = Color(0xFF4A5454);
  static const Color _textBlack = Color(0xFF171D1D);
  static const Color _primaryTeal = Color(0xFF1B7D7D);
  /// Subtitle: slightly darker than [_labelGrey], not as strong as body black.
  static const Color _subtitleGrey = Color(0xFF6A7070);

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
    WidgetsBinding.instance.addObserver(this);
    _emailFocus.addListener(_refocusDecoration);
    _passwordFocus.addListener(_refocusDecoration);
    WidgetsBinding.instance.addPostFrameCallback((_) => _bootstrap());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      unawaited(_refreshVaultUi());
      unawaited(_loadDeviceApprovalLine());
    }
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

    _rememberEmail = await api.getRememberLoginEmail();
    final saved = await api.getSavedLoginEmail();
    final offerBio = await LoginCredentialsStore.getOfferBiometricSetupAfterSignIn();
    final bioCapable = await LoginCredentialsStore.canUseBiometricPasswordVault();
    if (!mounted) return;
    if (_rememberEmail && saved != null && saved.isNotEmpty) {
      _email.text = saved;
    } else {
      _email.text = '';
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
    final api = context.read<WmsApiClient>();
    await api.setRememberLoginEmail(value);
    if (!value && mounted) {
      _email.clear();
      setState(() {});
    }
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
    WidgetsBinding.instance.removeObserver(this);
    _emailFocus.removeListener(_refocusDecoration);
    _passwordFocus.removeListener(_refocusDecoration);
    _emailFocus.dispose();
    _passwordFocus.dispose();
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  TextStyle get _fieldLabelStyle => GoogleFonts.inter(
        fontSize: 11,
        fontWeight: FontWeight.w700,
        letterSpacing: 0.9,
        color: _labelAboveField,
      );

  TextStyle get _inputTextStyle => GoogleFonts.inter(
        fontSize: 15,
        fontWeight: FontWeight.w500,
        height: 1.2,
        color: _textBlack,
      );

  TextStyle get _inputTextStyleMuted => GoogleFonts.inter(
        fontSize: 15,
        fontWeight: FontWeight.w500,
        height: 1.2,
        color: _labelGrey,
      );

  /// Server URL row — larger text only (tray height unchanged).
  TextStyle get _serverUrlTextStyle => GoogleFonts.inter(
        fontSize: 17,
        fontWeight: FontWeight.w500,
        height: 1.2,
        color: _textBlack,
      );

  /// Email field typed text — larger only.
  TextStyle get _emailTrayTextStyle => GoogleFonts.inter(
        fontSize: 17,
        fontWeight: FontWeight.w500,
        height: 1.2,
        color: _textBlack,
      );

  /// Email hint — larger only.
  TextStyle get _emailTrayHintStyle => GoogleFonts.inter(
        fontSize: 17,
        fontWeight: FontWeight.w500,
        height: 1.2,
        color: _labelGrey,
      );

  TextStyle get _brandTitleStyle => const TextStyle(
        fontFamily: _kBrandFontFamily,
        fontSize: 28,
        fontWeight: FontWeight.w700,
        letterSpacing: 1.05,
        height: 1.05,
        color: Colors.black,
      );

  TextStyle get _deviceIdLineStyle => GoogleFonts.inter(
        fontSize: 15,
        fontWeight: FontWeight.w600,
        height: 1.2,
        color: Colors.black,
      );

  static const InputDecoration _trayInputDecoration = InputDecoration(
    border: InputBorder.none,
    isDense: true,
    filled: false,
    contentPadding: EdgeInsets.zero,
  );

  Widget _loginTray({
    required Widget leadingIcon,
    required Widget input,
    double gapAfterIcon = 10,
    double horizontalPadding = 14,
    Widget? trailing,
  }) {
    return Container(
      height: _fieldHeight,
      decoration: BoxDecoration(
        color: _fieldFill,
        borderRadius: BorderRadius.circular(10),
      ),
      padding: EdgeInsets.only(
        left: horizontalPadding,
        right: trailing != null ? 6 : horizontalPadding,
      ),
      alignment: Alignment.center,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          leadingIcon,
          SizedBox(width: gapAfterIcon),
          Expanded(child: input),
          if (trailing != null) trailing,
        ],
      ),
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

  /// [MaterialApp] uses dark industrial theme — snackbars must not inherit unreadable styles on login.
  void _showLoginSnack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        behavior: SnackBarBehavior.floating,
        backgroundColor: const Color(0xFF2D2D2D),
        content: Text(message, style: const TextStyle(color: Colors.white, fontSize: 14, height: 1.3)),
      ),
    );
  }

  /// Blocking dialog so messages are not shown on top of the dashboard after [onSuccess] (report §5.2).
  Future<void> _awaitLoginAlert(String title, String message) async {
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      builder: (ctx) => Theme(
        data: _loginShellTheme(),
        child: AlertDialog(
          title: Text(title),
          content: Text(message),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('OK')),
          ],
        ),
      ),
    );
  }

  Future<void> _maybeOfferBiometricEnrollment(String email) async {
    if (!await LoginCredentialsStore.canUseBiometricPasswordVault()) {
      await LoginCredentialsStore.clearVault();
      await LoginCredentialsStore.setBiometricLoginEnabled(false);
      return;
    }
    if (!await LoginCredentialsStore.shouldOfferBiometricEnrollment()) return;
    if (!mounted) return;

    final api = context.read<WmsApiClient>();

    try {
      final offer = await showDialog<bool>(
        context: context,
        builder: (ctx) => Theme(
          data: _loginShellTheme(),
          child: AlertDialog(
            title: const Text('Fingerprint or face sign-in'),
            content: const Text(
              'Use fingerprint or face to unlock CarbonWMS on this device next time? '
              'Only an encrypted session token is stored — your password is never saved.',
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
        ),
      );

      if (offer == true) {
        final bioOk = await LoginCredentialsStore.authenticateWithBiometric();
        if (!mounted) return;
        if (bioOk) {
          final token = await api.getSessionToken();
          if (token != null && token.isNotEmpty) {
            await LoginCredentialsStore.setBiometricEnrollmentPromptSkipped(false);
            await LoginCredentialsStore.storeBiometricEnrollment(
              email: email.trim(),
              sessionToken: token,
            );
            await LoginCredentialsStore.setBiometricLoginEnabled(true);
          } else {
            await _awaitLoginAlert(
              'Biometric setup',
              'Could not save biometric sign-in (no session token). Sign in with password again, then retry setup.',
            );
          }
        } else {
          await _awaitLoginAlert(
            'Biometric setup',
            'Biometric verification was cancelled or failed. You can try again from Handheld settings after your next password sign-in.',
          );
        }
      } else if (offer == false) {
        await LoginCredentialsStore.setBiometricEnrollmentPromptSkipped(true);
      }
    } catch (e, st) {
      debugPrint('Biometric enrollment UI: $e\n$st');
      if (mounted) {
        await _awaitLoginAlert('Biometric setup', _formatLoginFailure(e));
      }
    }
  }

  String get _resolvedEmail {
    final t = _email.text.trim();
    return t.isEmpty ? kDefaultLoginEmail : t;
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
      } else {
        await api.setSavedLoginEmail(null);
      }

      await _maybeOfferBiometricEnrollment(email.trim());

      _password.clear();
      await _refreshVaultUi();
      if (mounted) ScaffoldMessenger.of(context).clearSnackBars();
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
    await _submitWithCredentials(_resolvedEmail, _password.text);
  }

  Future<void> _biometricSignIn() async {
    try {
      final ok = await LoginCredentialsStore.authenticateWithBiometric();
      if (!ok || !mounted) {
        if (mounted) {
          _showLoginSnack('Biometric sign-in was cancelled or is unavailable.');
        }
        return;
      }
      final api = context.read<WmsApiClient>();
      final token = await LoginCredentialsStore.readVaultSessionToken();
      if (token == null || token.isEmpty) {
        if (mounted) {
          _showLoginSnack(
            'No saved session for biometric sign-in. Sign in with password once and complete setup when prompted.',
          );
        }
        return;
      }
      await api.setBaseUrl(WmsApiClient.lockedServerUrl);
      await api.setSessionToken(token);
      if (!mounted) return;
      await widget.onSuccess();
    } on Object catch (e) {
      if (!mounted) return;
      _showLoginSnack(_formatLoginFailure(e));
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
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            SizedBox(
              width: 26,
              height: 26,
              child: Checkbox(
                value: value,
                side: const BorderSide(color: _primaryTeal, width: 1.5),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(3)),
                fillColor: WidgetStateProperty.resolveWith((states) {
                  if (states.contains(WidgetState.selected)) return _primaryTeal;
                  return Colors.transparent;
                }),
                checkColor: Colors.white,
                materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                visualDensity: VisualDensity.compact,
                onChanged: (v) => onChanged(v ?? false),
              ),
            ),
            const SizedBox(width: 6),
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

  /// **MaterialApp** is dark M3 + green primary — that leaks green focus rings and filled input
  /// “pills” into [TextField]s. This login uses an isolated **light M2** theme so trays stay flat.
  ThemeData _loginShellTheme() {
    return ThemeData(
      useMaterial3: false,
      brightness: Brightness.light,
      primaryColor: _primaryTeal,
      scaffoldBackgroundColor: _bg,
      canvasColor: _bg,
      splashFactory: NoSplash.splashFactory,
      colorScheme: const ColorScheme.light(
        primary: _primaryTeal,
        onPrimary: Colors.white,
        secondary: _primaryTeal,
        onSecondary: Colors.white,
        surface: _bg,
        onSurface: _textBlack,
      ),
      inputDecorationTheme: const InputDecorationTheme(
        filled: false,
        fillColor: Colors.transparent,
        border: InputBorder.none,
        enabledBorder: InputBorder.none,
        focusedBorder: InputBorder.none,
        errorBorder: InputBorder.none,
        focusedErrorBorder: InputBorder.none,
        disabledBorder: InputBorder.none,
        isDense: true,
        contentPadding: EdgeInsets.zero,
        hoverColor: Colors.transparent,
      ),
      textSelectionTheme: const TextSelectionThemeData(
        cursorColor: _textBlack,
        selectionColor: Color(0x401B7D7D),
        selectionHandleColor: _primaryTeal,
      ),
      checkboxTheme: CheckboxThemeData(
        fillColor: WidgetStateProperty.resolveWith((states) {
          if (states.contains(WidgetState.selected)) return _primaryTeal;
          return Colors.transparent;
        }),
        checkColor: WidgetStateProperty.all(Colors.white),
        side: const BorderSide(color: _primaryTeal, width: 1.5),
        materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
        visualDensity: VisualDensity.compact,
      ),
    );
  }

  /// Scroll only when needed (keyboard / short viewport). No [FittedBox] — avoids whole-UI shrink.
  List<Widget> _loginScrollableFormChildren() {
    return [
      const SizedBox(height: 28),
      Center(
        child: SizedBox(
          width: _logoDisplaySize,
          height: _logoDisplaySize,
          child: ClipRRect(
            borderRadius: BorderRadius.circular(_logoCornerRadius),
            child: Image.asset(
              'assets/carbon_logo.png',
              fit: BoxFit.cover,
              alignment: Alignment.center,
              filterQuality: FilterQuality.high,
            ),
          ),
        ),
      ),
      const SizedBox(height: 10),
      Text(
        'CarbonWMS',
        textAlign: TextAlign.center,
        style: _brandTitleStyle,
      ),
      const SizedBox(height: 8),
      Text(
        'WAREHOUSE MANAGEMENT SOFTWARE',
        textAlign: TextAlign.center,
        style: GoogleFonts.inter(
          fontSize: 14,
          fontWeight: FontWeight.w500,
          letterSpacing: 0.45,
          height: 1.2,
          color: _subtitleGrey,
        ),
      ),
      const SizedBox(height: 28),
      Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Expanded(child: Text('SERVER URL', style: _fieldLabelStyle)),
          Text(
            'CONNECTED VIA SSL',
            style: GoogleFonts.inter(
              fontSize: 9,
              fontWeight: FontWeight.w500,
              letterSpacing: 0.35,
              color: _labelGrey,
            ),
          ),
        ],
      ),
      const SizedBox(height: 6),
      _loginTray(
        leadingIcon: Icon(
          Icons.dns_outlined,
          size: _iconDnsLockEye,
          color: _labelGrey.withValues(alpha: 0.85),
        ),
        gapAfterIcon: 10,
        input: Text(
          kLockedServerDisplay,
          style: _serverUrlTextStyle,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
      ),
      const SizedBox(height: 8),
      SizedBox(
        height: _deviceLineReserveHeight,
        width: double.infinity,
        child: _deviceApprovalLine != null
            ? Align(
                alignment: Alignment.topCenter,
                child: Text(
                  _deviceApprovalLine!,
                  textAlign: TextAlign.center,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: _deviceIdLineStyle,
                ),
              )
            : const SizedBox.shrink(),
      ),
      const SizedBox(height: 12),
      Text('USER EMAIL', style: _fieldLabelStyle),
      const SizedBox(height: 6),
      _loginTray(
        leadingIcon: Icon(
          Icons.person_outline,
          size: _iconPerson,
          color: _labelGrey.withValues(alpha: 0.9),
        ),
        gapAfterIcon: 4,
        input: TextField(
          controller: _email,
          focusNode: _emailFocus,
          keyboardType: TextInputType.emailAddress,
          autocorrect: false,
          textAlignVertical: TextAlignVertical.center,
          style: _emailTrayTextStyle,
          cursorColor: _textBlack,
          decoration: _trayInputDecoration.copyWith(
            hintText: kDefaultLoginEmail,
            hintStyle: _emailTrayHintStyle,
            contentPadding: const EdgeInsets.symmetric(vertical: 2),
          ),
          onChanged: (_) => unawaited(_refreshVaultUi()),
        ),
      ),
      const SizedBox(height: 12),
      Text('PASSWORD', style: _fieldLabelStyle),
      const SizedBox(height: 6),
      _loginTray(
        leadingIcon: Icon(
          Icons.lock_outline,
          size: _iconDnsLockEye,
          color: _labelGrey.withValues(alpha: 0.85),
        ),
        gapAfterIcon: 10,
        input: Builder(
          builder: (context) {
            final hasPassword = _password.text.isNotEmpty;
            return TextField(
              controller: _password,
              focusNode: _passwordFocus,
              obscureText: hasPassword && _obscurePassword,
              obscuringCharacter: '•',
              textAlignVertical: TextAlignVertical.center,
              style: _inputTextStyle,
              cursorColor: _textBlack,
              decoration: hasPassword
                  ? _trayInputDecoration
                  : _trayInputDecoration.copyWith(
                      hintText: '••••••••••••',
                      hintStyle: _inputTextStyleMuted,
                      contentPadding: const EdgeInsets.symmetric(vertical: 2),
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
                width: 44,
                height: 44,
                child: Center(
                  child: Icon(
                    _obscurePassword ? Icons.visibility_outlined : Icons.visibility_off_outlined,
                    size: _iconDnsLockEye,
                    color: _labelGrey,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
      const SizedBox(height: 6),
      _checkRow(
        value: _rememberEmail,
        onChanged: (v) => unawaited(_applyRememberEmail(v)),
        label: 'Remember email on this device',
      ),
      if (_bioCapableDevice) ...[
        const SizedBox(height: 2),
        _checkRow(
          value: _offerBiometricSetupAfterSignIn,
          onChanged: (v) => unawaited(_applyOfferBiometric(v)),
          label: 'Biometric login',
        ),
      ],
      if (_err != null) ...[
        const SizedBox(height: 8),
        Text(
          _err!,
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          style: GoogleFonts.inter(
            fontSize: 11,
            color: Colors.red.shade700,
            height: 1.3,
          ),
        ),
      ],
      const SizedBox(height: 12),
    ];
  }

  @override
  Widget build(BuildContext context) {
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.dark.copyWith(
        statusBarColor: Colors.transparent,
        systemNavigationBarColor: _bg,
      ),
      child: Theme(
        data: _loginShellTheme(),
        child: Scaffold(
          resizeToAvoidBottomInset: false,
          backgroundColor: _bg,
          body: SafeArea(
            child: AnimatedPadding(
              duration: const Duration(milliseconds: 120),
              curve: Curves.easeOutCubic,
              padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 6),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                  Expanded(
                    child: LayoutBuilder(
                      builder: (context, constraints) {
                        return SingleChildScrollView(
                          physics: const ClampingScrollPhysics(),
                          child: ConstrainedBox(
                            constraints: BoxConstraints(minWidth: constraints.maxWidth),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: _loginScrollableFormChildren(),
                            ),
                          ),
                        );
                      },
                    ),
                  ),
                  if (_vaultReady)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 4),
                      child: TextButton.icon(
                        onPressed: _busy ? null : _biometricSignIn,
                        icon: const Icon(Icons.fingerprint, color: _primaryTeal, size: 22),
                        label: Text(
                          _vaultEmail != null && _vaultEmail!.isNotEmpty
                              ? 'Biometric sign-in ($_vaultEmail)'
                              : 'Biometric sign-in',
                          style: GoogleFonts.inter(
                            fontWeight: FontWeight.w600,
                            color: _primaryTeal,
                            fontSize: 13,
                          ),
                        ),
                      ),
                    ),
                  SizedBox(
                    height: _fieldHeight,
                    child: Material(
                      color: Colors.transparent,
                      child: InkWell(
                        onTap: _busy ? null : _submit,
                        borderRadius: BorderRadius.circular(10),
                        child: Ink(
                          decoration: BoxDecoration(
                            color: _primaryTeal,
                            borderRadius: BorderRadius.circular(10),
                          ),
                          child: Center(
                            child: Text(
                              _busy ? 'SIGNING IN…' : 'SIGN IN',
                              style: GoogleFonts.inter(
                                fontSize: 17,
                                fontWeight: FontWeight.w800,
                                letterSpacing: 1.1,
                                color: Colors.white,
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
