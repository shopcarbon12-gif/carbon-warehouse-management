import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/handheld_device_identity.dart';
import 'package:carbon_wms/services/handheld_runtime_config.dart';
import 'package:carbon_wms/services/mobile_settings_repository.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/barcode_intake_screen.dart';
import 'package:carbon_wms/ui/screens/encode_suite_screens.dart';
import 'package:carbon_wms/ui/screens/fast_putaway_screen.dart';
import 'package:carbon_wms/ui/screens/handheld_settings_screen.dart';
import 'package:carbon_wms/ui/screens/locate_tag_screen.dart';
import 'package:carbon_wms/ui/screens/inventory_csv_session_screen.dart';
import 'package:carbon_wms/ui/screens/inventory_lookup_screen.dart';
import 'package:carbon_wms/ui/screens/status_change_screen.dart';
import 'package:carbon_wms/ui/screens/transfer_slips_screen.dart';
import 'package:carbon_wms/ui/screens/clean_bin_screen.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

class DashboardScreen extends StatefulWidget {
  const DashboardScreen({super.key, this.onLogout, this.otaDownloadUrl});

  final Future<void> Function()? onLogout;
  final String? otaDownloadUrl;

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  Timer? _otaPoll;
  String? _effectiveOtaUrl;
  bool _updateAvailable = false;

