import 'package:flutter/material.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/handheld_device_identity.dart';
import 'package:carbon_wms/services/login_credentials_store.dart';
import 'package:carbon_wms/services/mobile_settings_repository.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Server URL, identity, OTA check, and biometric preferences.
class HandheldSettingsScreen extends StatefulWidget {
  const HandheldSettingsScreen({super.key});

  @override
  State<HandheldSettingsScreen> createState() => _HandheldSettingsScreenState();
}

class _HandheldSettingsScreenState extends State<HandheldSettingsScreen> {
  bool _busy = false;
  String? _lastStatus;
  bool _bioReloading = true;
  bool _bioEligible = false;
  bool _bioEnrolled = false;
  bool _offerAfterSignIn = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _reloadBiometricSection());
  }

  Future<void> _reloadBiometricSection() async {
    setState(() => _bioReloading = true);
    final eligible = await LoginCredentialsStore.canUseBiometricPasswordVault();
    final enrolled = await LoginCredentialsStore.hasVaultedCredentials();
    final offer = await LoginCredentialsStore.getOfferBiometricSetupAfterSignIn();
    if (!mounted) return;
    setState(() {
      _bioEligible = eligible;
      _bioEnrolled = enrolled;
      _offerAfterSignIn = offer;
      _bioReloading = false;
    });
  }

  /// On when vault is active, or user asked for post–sign-in setup offer.
  bool get _biometricSwitchValue => _bioEnrolled || _offerAfterSignIn;

  Future<void> _onBiometricSwitch(bool v) async {
    if (!v) {
      await LoginCredentialsStore.setBiometricLoginEnabled(false);
      await LoginCredentialsStore.setOfferBiometricSetupAfterSignIn(false);
      await LoginCredentialsStore.setBiometricEnrollmentPromptSkipped(false);
    } else {
      await LoginCredentialsStore.setOfferBiometricSetupAfterSignIn(true);
      if (await LoginCredentialsStore.hasVaultedCredentials()) {
        await LoginCredentialsStore.setBiometricLoginEnabled(true);
      }
    }
    if (mounted) await _reloadBiometricSection();
  }

  Future<void> _checkOta() async {
    if (!mounted) return;
    setState(() {
      _busy = true;
      _lastStatus = null;
    });
    try {
      final api = context.read<WmsApiClient>();
      final info = await PackageInfo.fromPlatform();
      final aid = await HandheldDeviceIdentity.primaryDeviceIdForServer();
      final st = await api.fetchMobileStatus(
        version: info.version,
        androidId: aid.isEmpty || aid == 'HANDHELD_OFFLINE' ? null : aid,
      );
      final authorized = st['authorized'] == true;
      final url = (st['downloadUrl'] as String?)?.trim();
      final latest = (st['latestVersion'] as String?)?.trim();
      final update = st['updateAvailable'] == true;
      if (!mounted) return;
      setState(() {
        _busy = false;
        _lastStatus = [
          'authorized: $authorized',
          if (latest != null && latest.isNotEmpty)
            'server label: $latest'
          else
            'server label: (none — no release row for this device\'s tenant; upload in WMS → Mobile OTA)',
          if (url != null && url.isNotEmpty) 'download: $url' else 'download: (none)',
          'update flag: $update',
        ].join('\n');
      });
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _lastStatus = 'Error: $e';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      title: 'Handheld settings',
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          FutureBuilder<PackageInfo>(
            future: PackageInfo.fromPlatform(),
            builder: (context, snap) {
              final p = snap.data;
              return ListTile(
                title: const Text('App version', style: TextStyle(color: AppColors.textMain, fontWeight: FontWeight.w600)),
                subtitle: Text(
                  p == null ? '…' : '${p.version} · build ${p.buildNumber}',
                  style: const TextStyle(color: AppColors.textMuted, fontFamily: 'monospace', fontSize: 12),
                ),
              );
            },
          ),
          FutureBuilder<String>(
            future: context.read<WmsApiClient>().resolveBaseUrl(),
            builder: (context, snap) {
              final u = snap.data ?? '';
              return ListTile(
                title: const Text('WMS server', style: TextStyle(color: AppColors.textMain, fontWeight: FontWeight.w600)),
                subtitle: SelectableText(
                  u.isEmpty ? '(not configured)' : u,
                  style: const TextStyle(
                    color: AppColors.textMuted,
                    fontFamily: 'monospace',
                    fontSize: 12,
                  ),
                ),
              );
            },
          ),
          const Divider(height: 32),
          FilledButton.icon(
            onPressed: _busy
                ? null
                : _lastStatus != null
                    ? () => setState(() => _lastStatus = null)
                    : _checkOta,
            icon: _busy
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.system_update_alt),
            label: Text(_busy ? 'Checking…' : 'Check OTA / authorization'),
            style: FilledButton.styleFrom(
              backgroundColor: AppColors.primary,
              foregroundColor: Colors.white,
            ),
          ),
          if (_lastStatus != null) ...[
            const SizedBox(height: 16),
            SelectableText(
              _lastStatus!,
              style: const TextStyle(
                color: AppColors.textMuted,
                fontFamily: 'monospace',
                fontSize: 11,
                height: 1.4,
              ),
            ),
          ],
          const SizedBox(height: 24),
          const Divider(height: 32),
          Consumer<MobileSettingsRepository>(
            builder: (ctx, settings, _) {
              final power = settings.config.transferOutAntennaPower;
              return Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'RFID Antenna Power',
                    style: TextStyle(color: AppColors.textMain, fontWeight: FontWeight.w700, fontSize: 13, letterSpacing: 0.5),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    '$power dBm',
                    style: const TextStyle(color: AppColors.primary, fontWeight: FontWeight.w800, fontSize: 20),
                  ),
                  Slider(
                    value: power.toDouble(),
                    min: 0,
                    max: 30,
                    divisions: 30,
                    activeColor: AppColors.primary,
                    label: '$power dBm',
                    onChanged: (v) => settings.setGlobalAntennaPower(v.round()),
                  ),
                  const Text(
                    'Applies to transfer-in and transfer-out scans.',
                    style: TextStyle(color: AppColors.textMuted, fontSize: 12, height: 1.4),
                  ),
                ],
              );
            },
          ),
          const SizedBox(height: 24),
          const Divider(height: 32),
          const Text(
            'Biometric sign-in',
            style: TextStyle(
              color: AppColors.textMain,
              fontWeight: FontWeight.w700,
              fontSize: 13,
              letterSpacing: 0.5,
            ),
          ),
          const SizedBox(height: 8),
          if (_bioReloading)
            const Padding(
              padding: EdgeInsets.all(12),
              child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
            )
          else if (!_bioEligible)
            const Text(
              'Not available on this device (rugged scanners do not use biometric sign-in here).',
              style: TextStyle(
                color: AppColors.textMuted,
                fontSize: 13,
                height: 1.35,
              ),
            )
          else ...[
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Fingerprint or face sign-in', style: TextStyle(color: AppColors.textMain, fontWeight: FontWeight.w600)),
              subtitle: Text(
                _bioEnrolled
                    ? 'Biometric sign-in is enabled. Logging out keeps fingerprint/face sign-in; turn off here to clear the saved session token.'
                    : _offerAfterSignIn
                        ? 'After your next password sign-in, you can confirm to enable fingerprint or face unlock.'
                        : 'Turn on to allow the optional setup prompt after you sign in with password.',
                style: const TextStyle(color: AppColors.textMuted, fontSize: 12, height: 1.35),
              ),
              value: _biometricSwitchValue,
              activeThumbColor: AppColors.primary,
              onChanged: _onBiometricSwitch,
            ),
          ],
        ],
      ),
    );
  }
}
