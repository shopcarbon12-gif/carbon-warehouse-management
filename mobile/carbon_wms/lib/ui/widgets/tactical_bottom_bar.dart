import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:carbon_wms/theme/app_theme.dart';

// Height is now resolved at runtime via .h extension
double get _kTacticalButtonHeight => 80.h;

/// Thumb-reach control strip for floor workers — high contrast, 80px targets.
class TacticalBottomBar extends StatelessWidget {
  const TacticalBottomBar({
    super.key,
    required this.children,
  });

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: AppColors.surface,
      elevation: 12,
      child: SafeArea(
        top: false,
        minimum: EdgeInsets.fromLTRB(12.w, 8.h, 12.w, 12.h),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            for (var i = 0; i < children.length; i++) ...[
              if (i > 0) SizedBox(width: 10.w),
              Expanded(child: children[i]),
            ],
          ],
        ),
      ),
    );
  }
}

/// Primary emerald action (e.g. START SCAN).
class TacticalEmeraldButton extends StatelessWidget {
  const TacticalEmeraldButton({
    super.key,
    required this.label,
    this.onPressed,
    this.onLongPressStart,
    this.onLongPressEnd,
  });

  final String label;
  final VoidCallback? onPressed;
  final VoidCallback? onLongPressStart;
  final VoidCallback? onLongPressEnd;

  @override
  Widget build(BuildContext context) {
    return _TacticalButton(
      height: _kTacticalButtonHeight,
      background: AppColors.primary,
      foreground: Colors.white,
      label: label,
      onPressed: onPressed,
      onLongPressStart: onLongPressStart,
      onLongPressEnd: onLongPressEnd,
    );
  }
}

/// Secondary slate action (e.g. COMMIT).
class TacticalSlateButton extends StatelessWidget {
  const TacticalSlateButton({
    super.key,
    required this.label,
    this.onPressed,
  });

  final String label;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return _TacticalButton(
      height: _kTacticalButtonHeight,
      background: AppColors.slateActionDark,
      foreground: Colors.white,
      label: label,
      onPressed: onPressed,
    );
  }
}

/// Wraps an RFID-dependent widget: dims + blocks interaction when hardware is not linked.
class RfidLockedWrapper extends StatelessWidget {
  const RfidLockedWrapper({super.key, required this.hwLinked, required this.child});
  final bool hwLinked;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    if (hwLinked) return child;
    return Opacity(
      opacity: 0.35,
      child: IgnorePointer(child: child),
    );
  }
}

class _TacticalButton extends StatelessWidget {
  const _TacticalButton({
    required this.height,
    required this.background,
    required this.foreground,
    required this.label,
    this.onPressed,
    this.onLongPressStart,
    this.onLongPressEnd,
  });

  final double height;
  final Color background;
  final Color foreground;
  final String label;
  final VoidCallback? onPressed;
  final VoidCallback? onLongPressStart;
  final VoidCallback? onLongPressEnd;

  @override
  Widget build(BuildContext context) {
    final child = Center(
      child: Text(
        label,
        textAlign: TextAlign.center,
        style: TextStyle(
          color: foreground,
          fontWeight: FontWeight.w800,
          fontSize: 14.sp,
          letterSpacing: 1.1,
        ),
      ),
    );

    if (onLongPressStart != null || onLongPressEnd != null) {
      return SizedBox(
        height: height,
        child: Material(
          color: background,
          borderRadius: BorderRadius.circular(10.r),
          child: InkWell(
            borderRadius: BorderRadius.circular(10.r),
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onLongPressStart: (_) => onLongPressStart?.call(),
              onLongPressEnd: (_) => onLongPressEnd?.call(),
              child: child,
            ),
          ),
        ),
      );
    }

    final enabled = onPressed != null;
    return Opacity(
      opacity: enabled ? 1 : 0.45,
      child: SizedBox(
        height: height,
        child: Material(
          color: background,
          borderRadius: BorderRadius.circular(10.r),
          child: InkWell(
            borderRadius: BorderRadius.circular(10.r),
            onTap: enabled ? onPressed : null,
            child: child,
          ),
        ),
      ),
    );
  }
}
