import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/handheld_device_identity.dart';
import 'package:carbon_wms/services/mobile_settings_repository.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/barcode_intake_screen.dart';
import 'package:carbon_wms/ui/screens/encode_suite_screens.dart';
import 'package:carbon_wms/ui/screens/fast_putaway_screen.dart';
import 'package:carbon_wms/ui/screens/locate_tag_screen.dart';
import 'package:carbon_wms/ui/screens/inventory_csv_session_screen.dart';
import 'package:carbon_wms/ui/screens/inventory_lookup_screen.dart';
import 'package:carbon_wms/ui/screens/status_change_screen.dart';
import 'package:carbon_wms/ui/screens/transfer_screen.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

class DashboardScreen extends StatefulWidget {
  const DashboardScreen({super.key, this.onLogout, this.otaDownloadUrl});

  final Future<void> Function()? onLogout;
  final String? otaDownloadUrl;

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _syncMobileSettings());
  }

  Future<void> _syncMobileSettings() async {
    if (!mounted) return;
    final api = context.read<WmsApiClient>();
    final repo = context.read<MobileSettingsRepository>();
    final rfid = context.read<RfidManager>();
    final id = await HandheldDeviceIdentity.primaryDeviceIdForServer();
    await repo.syncFromServer(api, deviceId: id);
  }

  Future<void> _installOta(BuildContext context) async {
    final url = widget.otaDownloadUrl;
    if (url == null || url.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('No OTA URL — check server active release.')),
      );
      return;
    }
    try {
      await context.read<WmsApiClient>().downloadAndInstallApk(url);
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Installer started — approve prompts if shown.')),
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
      actions: [
        Consumer<MobileSettingsRepository>(
          builder: (context, settings, _) {
            final p = settings.config.transferOutAntennaPower
                .toDouble()
                .clamp(0.0, 300.0);
            return Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Tooltip(
                  message: 'RF power (0–300)',
                  child: Icon(Icons.settings_input_antenna, size: 20),
                ),
                SizedBox(
                  width: 130,
                  child: Slider(
                    value: p,
                    min: 0,
                    max: 300,
                    divisions: 30,
                    label: '${p.round()}',
                    onChanged: (v) async {
                      await settings.setGlobalAntennaPower(v.round());
                      if (context.mounted) {
                        await context.read<RfidManager>().reapplyHandheldHardwareSettings();
                      }
                    },
                  ),
                ),
                IconButton(
                  tooltip: 'Download & install update',
                  icon: const Icon(Icons.system_update_alt),
                  onPressed: () => _installOta(context),
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
      body: CustomScrollView(
        slivers: [
          SliverToBoxAdapter(
            child: FutureBuilder<String>(
              future: context.read<WmsApiClient>().resolveBaseUrl(),
              builder: (ctx, snap) {
                final u = snap.data ?? '';
                if (u.isEmpty) return const SizedBox.shrink();
                return Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
                  child: Text(
                    'Server · $u',
                    style: TextStyle(
                      fontSize: 11,
                      color: AppColors.textMuted,
                      fontFamily: 'monospace',
                    ),
                  ),
                );
              },
            ),
          ),
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
                childAspectRatio: 1.15,
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
                childAspectRatio: 1.15,
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
                  label: 'Transfer',
                  onTap: () => Navigator.of(context).push<void>(
                    MaterialPageRoute<void>(builder: (_) => const TransferScreen()),
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
                childAspectRatio: 1.15,
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
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
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
