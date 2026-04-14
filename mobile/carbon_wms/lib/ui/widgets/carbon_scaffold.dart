import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/theme_notifier.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/dashboard_screen.dart';
import 'package:carbon_wms/ui/screens/handheld_settings_screen.dart';

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

  final Color color;
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
              ..style = PaintingStyle.stroke
              ..strokeWidth = strokeWidth
              ..strokeJoin = StrokeJoin.round
              ..color = color,
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
/// Includes a side-menu drawer that stays on the current screen.
class CarbonScaffold extends StatefulWidget {
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
  State<CarbonScaffold> createState() => _CarbonScaffoldState();
}

class _CarbonScaffoldState extends State<CarbonScaffold> {
  final _scaffoldKey = GlobalKey<ScaffoldState>();
  String? _userEmail;

  @override
  void initState() {
    super.initState();
    _loadEmail();
  }

  Future<void> _loadEmail() async {
    final api = context.read<WmsApiClient>();
    final email = await api.getSavedLoginEmail();
    if (mounted) setState(() => _userEmail = email);
  }

  void _toggleDrawer() {
    final state = _scaffoldKey.currentState;
    if (state != null && state.isDrawerOpen) {
      Navigator.of(context).pop();
    } else {
      state?.openDrawer();
    }
  }

  Widget _buildDrawer() {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final rawName = (_userEmail?.split('@').first ?? '').replaceAll('.', ' ');
    final displayName = rawName.isEmpty
        ? 'Operator'
        : rawName
            .split(' ')
            .map(
                (w) => w.isEmpty ? w : '${w[0].toUpperCase()}${w.substring(1)}')
            .join(' ');
    final email = _userEmail ?? '—';

    return Drawer(
      backgroundColor: isDark ? const Color(0xFF1C2828) : Colors.white,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            width: double.infinity,
            color: AppColors.primary,
            padding: EdgeInsets.fromLTRB(
                24, MediaQuery.of(context).padding.top + 32, 24, 32),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                CircleAvatar(
                  radius: 52,
                  backgroundColor: Colors.white.withValues(alpha: 0.2),
                  child:
                      const Icon(Icons.person, size: 58, color: Colors.white),
                ),
                const SizedBox(height: 20),
                Text(
                  displayName,
                  style: GoogleFonts.manrope(
                      fontSize: 22,
                      fontWeight: FontWeight.w700,
                      color: Colors.white),
                  textAlign: TextAlign.center,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 6),
                Text(
                  email,
                  style: GoogleFonts.manrope(
                      fontSize: 14,
                      fontWeight: FontWeight.w500,
                      color: Colors.white.withValues(alpha: 0.8)),
                  textAlign: TextAlign.center,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
          const SizedBox(height: 20),
          _DrawerItem(
              icon: Icons.dashboard_outlined,
              label: 'Dashboard',
              onTap: () {
                Navigator.of(context).popUntil((r) => r.isFirst);
              }),
          const SizedBox(height: 4),
          _DrawerItem(
              icon: Icons.settings_outlined,
              label: 'Settings',
              onTap: () {
                Navigator.pop(context);
                Navigator.push(
                    context,
                    MaterialPageRoute<void>(
                        builder: (_) => const HandheldSettingsScreen()));
              }),
          const SizedBox(height: 4),
          Consumer<ThemeNotifier>(
            builder: (_, notifier, __) => _DrawerItem(
              icon: Icons.palette_outlined,
              label: 'Switch Theme',
              onTap: () => notifier.toggle(),
            ),
          ),
          const Spacer(),
          _DrawerItem(
              icon: Icons.power_settings_new,
              label: 'Sign Out',
              color: const Color(0xFFEF4444),
              large: true,
              onTap: () {
                Navigator.of(context).popUntil((r) => r.isFirst);
                DashboardScreen.scaffoldKey.currentState?.openDrawer();
                // Trigger logout from dashboard level
              }),
          const SizedBox(height: 80),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final barBg = isDark ? const Color(0xFF111A1A) : Colors.white;
    final mainColor = isDark ? const Color(0xFFE0ECEC) : AppColors.textMain;
    final wmsTeal = isDark ? const Color(0xFF4DB6AC) : AppColors.primary;

    final label = widget.pageTitle.isNotEmpty
        ? widget.pageTitle.toUpperCase()
        : (widget.title != null &&
                widget.title!.isNotEmpty &&
                widget.title != 'Carbon WMS')
            ? widget.title!.toUpperCase()
            : '';

    SystemChrome.setSystemUIOverlayStyle(
      const SystemUiOverlayStyle(
        statusBarColor: Colors.transparent,
        statusBarIconBrightness: Brightness.light,
        statusBarBrightness: Brightness.dark,
        systemNavigationBarColor: Color(0xFF2A2F2F),
        systemNavigationBarIconBrightness: Brightness.light,
        systemNavigationBarDividerColor: Color(0xFF2A2F2F),
        systemNavigationBarContrastEnforced: false,
      ),
    );

    return Scaffold(
      key: _scaffoldKey,
      drawerEnableOpenDragGesture: false,
      drawer: _buildDrawer(),
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
              onTap: _toggleDrawer,
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
                  style: GoogleFonts.spaceGrotesk(
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
                  style: const TextStyle(
                    fontSize: 22,
                    fontWeight: FontWeight.w700,
                    color: Colors.black,
                  ),
                ),
              ),
              Text(
                label,
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 16,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 0.6,
                  color: wmsTeal,
                ),
              ),
            ],
          ],
        ),
        actions: widget.actions,
      ),
      body: ColoredBox(
        color: isDark ? const Color(0xFF0D1515) : AppColors.background,
        child: widget.body,
      ),
      bottomNavigationBar: widget.bottomBar,
      floatingActionButton: widget.floatingActionButton,
    );
  }
}

class _DrawerItem extends StatelessWidget {
  const _DrawerItem({
    required this.icon,
    required this.label,
    required this.onTap,
    this.color,
    this.large = false,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final bool large;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final fg = color ?? (isDark ? const Color(0xFFE0ECEC) : AppColors.textMain);
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
        child: Row(
          children: [
            SizedBox(
                width: 26, child: Icon(icon, size: large ? 26 : 24, color: fg)),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: GoogleFonts.manrope(
                  fontSize: large ? 17 : 14,
                  fontWeight: large ? FontWeight.w800 : FontWeight.w700,
                  letterSpacing: -0.1,
                  color: fg,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
