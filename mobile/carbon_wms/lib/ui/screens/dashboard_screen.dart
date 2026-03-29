import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/barcode_intake_screen.dart';
import 'package:carbon_wms/ui/screens/encode_suite_screens.dart';
import 'package:carbon_wms/ui/screens/geiger_screen.dart';
import 'package:carbon_wms/ui/screens/inventory_lookup_screen.dart';
import 'package:carbon_wms/ui/screens/status_change_screen.dart';
import 'package:carbon_wms/ui/screens/transfer_screen.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

class DashboardScreen extends StatelessWidget {
  const DashboardScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      actions: [
        PopupMenuButton<String>(
          tooltip: 'Scanner',
          onSelected: (value) {
            final m = context.read<RfidManager>();
            switch (value) {
              case 'chainway':
                m.useChainway();
                break;
              case 'zebra':
                m.useZebra();
                break;
              case 'none':
                m.clearScanner();
                break;
            }
          },
          itemBuilder: (context) => const [
            PopupMenuItem(value: 'chainway', child: Text('Use Chainway sled')),
            PopupMenuItem(value: 'zebra', child: Text('Use Zebra RFD8500')),
            PopupMenuItem(value: 'none', child: Text('Disconnect scanner')),
          ],
          child: const Padding(
            padding: EdgeInsets.symmetric(horizontal: 16),
            child: Icon(Icons.settings_input_antenna),
          ),
        ),
      ],
      body: CustomScrollView(
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
                  label: 'Geiger (Find)',
                  onTap: () => Navigator.of(context).push<void>(
                    MaterialPageRoute<void>(builder: (_) => const GeigerScreen()),
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
