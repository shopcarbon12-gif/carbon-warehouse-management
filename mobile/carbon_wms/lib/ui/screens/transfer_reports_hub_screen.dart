import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:lucide_icons/lucide_icons.dart';

import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/transfer_in_pending_screen.dart';
import 'package:carbon_wms/ui/screens/transfer_out_reports_screen.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Transfer Reports hub. Two destinations — IN and OUT — but the layout
/// breaks the InventoryHub grid pattern on purpose: tall horizontal lanes
/// with directional arrows so the operator reads "stuff coming IN" vs
/// "stuff going OUT" before they even read the labels. The IN lane uses
/// a success-green accent, the OUT lane uses primary teal.
class TransferReportsHubScreen extends StatelessWidget {
  const TransferReportsHubScreen({super.key});

  static const Color _inAccent = Color(0xFF1B7F4F);
  static const Color _outAccent = AppColors.primary;

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      pageTitle: 'transfers',
      body: ColoredBox(
        color: Colors.white,
        child: Padding(
          padding: EdgeInsets.fromLTRB(20.w, 16.h, 20.w, 20.h),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                'CHOOSE DIRECTION',
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 11.sp,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 1.6,
                  color: const Color(0xFF6D7979),
                ),
              ),
              SizedBox(height: 12.h),
              Expanded(
                child: Column(
                  children: [
                    Expanded(
                      child: _DirectionLane(
                        label: 'TRANSFER IN',
                        sublabel: 'INCOMING SHIPMENTS',
                        accent: _inAccent,
                        leadingIcon: LucideIcons.arrowDownToLine,
                        trailingIcon: LucideIcons.packageOpen,
                        direction: _LaneDirection.inbound,
                        onTap: () => Navigator.of(context).push<void>(
                          MaterialPageRoute<void>(
                            builder: (_) => const TransferInPendingScreen(),
                          ),
                        ),
                      ),
                    ),
                    SizedBox(height: 12.h),
                    Expanded(
                      child: _DirectionLane(
                        label: 'TRANSFER OUT',
                        sublabel: 'OUTGOING SHIPMENTS',
                        accent: _outAccent,
                        leadingIcon: LucideIcons.arrowUpFromLine,
                        trailingIcon: LucideIcons.package,
                        direction: _LaneDirection.outbound,
                        onTap: () => Navigator.of(context).push<void>(
                          MaterialPageRoute<void>(
                            builder: (_) => const TransferOutReportsScreen(),
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

enum _LaneDirection { inbound, outbound }

/// Horizontal lane with a flowing arrow track that reads as "items moving
/// in this direction". Three chevrons pulse along the track when tapped —
/// gives the lane an alive feel without animation overhead at idle.
class _DirectionLane extends StatelessWidget {
  const _DirectionLane({
    required this.label,
    required this.sublabel,
    required this.accent,
    required this.leadingIcon,
    required this.trailingIcon,
    required this.direction,
    required this.onTap,
  });

  final String label;
  final String sublabel;
  final Color accent;
  final IconData leadingIcon;
  final IconData trailingIcon;
  final _LaneDirection direction;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final inbound = direction == _LaneDirection.inbound;
    return Material(
      color: const Color(0xFFF5F8F8),
      borderRadius: BorderRadius.zero,
      child: InkWell(
        onTap: onTap,
        child: Stack(
          children: [
            // Accent stripe — left edge for IN, right edge for OUT.
            Positioned(
              top: 0,
              bottom: 0,
              left: inbound ? 0 : null,
              right: inbound ? null : 0,
              child: Container(width: 6, color: accent),
            ),
            Padding(
              padding: EdgeInsets.fromLTRB(20.w, 14.h, 20.w, 14.h),
              child: Row(
                children: [
                  _LaneIconBadge(
                    icon: inbound ? leadingIcon : trailingIcon,
                    accent: accent,
                  ),
                  SizedBox(width: 14.w),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Text(
                          label,
                          style: GoogleFonts.spaceGrotesk(
                            fontSize: 18.sp,
                            fontWeight: FontWeight.w800,
                            letterSpacing: 1.6,
                            color: AppColors.textMain,
                            height: 1.1,
                          ),
                        ),
                        SizedBox(height: 4.h),
                        Text(
                          sublabel,
                          style: GoogleFonts.spaceGrotesk(
                            fontSize: 10.sp,
                            fontWeight: FontWeight.w700,
                            letterSpacing: 1.4,
                            color: const Color(0xFF6D7979),
                          ),
                        ),
                        SizedBox(height: 8.h),
                        _ChevronTrack(accent: accent, inbound: inbound),
                      ],
                    ),
                  ),
                  SizedBox(width: 10.w),
                  Icon(
                    inbound ? trailingIcon : leadingIcon,
                    size: 22.sp,
                    color: accent.withValues(alpha: 0.85),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _LaneIconBadge extends StatelessWidget {
  const _LaneIconBadge({required this.icon, required this.accent});
  final IconData icon;
  final Color accent;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 56.w,
      height: 56.w,
      decoration: BoxDecoration(
        color: accent.withValues(alpha: 0.10),
        shape: BoxShape.rectangle,
      ),
      child: Center(
        child: Icon(icon, size: 28.sp, color: accent),
      ),
    );
  }
}

/// Three chevrons spaced along a thin horizontal rail, getting more opaque
/// in the direction of travel — visual shorthand for the flow.
class _ChevronTrack extends StatelessWidget {
  const _ChevronTrack({required this.accent, required this.inbound});
  final Color accent;
  final bool inbound;

  @override
  Widget build(BuildContext context) {
    final chevrons = inbound
        ? const [0.30, 0.55, 0.85]
        : const [0.85, 0.55, 0.30];
    final ic = inbound ? LucideIcons.chevronLeft : LucideIcons.chevronRight;
    return SizedBox(
      height: 14.h,
      child: Row(
        mainAxisAlignment: MainAxisAlignment.start,
        children: [
          for (final a in chevrons)
            Padding(
              padding: EdgeInsets.only(right: 2.w),
              child: Icon(ic, size: 14.sp, color: accent.withValues(alpha: a)),
            ),
        ],
      ),
    );
  }
}