  @override
  void initState() {
    super.initState();
    _effectiveOtaUrl = widget.otaDownloadUrl;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      unawaited(_syncMobileSettings());
      unawaited(_refreshOtaHints(notifyUser: false));
      _otaPoll = Timer.periodic(const Duration(minutes: 3), (_) {
        unawaited(_refreshOtaHints(notifyUser: true));
      });
    });
  }

  @override
  void dispose() {
    _otaPoll?.cancel();
    super.dispose();
  }

  @override
  void didUpdateWidget(covariant DashboardScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.otaDownloadUrl != oldWidget.otaDownloadUrl) {
      _effectiveOtaUrl = widget.otaDownloadUrl;
    }
  }

  Future<void> _syncMobileSettings() async {
    if (!mounted) return;
    final api = context.read<WmsApiClient>();
    final repo = context.read<MobileSettingsRepository>();
    final id = await HandheldDeviceIdentity.primaryDeviceIdForServer();
    await repo.syncFromServer(api, deviceId: id);
  }

  Future<void> _refreshOtaHints({required bool notifyUser}) async {
    if (!mounted) return;
    try {
      final api = context.read<WmsApiClient>();
      final info = await PackageInfo.fromPlatform();
      final androidId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
      final st = await api.fetchMobileStatus(
        version: info.version,
        androidId: androidId.isEmpty || androidId == 'HANDHELD_OFFLINE' ? null : androidId,
      );
      final url = (st['downloadUrl'] as String?)?.trim();
      final upd = st['updateAvailable'] == true;
      if (!mounted) return;
      setState(() {
        _effectiveOtaUrl = (url != null && url.isNotEmpty) ? url : null;
        _updateAvailable = upd;
      });
      if (notifyUser && upd && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Update available — tap the download icon in the header.'),
          ),
        );
      }
    } catch (_) {
      /* keep last known OTA URL */
    }
  }

  String? get _otaForInstall {
    final u = _effectiveOtaUrl ?? widget.otaDownloadUrl;
    if (u == null || u.trim().isEmpty) return null;
    return u.trim();
  }

  Future<void> _installOta(BuildContext context) async {
    final url = _otaForInstall;
    if (url == null || url.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'No OTA URL — set an active release in WMS → Settings → Mobile OTA, '
            'and ensure this device is authorized.',
          ),
        ),
      );
      return;
    }
    try {
      await context.read<WmsApiClient>().downloadAndInstallApk(url);
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'Installer opened — approve the Android install prompt. After install, open Carbon WMS again (the app does not auto-restart).',
            ),
          ),
        );
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      title: 'Carbon WMS',
      actions: [
        IconButton(
          tooltip: 'Handheld settings',
          icon: const Icon(Icons.settings_outlined),
          onPressed: () => Navigator.of(context).push<void>(
            MaterialPageRoute<void>(builder: (_) => const HandheldSettingsScreen()),
          ),
        ),
        Consumer<MobileSettingsRepository>(
          builder: (context, settings, _) {
            final p = settings.config.transferOutAntennaPower
                .toDouble()
                .clamp(0.0, kAntennaPowerDbmMax.toDouble());
            return Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Tooltip(
                  message: 'RF power (0–30 dBm)',
                  child: Icon(Icons.settings_input_antenna, size: 20),
                ),
                SizedBox(
                  width: 130,
                  child: Slider(
                    value: p,
                    min: 0,
                    max: kAntennaPowerDbmMax.toDouble(),
                    divisions: kAntennaPowerDbmMax,
                    label: '${p.round()} dBm',
                    onChanged: (v) async {
                      await settings.setGlobalAntennaPower(v.round());
                      if (context.mounted) {
                        await context.read<RfidManager>().reapplyHandheldHardwareSettings();
                      }
                    },
                  ),
                ),
                Stack(
                  clipBehavior: Clip.none,
                  alignment: Alignment.center,
                  children: [
                    IconButton(
                      tooltip: 'Download & install update',
                      icon: const Icon(Icons.system_update_alt),
                      onPressed: () => _installOta(context),
                    ),
                    if (_updateAvailable)
                      Positioned(
                        right: 6,
                        top: 10,
                        child: Container(
                          width: 8,
                          height: 8,
                          decoration: BoxDecoration(
                            color: AppColors.success,
                            shape: BoxShape.circle,
                            border: Border.all(color: AppColors.background, width: 1),
                          ),
                        ),
                      ),
                  ],
                ),
                if (widget.onLogout != null)
                  IconButton(
                    tooltip: 'Sign out',
                    icon: const Icon(Icons.logout),
                    onPressed: () => widget.onLogout!(),
                  ),
              ],
            );
          },
        ),
      ],
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(
            child: CustomScrollView(
              slivers: [
                SliverPadding(
                  padding: const EdgeInsets.fromLTRB(16, 20, 16, 8),
                  sliver: SliverToBoxAdapter(
                    child: Text('MODULES', style: AppTheme.headline(context)),
                  ),
                ),
                SliverPadding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  sliver: SliverToBoxAdapter(
                    child: Text(
                      'Inventory',
                      style: Theme.of(context).textTheme.titleMedium?.copyWith(
                            color: AppColors.textMuted,
                            fontWeight: FontWeight.w700,
                          ),
                    ),
                  ),
                ),
                SliverPadding(
                  padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
                  sliver: SliverGrid(
                    gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                      crossAxisCount: 2,
                      mainAxisSpacing: 12,
                      crossAxisSpacing: 12,
                      childAspectRatio: 1.05,
                    ),
                    delegate: SliverChildListDelegate([
                      _DashCard(
                        icon: LucideIcons.search,
                        label: 'Item Lookup',
                        onTap: () => Navigator.of(context).push<void>(
                          MaterialPageRoute<void>(builder: (_) => const InventoryLookupScreen()),
                        ),
                      ),
                      _DashCard(
                        icon: LucideIcons.inbox,
                        label: 'Non-RFID Intake',
                        onTap: () => Navigator.of(context).push<void>(
                          MaterialPageRoute<void>(builder: (_) => const BarcodeIntakeScreen()),
                        ),
                      ),
                      _DashCard(
                        icon: LucideIcons.layers,
                        label: 'Fast bin putaway',
                        onTap: () => Navigator.of(context).push<void>(
                          MaterialPageRoute<void>(builder: (_) => const FastPutawayScreen()),
                        ),
                      ),
                      _DashCard(
                        icon: LucideIcons.trash2,
                        label: 'Clean bin',
                        onTap: () => Navigator.of(context).push<void>(
                          MaterialPageRoute<void>(builder: (_) => const CleanBinScreen()),
                        ),
                      ),
                      _DashCard(
                        icon: LucideIcons.fileUp,
                        label: 'CSV cycle session',
                        onTap: () => Navigator.of(context).push<void>(
                          MaterialPageRoute<void>(builder: (_) => const InventoryCsvSessionScreen()),
                        ),
                      ),
                    ]),
                  ),
                ),
                SliverPadding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  sliver: SliverToBoxAdapter(
                    child: Text(
                      'Operations',
                      style: Theme.of(context).textTheme.titleMedium?.copyWith(
                            color: AppColors.textMuted,
                            fontWeight: FontWeight.w700,
                          ),
                    ),
                  ),
                ),
                SliverPadding(
                  padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
                  sliver: SliverGrid(
                    gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                      crossAxisCount: 2,
                      mainAxisSpacing: 12,
                      crossAxisSpacing: 12,
                      childAspectRatio: 1.05,
                    ),
                    delegate: SliverChildListDelegate([
                      _DashCard(
                        icon: LucideIcons.radio,
                        label: 'Locate tag (Geiger)',
                        onTap: () => Navigator.of(context).push<void>(
                          MaterialPageRoute<void>(builder: (_) => const LocateTagScreen()),
                        ),
                      ),
                      _DashCard(
                        icon: LucideIcons.arrowLeftRight,
                        label: 'Transfer slips',
                        onTap: () => Navigator.of(context).push<void>(
                          MaterialPageRoute<void>(builder: (_) => const TransferSlipsScreen()),
                        ),
                      ),
                      _DashCard(
                        icon: LucideIcons.clipboardList,
                        label: 'Change Status',
                        onTap: () => Navigator.of(context).push<void>(
                          MaterialPageRoute<void>(builder: (_) => const StatusChangeScreen()),
                        ),
                      ),
                    ]),
                  ),
                ),
                SliverPadding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  sliver: SliverToBoxAdapter(
                    child: Text(
                      'Encode',
                      style: Theme.of(context).textTheme.titleMedium?.copyWith(
                            color: AppColors.textMuted,
                            fontWeight: FontWeight.w700,
                          ),
                    ),
                  ),
                ),
                SliverPadding(
                  padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
                  sliver: SliverGrid(
                    gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                      crossAxisCount: 2,
                      mainAxisSpacing: 12,
                      crossAxisSpacing: 12,
                      childAspectRatio: 1.05,
                    ),
                    delegate: SliverChildListDelegate([
                      _DashCard(
                        icon: LucideIcons.scanLine,
                        label: 'Search & Encode',
                        onTap: () => Navigator.of(context).push<void>(
                          MaterialPageRoute<void>(
                            builder: (_) => const EncodeSuiteScreen(initialTab: 0),
                          ),
                        ),
                      ),
                      _DashCard(
                        icon: LucideIcons.printer,
                        label: 'Scan & Print',
                        onTap: () => Navigator.of(context).push<void>(
                          MaterialPageRoute<void>(
                            builder: (_) => const EncodeSuiteScreen(initialTab: 1),
                          ),
                        ),
                      ),
                      _DashCard(
                        icon: LucideIcons.upload,
                        label: 'Upload',
                        onTap: () => Navigator.of(context).push<void>(
                          MaterialPageRoute<void>(
                            builder: (_) => const EncodeSuiteScreen(initialTab: 2),
                          ),
                        ),
                      ),
                    ]),
                  ),
                ),
              ],
            ),
          ),
          if (_otaForInstall == null)
            Material(
              color: AppColors.surface,
              elevation: 6,
              child: SafeArea(
                top: false,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 10, 16, 12),
                  child: Row(
                    children: [
                      const Icon(Icons.warning_amber_rounded, color: AppColors.textMuted, size: 20),
                      const SizedBox(width: 10),
                      const Expanded(
                        child: Text(
                          'No OTA URL — upload an active APK in WMS (Settings → Mobile OTA) '
                          'and authorize this device.',
                          style: TextStyle(color: AppColors.textMuted, fontSize: 12, height: 1.35),
                        ),
                      ),
                      TextButton(
                        onPressed: () => unawaited(_refreshOtaHints(notifyUser: false)),
                        child: const Text('Retry'),
                      ),
                    ],
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _DashCard extends StatelessWidget {
  const _DashCard({
    required this.icon,
    required this.label,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: AppColors.surface,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(icon, size: 36, color: AppColors.primary),
              const Spacer(),
              Text(
                label.toUpperCase(),
                style: AppTheme.headline(context).copyWith(
                  color: AppColors.textMain,
                  fontSize: 12,
                  letterSpacing: 1.1,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
