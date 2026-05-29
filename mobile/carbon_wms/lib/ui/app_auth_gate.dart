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
import 'package:carbon_wms/services/mobile_permissions.dart';
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

class _AppAuthGateState extends State<AppAuthGate> {
  _Phase _phase = _Phase.booting;
  String _androidId = '';
  bool _pending = false;
  String? _otaUrl;
  String? _otaLatestVersion;
  bool _otaDismissed = false;
  int _loginKey = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _boot();
    });
  }

  // Note: no AppLifecycleState.detached handler. The previous version cleared
  // the session token on .detached as "belt-and-suspenders" for the swipe-
  // away-from-recents logout. On rugged kiosks (Chainway C72E) this was
  // harmless because the OS rarely transitions through .detached during
  // normal use. On consumer Android (Samsung S938U, Motorola Edge), .detached
  // can fire during transient lifecycle events — biometric system UI,
  // notification drawer, low-memory activity-restart, configuration changes —
  // and the token clear would race the dashboard's first API call, surfacing
  // as "Dashboard: http 401 — try Refresh / re-sign-in" right after a
  // successful login. The Kotlin `TaskRemovedSessionService.onTaskRemoved`
  // (registered with stopWithTask=false in AndroidManifest) AND
  // `MainActivity.onDestroy(isFinishing && !isChangingConfigurations)`
  // already cover the actual "user killed the app" cases, with synchronous
  // `commit()` so the token is gone before the process exits.

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
      status = await api.fetchMobileStatus(version: version, androidId: _androidId.isEmpty ? null : _androidId)
          .timeout(const Duration(seconds: 8));
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
    final downloadUrl = status['downloadUrl'] as String?;
    final latestRaw = status['latestVersion'];
    final latestLabel = latestRaw is String ? latestRaw.trim() : '';
    // Only show OTA dialog if server version is strictly newer than installed.
    final serverNewer = latestLabel.isNotEmpty && _isVersionNewer(latestLabel, version);
    final updateAvailable = status['updateAvailable'] == true && serverNewer;

    if (mounted) {
      setState(() {
        _otaUrl = downloadUrl;
        _otaLatestVersion = latestLabel.isNotEmpty ? latestLabel : null;
        _otaDismissed = false;
      });
    }

    if (authorized || bypass) {
      // 1.2.79: `/api/mobile/status` is in proxy.ts public-allowlist and can
      // answer authorized:true by `androidId` alone (no Bearer required) when
      // the device row is pre-authorized in WMS → Settings → Devices. That's
      // intentional — it's the device gate, not the session gate. But it
      // means we can reach this branch with a missing or expired JWT, in
      // which case every session-gated Dashboard call below will 401. So
      // re-check the token here; if it's gone (getSessionToken wipes
      // expired tokens), force the operator back through login.
      final tokenAfter = await api.getSessionToken();
      if (tokenAfter == null || tokenAfter.isEmpty) {
        if (mounted) {
          setState(() {
            _loginKey++;
            _phase = _Phase.login;
          });
        }
        return;
      }
      // Pull the operator's mobile-role permissions before painting the
      // dashboard. Best-effort: a failed fetch leaves [MobilePermissions]
      // in whichever state it already had (cached value from prior
      // session, or fail-open empty if none). Service swallows the
      // exception internally and stores `lastError` for the drawer.
      if (mounted) {
        unawaited(context.read<MobilePermissions>().refresh(api));
      }
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

  bool _isVersionNewer(String server, String installed) {
    List<int> parse(String v) =>
        v.split('.').map((p) => int.tryParse(p) ?? 0).toList();
    final s = parse(server);
    final i = parse(installed);
    final len = s.length > i.length ? s.length : i.length;
    for (var x = 0; x < len; x++) {
      final sv = x < s.length ? s[x] : 0;
      final iv = x < i.length ? i[x] : 0;
      if (sv > iv) return true;
      if (sv < iv) return false;
    }
    return false;
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
            // Read providers up-front so the awaits below don't cross the
            // BuildContext.
            final api = context.read<WmsApiClient>();
            final perms = context.read<MobilePermissions>();
            await api.setSessionToken(null);
            await LoginCredentialsStore.onUserLogout();
            await perms.clear();
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
            final api = context.read<WmsApiClient>();
            final perms = context.read<MobilePermissions>();
            await api.setSessionToken(null);
            await LoginCredentialsStore.onUserLogout();
            await perms.clear();
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
