import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/services/mobile_permissions.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Centralised navigation guard for the Phase 2 mobile-RBAC matrix.
///
/// Every hub/menu tile is supposed to filter itself via
/// `MobilePermissions.canView(...)`. This guard catches anything that
/// slips through (deep links, scan shortcuts, programmatic pushes from
/// background work) — wrap the page in [PermissionGuard] inside a
/// `MaterialPageRoute.builder` and the operator sees a clean "no access"
/// screen instead of the page they shouldn't see.
///
/// Prefer the [PermissionAwareNavigation.pushGuarded] extension below for
/// new call sites — it does the canView check before the route is even
/// pushed (cheaper than rendering then bouncing).
class PermissionGuard extends StatelessWidget {
  const PermissionGuard({
    super.key,
    required this.screenId,
    required this.child,
  });

  /// Screen id this route belongs to. Must match a value from [ScreenIds].
  final String screenId;

  /// The real page to render when the operator has access.
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final perms = context.watch<MobilePermissions>();
    if (perms.canView(screenId)) return child;
    return _NoAccessScaffold(screenId: screenId, role: perms.role);
  }
}

class _NoAccessScaffold extends StatelessWidget {
  const _NoAccessScaffold({required this.screenId, required this.role});

  final String screenId;
  final String? role;

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      pageTitle: 'no access',
      body: Center(
        child: Padding(
          padding: EdgeInsets.all(24.r),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.lock_outline,
                  size: 48.sp, color: const Color(0xFF8A9090)),
              SizedBox(height: 12.h),
              Text(
                "YOU DON'T HAVE ACCESS",
                textAlign: TextAlign.center,
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 14.sp,
                  fontWeight: FontWeight.w900,
                  letterSpacing: 1.8,
                  color: AppColors.textMain,
                ),
              ),
              SizedBox(height: 8.h),
              Text(
                (role ?? '').isEmpty
                    ? 'This screen is restricted for your mobile role.'
                    : 'Your role "$role" cannot open this screen.',
                textAlign: TextAlign.center,
                style: GoogleFonts.manrope(
                  fontSize: 13.sp,
                  fontWeight: FontWeight.w600,
                  color: const Color(0xFF6D7979),
                  height: 1.4,
                ),
              ),
              SizedBox(height: 4.h),
              Text(
                'Ask an admin to update WMS → Settings → Users → WMS Mobile.',
                textAlign: TextAlign.center,
                style: GoogleFonts.manrope(
                  fontSize: 11.sp,
                  color: const Color(0xFF8A9090),
                  height: 1.4,
                ),
              ),
              SizedBox(height: 18.h),
              FilledButton(
                onPressed: () => Navigator.of(context).maybePop(),
                style: FilledButton.styleFrom(
                  backgroundColor: AppColors.primary,
                  foregroundColor: Colors.white,
                ),
                child: const Text('Back'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Convenience for call sites that already have a [BuildContext] and a
/// destination screen builder: skip the push entirely when the user
/// can't view it, surface a one-shot snackbar, and avoid the cost of
/// instantiating the page state just to bounce back.
extension PermissionAwareNavigation on BuildContext {
  /// Push [builder] only when the operator can view [screenId]. Returns
  /// the route result, or `null` when the push was blocked.
  Future<T?> pushGuarded<T extends Object?>(
    String screenId,
    WidgetBuilder builder,
  ) {
    final perms = read<MobilePermissions>();
    if (!perms.canView(screenId)) {
      ScaffoldMessenger.maybeOf(this)?.showSnackBar(
        SnackBar(
          content: Text(
            (perms.role ?? '').isEmpty
                ? "You don't have access to this screen."
                : "Your role \"${perms.role}\" can't open this screen.",
          ),
          behavior: SnackBarBehavior.floating,
          duration: const Duration(seconds: 2),
        ),
      );
      return Future<T?>.value(null);
    }
    return Navigator.of(this).push<T>(
      MaterialPageRoute<T>(
        builder: (ctx) => PermissionGuard(screenId: screenId, child: builder(ctx)),
      ),
    );
  }
}
