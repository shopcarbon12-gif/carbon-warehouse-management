import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/services/handheld_device_identity.dart';
import 'package:carbon_wms/services/mobile_settings_repository.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/handheld_settings_screen.dart';
import 'package:carbon_wms/ui/widgets/carbon_app_drawer.dart';

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
        fontSize: fontSize.sp,
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
    this.onLogout,
    this.onRefreshFromDrawer,
    this.resizeToAvoidBottomInset = true,
  });

  final Widget body;

  /// Short page name shown after "CarbonWMS /", e.g. 'INVENTORY'.
  final String pageTitle;

  /// Deprecated — use [pageTitle]. If supplied and [pageTitle] is empty, used as fallback.
  final String? title;

  final Widget? bottomBar;
  final Widget? floatingActionButton;
  final List<Widget>? actions;
  final VoidCallback? onLogout;
  final Future<void> Function()? onRefreshFromDrawer;
  final bool resizeToAvoidBottomInset;

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

  Future<void> _refreshSettingsPermissions() async {
    final messenger = ScaffoldMessenger.of(context);
    messenger.showSnackBar(
      const SnackBar(
        content: Text('Syncing settings...'),
        duration: Duration(seconds: 1),
      ),
    );
    final api = context.read<WmsApiClient>();
    final repo = context.read<MobileSettingsRepository>();
    final id = await HandheldDeviceIdentity.primaryDeviceIdForServer();
    await repo.syncFromServer(api, deviceId: id);
    if (!mounted) return;
    messenger.showSnackBar(
      const SnackBar(
        content: Text('Settings refreshed.'),
        duration: Duration(seconds: 2),
      ),
    );
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
    return CarbonAppDrawer(
      userEmail: _userEmail,
      onSettings: () {
        Navigator.pop(context);
        Navigator.push(
          context,
          MaterialPageRoute<void>(
            builder: (_) => const HandheldSettingsScreen(),
          ),
        );
      },
      onRefresh: () async {
        Navigator.pop(context);
        if (widget.onRefreshFromDrawer != null) {
          await widget.onRefreshFromDrawer!();
          return;
        }
        await _refreshSettingsPermissions();
      },
      onLogout: widget.onLogout,
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
      resizeToAvoidBottomInset: widget.resizeToAvoidBottomInset,
      appBar: AppBar(
        backgroundColor: barBg,
        elevation: 0,
        surfaceTintColor: Colors.transparent,
        automaticallyImplyLeading: false,
        titleSpacing: 12.w,
        title: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            GestureDetector(
              onTap: _toggleDrawer,
              child: ClipOval(
                child: Image.asset(
                  'assets/carbon_logo.png',
                  width: 36.w,
                  height: 36.w,
                  fit: BoxFit.cover,
                ),
              ),
            ),
            SizedBox(width: 8.w),
            Expanded(
              child: FittedBox(
                fit: BoxFit.scaleDown,
                alignment: Alignment.centerLeft,
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.center,
                  children: [
                    Text(
                      'Carbon',
                      style: GoogleFonts.spaceGrotesk(
                        fontSize: 18.sp,
                        fontWeight: FontWeight.w800,
                        letterSpacing: -0.3,
                        color: mainColor,
                      ),
                    ),
                    WmsText(color: wmsTeal, fontSize: 18),
                    if (label.isNotEmpty) ...[
                      Padding(
                        padding: EdgeInsets.symmetric(horizontal: 7.w),
                        child: Text(
                          '/',
                          style: TextStyle(
                            fontSize: 22.sp,
                            fontWeight: FontWeight.w700,
                            color: Colors.black,
                          ),
                        ),
                      ),
                      Text(
                        label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: GoogleFonts.spaceGrotesk(
                          fontSize: 16.sp,
                          fontWeight: FontWeight.w700,
                          letterSpacing: 0.6,
                          color: wmsTeal,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
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
