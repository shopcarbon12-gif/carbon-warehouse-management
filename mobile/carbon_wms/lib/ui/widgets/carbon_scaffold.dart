import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:carbon_wms/theme/app_theme.dart';

/// Persistent shell with branded AppBar: logo + "CarbonWMS / PAGE" layout.
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
    final canPop = Navigator.canPop(context);
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final barBg = isDark ? const Color(0xFF111A1A) : Colors.white;
    final mainColor = isDark ? const Color(0xFFE0ECEC) : AppColors.textMain;
    final mutedColor = isDark ? const Color(0xFF7A9090) : AppColors.textMuted;

    // Resolve page label from pageTitle or legacy title
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
        leadingWidth: 48,
        leading: canPop
            ? IconButton(
                icon: Icon(Icons.arrow_back, color: mainColor),
                onPressed: () => Navigator.of(context).maybePop(),
              )
            : const SizedBox.shrink(),
        titleSpacing: canPop ? 0 : 12,
        title: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            ClipOval(
              child: Image.asset(
                'assets/carbon_logo.png',
                width: 28,
                height: 28,
                fit: BoxFit.cover,
              ),
            ),
            const SizedBox(width: 7),
            Text(
              'CarbonWMS',
              style: GoogleFonts.manrope(
                fontSize: 14,
                fontWeight: FontWeight.w800,
                letterSpacing: -0.2,
                color: mainColor,
              ),
            ),
            if (label.isNotEmpty) ...[
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 6),
                child: Text(
                  '/',
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w400,
                    color: mutedColor,
                  ),
                ),
              ),
              Text(
                label,
                style: GoogleFonts.manrope(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  letterSpacing: 0.6,
                  color: mutedColor,
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
