import 'package:flutter/material.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/handheld_device_identity.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Server URL, identity, and manual OTA check (reference: persistent settings entry).
class HandheldSettingsScreen extends StatefulWidget {
  const HandheldSettingsScreen({super.key});

  @override
  State<HandheldSettingsScreen> createState() => _HandheldSettingsScreenState();
}

class _HandheldSettingsScreenState extends State<HandheldSettingsScreen> {
  bool _busy = false;
  String? _lastStatus;

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
          if (latest != null && latest.isNotEmpty) 'server label: $latest',
          if (url != null && url.isNotEmpty) 'download: $url' else 'download: (none — upload APK in WMS → Mobile OTA)',
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
                title: const Text('App version'),
                subtitle: Text(
                  p == null ? '…' : '${p.version} · build ${p.buildNumber}',
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
                ),
              );
            },
          ),
          FutureBuilder<String>(
            future: context.read<WmsApiClient>().resolveBaseUrl(),
            builder: (context, snap) {
              final u = snap.data ?? '';
              return ListTile(
                title: const Text('WMS server'),
                subtitle: SelectableText(
                  u.isEmpty ? '(not configured)' : u,
                  style: TextStyle(
                    color: AppColors.textMuted,
                    fontFamily: 'monospace',
                    fontSize: 12,
                  ),
                ),
              );
            },
          ),
          FutureBuilder<String>(
            future: HandheldDeviceIdentity.primaryDeviceIdForServer(),
            builder: (context, snap) {
              final id = snap.data ?? '';
              final short = id.length > 12 ? '${id.substring(0, 8)}…' : id;
              return ListTile(
                title: const Text('Device ID (Android)'),
                subtitle: Text(
                  id.isEmpty ? '—' : short,
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
                ),
              );
            },
          ),
          const SizedBox(height: 12),
          FilledButton.icon(
            onPressed: _busy ? null : _checkOta,
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
              foregroundColor: AppColors.background,
            ),
          ),
          if (_lastStatus != null) ...[
            const SizedBox(height: 16),
            SelectableText(
              _lastStatus!,
              style: TextStyle(
                color: AppColors.textMuted,
                fontFamily: 'monospace',
                fontSize: 11,
                height: 1.4,
              ),
            ),
          ],
        ],
      ),
    );
  }
}
