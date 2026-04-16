import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';

import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart' show CarbonScaffold;

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
    return CarbonScaffold(
      pageTitle: 'DEVICE LOCK',
      body: SafeArea(
        child: Padding(
          padding: EdgeInsets.all(24.r),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('DEVICE LOCKED', style: AppTheme.headline(context)),
              SizedBox(height: 16.h),
              Text(
                pendingApproval
                    ? 'This phone is registered but not yet authorized. Ask an admin: Settings → Device binding (pending list), or find it under Infrastructure → Devices → Hand-held readers tab after approval.'
                    : 'This Android ID is not registered. Sign in once to register, then wait for admin approval (same places as above).',
                style: TextStyle(color: AppColors.textMuted, fontSize: 13.sp, height: 1.4.h),
              ),
              SizedBox(height: 24.h),
              SelectableText(
                androidId,
                style: TextStyle(
                  color: AppColors.textMuted,
                  fontFamily: 'monospace',
                  fontSize: 12.sp,
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
