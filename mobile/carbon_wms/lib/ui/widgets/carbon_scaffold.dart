import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/dashboard_screen.dart';

/// Renders "WMS" with a visible stroke so it looks physically thicker
/// without increasing the font size.  Uses a [Stack] of two [Text] widgets:
/// the bottom one draws the stroke, the top one fills — because Flutter's
/// [TextStyle.foreground] does not support stroke+fill simultaneously.
class WmsText extends StatelessWidget {
  const WmsText({
    super.key,
    required this.color,
    required this.fontSize,
    this.strokeWidth = 1.2,
  });

  final Color  color;
  final double fontSize;
  final double strokeWidth;

  TextStyle _base() => GoogleFonts.manrope(
        fontSize: fontSize,
        fontWeight: FontWeight.w900,
        letterSpacing: 0.2,
      );

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        // Stroke layer — draws thick outline around each glyph
        Text(
          'WMS',
          style: _base().copyWith(
            foreground: Paint()
              ..style       = PaintingStyle.stroke
              ..strokeWidth = strokeWidth
              ..strokeJoin  = StrokeJoin.round
              ..color       = color,
          ),
        ),
        // Fill layer — solid colour on top
        Text(
          'WMS',
          style: _base().copyWith(color: color),
        ),
      ],
    );
  }
}

/// Persistent shell with branded AppBar: logo + "Carbon**WMS** / PAGE" layout.
/// "Carbon" is in mainColor; "WMS" is always in teal (AppColors.primary).
class CarbonScaffold extends StatelessWidget {
  const CarbonScaffold({
    super.key,
    required this.body,
    this.pageTitle = '',
    // Legacy alias kept for call-sites that still pass `title:`.
    this.title,
    this.bottomBar,
    this.floatingActionButton,
    this.actions,
  });

  final Widget body;

  /// Short page name shown after "CarbonWMS /", e.g. 'INVENTORY'.
  final String pageTitle;

  /// Deprecated — use [pageTitle]. If supplied and [pageTitle] is empty, used as fallback.
  final String? title;

  final Widget? bottomBar;
  final Widget? floatingActionButton;
  final List<Widget>? actions;

  @override
  Widget build(BuildContext context) {
    final isDark     = Theme.of(context).brightness == Brightness.dark;
    final barBg      = isDark ? const Color(0xFF111A1A) : Colors.white;
    final mainColor  = isDark ? const Color(0xFFE0ECEC) : AppColors.textMain;
    // In dark mode the primary teal is brighter; keep it readable on both.
    final wmsTeal    = isDark ? const Color(0xFF4DB6AC) : AppColors.primary;

    final label = pageTitle.isNotEmpty
        ? pageTitle.toUpperCase()
        : (title != null && title!.isNotEmpty && title != 'Carbon WMS')
            ? title!.toUpperCase()
            : '';

    return Scaffold(
      appBar: AppBar(
        backgroundColor: barBg,
        elevation: 0,
        surfaceTintColor: Colors.transparent,
        automaticallyImplyLeading: false,
        titleSpacing: 12,
        title: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            GestureDetector(
              onTap: () {
                Navigator.of(context).popUntil((r) => r.isFirst);
                DashboardScreen.scaffoldKey.currentState?.openDrawer();
              },
              child: ClipOval(
                child: Image.asset(
                  'assets/carbon_logo.png',
                  width: 36,
                  height: 36,
                  fit: BoxFit.cover,
                ),
              ),
            ),
            const SizedBox(width: 8),
            Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                Text(
                  'Carbon',
                  style: GoogleFonts.manrope(
                    fontSize: 18,
                    fontWeight: FontWeight.w800,
                    letterSpacing: -0.3,
                    color: mainColor,
                  ),
                ),
                WmsText(color: wmsTeal, fontSize: 18),
              ],
            ),
            if (label.isNotEmpty) ...[
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 7),
                child: Text(
                  '/',
                  style: TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w400,
                    color: mainColor,
                  ),
                ),
              ),
              Text(
                label,
                style: GoogleFonts.manrope(
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 0.6,
                  color: wmsTeal,
                ),
              ),
            ],
          ],
        ),
        actions: actions,
      ),
      body: ColoredBox(
        color: isDark ? const Color(0xFF0D1515) : AppColors.background,
        child: body,
      ),
      bottomNavigationBar: bottomBar,
      floatingActionButton: floatingActionButton,
    );
  }
}
