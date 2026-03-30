import 'package:flutter/material.dart';

import 'package:carbon_wms/theme/app_theme.dart';

class DeviceLockScreen extends StatelessWidget {
  const DeviceLockScreen({
    super.key,
    required this.androidId,
    required this.pendingApproval,
    required this.onLogout,
  });

  final String androidId;
  final bool pendingApproval;
  final VoidCallback onLogout;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('DEVICE LOCKED', style: AppTheme.headline(context)),
              const SizedBox(height: 16),
              Text(
                pendingApproval
                    ? 'This phone is registered but not yet authorized. Ask an admin: Settings → Device binding (pending list), or find it under Infrastructure → Devices → Hand-held readers tab after approval.'
                    : 'This Android ID is not registered. Sign in once to register, then wait for admin approval (same places as above).',
                style: TextStyle(color: AppColors.textMuted, fontSize: 13, height: 1.4),
              ),
              const SizedBox(height: 24),
              SelectableText(
                androidId,
                style: const TextStyle(
                  color: Colors.white70,
                  fontFamily: 'monospace',
                  fontSize: 12,
                ),
              ),
              const Spacer(),
              OutlinedButton(onPressed: onLogout, child: const Text('Sign out')),
            ],
          ),
        ),
      ),
    );
  }
}
