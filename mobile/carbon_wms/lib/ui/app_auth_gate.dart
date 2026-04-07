import 'dart:async';
import 'dart:io' show Platform;

import 'package:android_id/android_id.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/handheld_client_info.dart';
import 'package:carbon_wms/services/login_credentials_store.dart';
import 'package:carbon_wms/ui/screens/dashboard_screen.dart';
import 'package:carbon_wms/ui/screens/device_lock_screen.dart';
import 'package:carbon_wms/ui/screens/login_screen.dart';
import 'package:carbon_wms/ui/widgets/ota_update_dialog.dart';

enum _Phase { booting, login, lock, dashboard }

/// Boots RFID stack, login, Android ID registration, and `/api/mobile/status` gate.
class AppAuthGate extends StatefulWidget {
  const AppAuthGate({super.key});

  @override
  State<AppAuthGate> createState() => _AppAuthGateState();
}

class _AppAuthGateState extends State<AppAuthGate> with WidgetsBindingObserver {
  _Phase _phase = _Phase.booting;
  String _androidId = '';
  bool _pending = false;
  String? _otaUrl;
  String? _otaLatestVersion;
  bool _otaDismissed = false;
  int _loginKey = 0;
  WmsApiClient? _apiForLifecycle;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _apiForLifecycle = context.read<WmsApiClient>();
      _boot();
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.detached) {
      final api = _apiForLifecycle;
      if (api != null) {
        unawaited(api.setSessionToken(null));
      }
    }
  }

  Future<String> _resolveAndroidId() async {
    if (kIsWeb) return '';
    if (!Platform.isAndroid) return 'non-android';
    try {
      final raw = await const AndroidId().getId();
      return raw?.trim() ?? '';
    } catch (_) {
      return '';
    }
  }

  Future<void> _boot() async {
    if (!mounted) return;
    final api = context.read<WmsApiClient>();
    final rfid = context.read<RfidManager>();
    await rfid.autoDetectHardware();

    final token = await api.getSessionToken();
    if (token == null || token.isEmpty) {
      if (mounted) setState(() => _phase = _Phase.login);
      return;
    }

    await _evaluateSession();
  }

  Future<void> _evaluateSession() async {
    if (!mounted) return;
    final api = context.read<WmsApiClient>();
    final info = await PackageInfo.fromPlatform();
    final version = info.version;
    _androidId = await _resolveAndroidId();

    try {
      if (_androidId.isNotEmpty) {
        final clientInfo = await HandheldClientInfo.collect();
        await api.postDevicePing(androidId: _androidId, clientInfo: clientInfo);
      }
    } catch (_) {
      /* ping is best-effort; status below is authoritative */
    }

    Map<String, dynamic> status;
    try {
      status = await api.fetchMobileStatus(version: version, androidId: _androidId.isEmpty ? null : _androidId);
    } catch (_) {
      if (mounted) {
        setState(() {
          _loginKey++;
          _phase = _Phase.login;
        });
      }
      await api.setSessionToken(null);
      return;
    }

    final authorized = status['authorized'] == true;
    final registered = status['registered'] == true;
    final bypass = status['bypassDeviceLock'] == true;
    final updateAvailable = status['updateAvailable'] == true;
    final downloadUrl = status['downloadUrl'] as String?;
    final latestRaw = status['latestVersion'];
    final latestLabel = latestRaw is String ? latestRaw.trim() : '';

    if (mounted) {
      setState(() {
        _otaUrl = downloadUrl;
        _otaLatestVersion = latestLabel.isNotEmpty ? latestLabel : null;
        _otaDismissed = false;
      });
    }

    if (authorized || bypass) {
      if (mounted) {
        setState(() => _phase = _Phase.dashboard);
        if (updateAvailable && downloadUrl != null && downloadUrl.isNotEmpty) {
          WidgetsBinding.instance.addPostFrameCallback((_) => _maybeShowOta());
        }
      }
      return;
    }

    if (registered) {
      _pending = true;
    } else {
      _pending = false;
    }
    if (mounted) setState(() => _phase = _Phase.lock);
  }

  void _maybeShowOta() {
    if (!mounted || _otaDismissed || _otaUrl == null || _otaUrl!.isEmpty) return;
    final url = _otaUrl!;
    unawaited(
      showCarbonWmsOtaDialog(
        context: context,
        downloadUrl: url,
        latestVersion: _otaLatestVersion,
        onAnyClose: () {
          if (mounted) setState(() => _otaDismissed = true);
        },
        onInstallChosen: (u) async {
          if (!mounted) return;
          setState(() => _otaDismissed = true);
          try {
            await context.read<WmsApiClient>().downloadAndInstallApk(u);
          } catch (e) {
            if (!mounted) return;
            ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
          }
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    switch (_phase) {
      case _Phase.booting:
        return const Scaffold(
          body: Center(child: CircularProgressIndicator()),
        );
      case _Phase.login:
        return LoginScreen(
          key: ValueKey(_loginKey),
          onSuccess: () async {
            setState(() => _phase = _Phase.booting);
            await _evaluateSession();
          },
        );
      case _Phase.lock:
        return DeviceLockScreen(
          androidId: _androidId.isEmpty ? '(unavailable)' : _androidId,
          pendingApproval: _pending,
          onLogout: () async {
            await context.read<WmsApiClient>().setSessionToken(null);
            await LoginCredentialsStore.onUserLogout();
            if (mounted) {
              setState(() {
                _loginKey++;
                _phase = _Phase.login;
              });
            }
          },
        );
      case _Phase.dashboard:
        return DashboardScreen(
          otaDownloadUrl: _otaUrl,
          otaLatestVersion: _otaLatestVersion,
          onLogout: () async {
            await context.read<WmsApiClient>().setSessionToken(null);
            await LoginCredentialsStore.onUserLogout();
            if (mounted) {
              setState(() {
                _loginKey++;
                _phase = _Phase.login;
                _otaUrl = null;
              });
            }
          },
        );
    }
  }
}
