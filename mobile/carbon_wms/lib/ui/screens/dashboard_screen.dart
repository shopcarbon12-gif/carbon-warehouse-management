import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/handheld_device_identity.dart';
import 'package:carbon_wms/services/mobile_settings_repository.dart';
import 'package:carbon_wms/services/theme_notifier.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/barcode_intake_screen.dart';
import 'package:carbon_wms/ui/screens/encode_suite_screens.dart';
import 'package:carbon_wms/ui/screens/fast_putaway_screen.dart';
import 'package:carbon_wms/ui/screens/handheld_settings_screen.dart';
import 'package:carbon_wms/ui/screens/locate_tag_screen.dart';
import 'package:carbon_wms/ui/screens/inventory_csv_session_screen.dart';
import 'package:carbon_wms/ui/screens/inventory_lookup_screen.dart';
import 'package:carbon_wms/ui/screens/inventory_hub_screen.dart';
import 'package:carbon_wms/ui/screens/status_change_screen.dart';
import 'package:carbon_wms/ui/screens/transfer_slips_screen.dart';
import 'package:carbon_wms/ui/screens/clean_bin_screen.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart' show WmsText;
import 'package:carbon_wms/ui/widgets/ota_update_dialog.dart';

// ─── palette additions (dashboard only) ────────────────────────────────────
const Color _surfaceContainerLow = Color(0xFFEEF4F3);
const Color _surfaceContainerHigh = Color(0xFFE2EEEC);

class DashboardScreen extends StatefulWidget {
  /// Global key so any screen can call [DashboardScreen.scaffoldKey.currentState?.openDrawer()].
  static final scaffoldKey = GlobalKey<ScaffoldState>();

  const DashboardScreen({
    super.key,
    this.onLogout,
    this.otaDownloadUrl,
    this.otaLatestVersion,
  });

  final Future<void> Function()? onLogout;
  final String? otaDownloadUrl;
  final String? otaLatestVersion;

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  Timer? _otaPoll;
  String? _effectiveOtaUrl;
  bool _updateAvailable = false;
  String? _otaLatestVersion;
  bool _otaPeriodicDialogShown = false;

  int _navIndex = 0;

  // dashboard stats
  int? _inventoryUnits;
  int? _orderOpen;
  bool _statsLoading = false;

  // user identity
  String? _userEmail;

  // locations
  List<Map<String, String>> _locations = [];
  String _currentLocationName = 'Orlando Warehouse';

  @override
  void initState() {
    super.initState();
    _effectiveOtaUrl = widget.otaDownloadUrl;
    _otaLatestVersion = widget.otaLatestVersion;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      unawaited(_syncMobileSettings());
      unawaited(_refreshOtaHints(notifyUser: false));
      unawaited(_loadUserEmail());
      unawaited(_loadLocations());
      unawaited(_refreshDashboardStats());
      _otaPoll = Timer.periodic(const Duration(minutes: 3), (_) {
        unawaited(_refreshOtaHints(notifyUser: true));
        unawaited(_refreshDashboardStats());
      });
    });
  }

  @override
  void dispose() {
    _otaPoll?.cancel();
    super.dispose();
  }

  @override
  void didUpdateWidget(covariant DashboardScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.otaDownloadUrl != oldWidget.otaDownloadUrl) {
      _effectiveOtaUrl = widget.otaDownloadUrl;
    }
    if (widget.otaLatestVersion != oldWidget.otaLatestVersion) {
      _otaLatestVersion = widget.otaLatestVersion;
    }
  }

  Future<void> _loadLocations() async {
    if (!mounted) return;
    try {
      final api = context.read<WmsApiClient>();
      final locs = await api.fetchSessionLocations();
      if (!mounted) return;
      setState(() {
        _locations = locs;
        if (locs.isNotEmpty)
          _currentLocationName =
              locs.first['name'] ?? locs.first['code'] ?? _currentLocationName;
      });
    } catch (_) {}
  }

  void _pickLocation() {
    if (_locations.length <= 1) return;
    showModalBottomSheet<void>(
      context: context,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(12))),
      builder: (ctx) => ListView(
        shrinkWrap: true,
        children: [
          const Padding(
            padding: EdgeInsets.fromLTRB(20, 16, 20, 8),
            child: Text('Select Location',
                style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
          ),
          ..._locations.map((loc) {
            final name = loc['name'] ?? loc['code'] ?? '';
            final selected = name == _currentLocationName;
            return ListTile(
              title: Text(name),
              trailing: selected
                  ? const Icon(Icons.check, color: AppColors.primary)
                  : null,
              onTap: () {
                setState(() => _currentLocationName = name);
                Navigator.pop(ctx);
              },
            );
          }),
          const SizedBox(height: 16),
        ],
      ),
    );
  }

  Future<void> _loadUserEmail() async {
    if (!mounted) return;
    final api = context.read<WmsApiClient>();
    final email = await api.getSavedLoginEmail();
    if (!mounted) return;
    setState(() => _userEmail = email);
  }

  Future<void> _refreshDashboardStats() async {
    if (!mounted || _statsLoading) return;
    if (mounted) setState(() => _statsLoading = true);
    try {
      final api = context.read<WmsApiClient>();
      final stats = await api.fetchDashboardStats();
      if (!mounted) return;
      setState(() {
        _inventoryUnits = (stats['inventory_units'] as num?)?.toInt();
        _orderOpen = (stats['order_open'] as num?)?.toInt();
        _statsLoading = false;
      });
    } catch (_) {
      if (mounted) setState(() => _statsLoading = false);
    }
  }

  Future<void> _syncMobileSettings() async {
    if (!mounted) return;
    final api = context.read<WmsApiClient>();
    final repo = context.read<MobileSettingsRepository>();
    final id = await HandheldDeviceIdentity.primaryDeviceIdForServer();
    await repo.syncFromServer(api, deviceId: id);
  }

  Future<void> _refreshOtaHints({required bool notifyUser}) async {
    if (!mounted) return;
    try {
      final api = context.read<WmsApiClient>();
      final info = await PackageInfo.fromPlatform();
      final androidId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
      final st = await api.fetchMobileStatus(
        version: info.version,
        androidId: androidId.isEmpty || androidId == 'HANDHELD_OFFLINE'
            ? null
            : androidId,
      );
      final url = (st['downloadUrl'] as String?)?.trim();
      final latestRaw = st['latestVersion'];
      final latest = latestRaw is String ? latestRaw.trim() : '';
      // Only treat as update if server version is strictly newer than installed.
      final serverNewer =
          latest.isNotEmpty && _isVersionNewer(latest, info.version);
      final upd = st['updateAvailable'] == true && serverNewer;
      if (!mounted) return;
      setState(() {
        _effectiveOtaUrl = (url != null && url.isNotEmpty) ? url : null;
        _updateAvailable = upd;
        if (latest.isNotEmpty) _otaLatestVersion = latest;
        if (!upd) _otaPeriodicDialogShown = false;
      });
      if (notifyUser &&
          upd &&
          mounted &&
          url != null &&
          url.isNotEmpty &&
          !_otaPeriodicDialogShown) {
        _otaPeriodicDialogShown = true;
        unawaited(
          showCarbonWmsOtaDialog(
            context: context,
            downloadUrl: url,
            latestVersion: _otaLatestVersion,
            onInstallChosen: (u) async {
              try {
                await context.read<WmsApiClient>().downloadAndInstallApk(u);
              } catch (e) {
                if (mounted) {
                  ScaffoldMessenger.of(context)
                      .showSnackBar(SnackBar(content: Text('$e')));
                }
              }
            },
          ),
        );
      }
    } catch (_) {}
  }

  String? get _otaForInstall {
    final u = _effectiveOtaUrl ?? widget.otaDownloadUrl;
    if (u == null || u.trim().isEmpty) return null;
    return u.trim();
  }

  Future<void> _installOta(BuildContext ctx) async {
    final url = _otaForInstall;
    if (url == null) {
      ScaffoldMessenger.of(ctx).showSnackBar(
        const SnackBar(
          content: Text(
            'No OTA URL — upload an active APK in WMS (Settings → Mobile OTA) '
            'and authorize this device.',
          ),
        ),
      );
      return;
    }
    try {
      await ctx.read<WmsApiClient>().downloadAndInstallApk(url);
    } catch (e) {
      if (ctx.mounted) {
        ScaffoldMessenger.of(ctx).showSnackBar(SnackBar(content: Text('$e')));
      }
    }
  }

  void _push(Widget screen) => Navigator.of(context)
      .push<void>(MaterialPageRoute<void>(builder: (_) => screen));

  void _onNavTap(int idx) {
    if (idx == _navIndex) return;
    setState(() => _navIndex = idx);
    switch (idx) {
      case 1:
        _push(const InventoryHubScreen());
      case 2:
        _push(const TransferSlipsScreen());
      case 3:
        _push(const EncodeSuiteScreen(initialTab: 0));
    }
    setState(() => _navIndex = 0);
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
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
      key: DashboardScreen.scaffoldKey,
      backgroundColor: isDark ? const Color(0xFF111A1A) : Colors.white,
      appBar: _buildAppBar(context),
      drawer: _buildDrawer(context),
      drawerEnableOpenDragGesture: false,
      body: _buildBody(context),
      bottomNavigationBar: _buildBottomNav(context),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DRAWER
  // ═══════════════════════════════════════════════════════════════════════════
  Widget _buildDrawer(BuildContext context) {
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
          // ── Colored user header ──────────────────────────────────────
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
                    color: Colors.white,
                  ),
                  textAlign: TextAlign.center,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 6),
                Text(
                  email,
                  style: GoogleFonts.manrope(
                    fontSize: 14,
                    fontWeight: FontWeight.w500,
                    color: Colors.white.withValues(alpha: 0.8),
                  ),
                  textAlign: TextAlign.center,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
          const SizedBox(height: 20),
          _DrawerItem(
            icon: Icons.settings_outlined,
            label: 'Settings',
            onTap: () {
              Navigator.pop(context);
              _push(const HandheldSettingsScreen());
            },
          ),
          const SizedBox(height: 4),
          _DrawerItem(
            icon: Icons.sync,
            label: 'Refresh Settings / Permissions',
            onTap: () async {
              Navigator.pop(context);
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(
                    content: Text('Syncing settings…'),
                    duration: Duration(seconds: 1)),
              );
              await _syncMobileSettings();
              await _refreshDashboardStats();
              if (mounted) {
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(
                      content: Text('Settings refreshed.'),
                      duration: Duration(seconds: 2)),
                );
              }
            },
          ),
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
              Navigator.pop(context);
              widget.onLogout!();
            },
          ),
          const SizedBox(height: 80),
        ],
      ),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // APP BAR
  // ═══════════════════════════════════════════════════════════════════════════
  PreferredSizeWidget _buildAppBar(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return AppBar(
      backgroundColor: isDark ? const Color(0xFF111A1A) : Colors.white,
      elevation: 0,
      surfaceTintColor: Colors.transparent,
      leadingWidth: 56,
      leading: Builder(
        builder: (ctx) => Center(
          child: Padding(
            padding: const EdgeInsets.only(left: 14),
            child: GestureDetector(
              onTap: () {
                final scaffold = Scaffold.of(ctx);
                if (scaffold.isDrawerOpen) {
                  Navigator.of(ctx).pop();
                } else {
                  scaffold.openDrawer();
                }
              },
              child: ClipOval(
                child: Image.asset(
                  'assets/carbon_logo.png',
                  width: 40,
                  height: 40,
                  fit: BoxFit.cover,
                ),
              ),
            ),
          ),
        ),
      ),
      titleSpacing: 6,
      title: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            'Carbon',
            style: GoogleFonts.spaceGrotesk(
              fontSize: 20,
              fontWeight: FontWeight.w800,
              letterSpacing: -0.3,
              color: isDark ? const Color(0xFFE0ECEC) : AppColors.textMain,
            ),
          ),
          WmsText(
            color: isDark ? const Color(0xFF4DB6AC) : AppColors.primary,
            fontSize: 20,
          ),
        ],
      ),
      actions: [
        Stack(
          clipBehavior: Clip.none,
          alignment: Alignment.center,
          children: [
            IconButton(
              tooltip: 'Download & install update',
              icon: const Icon(Icons.system_update_alt, size: 27),
              color: AppColors.textMuted,
              onPressed: () => _installOta(context),
            ),
            if (_updateAvailable)
              Positioned(
                right: 6,
                top: 10,
                child: Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    color: AppColors.success,
                    shape: BoxShape.circle,
                    border: Border.all(
                        color: isDark ? const Color(0xFF111A1A) : Colors.white,
                        width: 1.5),
                  ),
                ),
              ),
          ],
        ),
        if (widget.onLogout != null)
          IconButton(
            tooltip: 'Sign out',
            icon: const Icon(Icons.power_settings_new, size: 27),
            color: AppColors.textMuted,
            onPressed: () => widget.onLogout!(),
          ),
        const SizedBox(width: 4),
      ],
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BODY
  // ═══════════════════════════════════════════════════════════════════════════
  Widget _buildBody(BuildContext context) {
    return Consumer2<RfidManager, MobileSettingsRepository>(
      builder: (context, rfid, settings, _) {
        final isDark = Theme.of(context).brightness == Brightness.dark;
        final readerConnected = rfid.activeScanner != null;
        final hardwareLinked = rfid.isHardwareLinked;

        final mutedColor =
            isDark ? const Color(0xFF7A9090) : AppColors.textMuted;
        final mainColor = isDark ? const Color(0xFFE0ECEC) : AppColors.textMain;
        final cardColor =
            isDark ? const Color(0xFF1C2828) : _surfaceContainerLow;
        final cardHigh =
            isDark ? const Color(0xFF243030) : _surfaceContainerHigh;

        return CustomScrollView(
          slivers: [
            // ── B. Stat cards ──────────────────────────────────────────
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 16, 20, 0),
                child: Row(
                  children: [
                    _StatCard(
                      label: 'LIVE SCAN',
                      value: hardwareLinked ? '0' : 'N/A',
                      dot: true,
                      dotColor:
                          hardwareLinked ? Colors.green : AppColors.textMuted,
                      cardColor: cardColor,
                      mainColor: mainColor,
                      mutedColor: mutedColor,
                    ),
                    const SizedBox(width: 8),
                    _StatCard(
                      label: 'INVENTORY',
                      value: _statsLoading
                          ? '…'
                          : (_inventoryUnits != null
                              ? _fmtNum(_inventoryUnits!)
                              : '—'),
                      onTap: () => _push(const InventoryLookupScreen()),
                      cardColor: cardColor,
                      mainColor: mainColor,
                      mutedColor: mutedColor,
                    ),
                    const SizedBox(width: 8),
                    _StatCard(
                      label: 'RECEIVING',
                      value:
                          _statsLoading ? '…' : (_orderOpen?.toString() ?? '—'),
                      onTap: () => _push(const TransferSlipsScreen()),
                      cardColor: cardColor,
                      mainColor: mainColor,
                      mutedColor: mutedColor,
                    ),
                  ],
                ),
              ),
            ),

            // ── C. Locations block ────────────────────────────────────
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 12, 20, 0),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        if (_locations.length > 1) const SizedBox(width: 30),
                        Text(
                          'LOCATIONS',
                          style: GoogleFonts.spaceGrotesk(
                            fontSize: 12,
                            fontWeight: FontWeight.w700,
                            letterSpacing: 2.0,
                            color: mutedColor,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 2),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.center,
                      children: [
                        if (_locations.length > 1)
                          GestureDetector(
                            onTap: _pickLocation,
                            child: Padding(
                              padding: const EdgeInsets.only(right: 8),
                              child:
                                  Icon(Icons.menu, size: 22, color: mutedColor),
                            ),
                          ),
                        Expanded(
                          child: Text(
                            _currentLocationName,
                            style: GoogleFonts.manrope(
                              fontSize: 22,
                              fontWeight: FontWeight.w800,
                              letterSpacing: -1.0,
                              color: mainColor,
                            ),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),

            // ── D. 2×2 Hero tile grid ─────────────────────────────────
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(20, 20, 20, 0),
              sliver: SliverToBoxAdapter(
                child: GridView.count(
                  shrinkWrap: true,
                  physics: const NeverScrollableScrollPhysics(),
                  crossAxisCount: 2,
                  mainAxisSpacing: 12,
                  crossAxisSpacing: 12,
                  childAspectRatio: 1,
                  children: [
                    _HeroTile(
                      icon: Icons.inventory_2_outlined,
                      label: 'Inventory',
                      teal: false,
                      cardColor: cardColor,
                      cardHigh: cardHigh,
                      mainColor: mainColor,
                      onTap: () => _push(const InventoryHubScreen()),
                    ),
                    _HeroTile(
                      icon: Icons.precision_manufacturing_outlined,
                      label: 'Operations',
                      teal: true,
                      cardColor: cardColor,
                      cardHigh: cardHigh,
                      mainColor: mainColor,
                      onTap: () => _push(const TransferSlipsScreen()),
                    ),
                    _HeroTile(
                      icon: Icons.qr_code_scanner,
                      label: 'Bin Assign',
                      teal: false,
                      highSurface: true,
                      cardColor: cardColor,
                      cardHigh: cardHigh,
                      mainColor: mainColor,
                      onTap: () => _push(const FastPutawayScreen()),
                    ),
                    _HeroTile(
                      icon: Icons.local_shipping_outlined,
                      label: 'Transfers',
                      teal: false,
                      cardColor: cardColor,
                      cardHigh: cardHigh,
                      mainColor: mainColor,
                      onTap: () => _push(const BarcodeIntakeScreen()),
                    ),
                  ],
                ),
              ),
            ),

            // ── E. Hardware Pulse ─────────────────────────────────────
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 28, 20, 0),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'HARDWARE PULSE',
                      style: GoogleFonts.spaceGrotesk(
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 2.0,
                        color: mutedColor,
                      ),
                    ),
                    const SizedBox(height: 12),
                    GridView.count(
                      shrinkWrap: true,
                      physics: const NeverScrollableScrollPhysics(),
                      crossAxisCount: 2,
                      mainAxisSpacing: 8,
                      crossAxisSpacing: 8,
                      childAspectRatio: 2.8,
                      children: [
                        _PulseCard(
                            label: 'Readers',
                            value: readerConnected ? '1' : '0',
                            active: readerConnected,
                            cardColor: cardColor,
                            mainColor: mainColor,
                            mutedColor: mutedColor),
                        _PulseCard(
                            label: 'Antennas',
                            value: '—',
                            active: false,
                            noSource: true,
                            cardColor: cardColor,
                            mainColor: mainColor,
                            mutedColor: mutedColor),
                        _PulseCard(
                            label: 'Printers',
                            value: '—',
                            active: false,
                            noSource: true,
                            cardColor: cardColor,
                            mainColor: mainColor,
                            mutedColor: mutedColor),
                        _PulseCard(
                            label: 'Handhelds',
                            value: '—',
                            active: false,
                            noSource: true,
                            cardColor: cardColor,
                            mainColor: mainColor,
                            mutedColor: mutedColor),
                      ],
                    ),
                  ],
                ),
              ),
            ),

            // ── F. Operator + Throughput ──────────────────────────────
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 20, 20, 0),
                child: Row(
                  children: [
                    const Expanded(
                        child: _InfoCard(label: 'Operator', value: '—')),
                    const SizedBox(width: 12),
                    Expanded(
                      child: _InfoCard(
                        label: 'Throughput',
                        value: '—',
                        trailing: Icon(Icons.trending_up,
                            color: mutedColor, size: 18),
                      ),
                    ),
                  ],
                ),
              ),
            ),

            // ── G. MORE TOOLS ─────────────────────────────────────────
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 28, 20, 0),
                child: Text('MORE TOOLS',
                    style: GoogleFonts.spaceGrotesk(
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 2.0,
                        color: mutedColor)),
              ),
            ),
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(20, 10, 20, 32),
              sliver: SliverGrid(
                gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: 3,
                  mainAxisSpacing: 8,
                  crossAxisSpacing: 8,
                  childAspectRatio: 1.1,
                ),
                delegate: SliverChildListDelegate([
                  _SmallTile(
                      icon: LucideIcons.layers,
                      label: 'Putaway',
                      onTap: () => _push(const FastPutawayScreen())),
                  _SmallTile(
                      icon: LucideIcons.trash2,
                      label: 'Clean Bin',
                      onTap: () => _push(const CleanBinScreen())),
                  _SmallTile(
                      icon: LucideIcons.fileUp,
                      label: 'CSV',
                      onTap: () => _push(const InventoryCsvSessionScreen())),
                  _SmallTile(
                      icon: LucideIcons.radio,
                      label: 'Geiger',
                      onTap: () => _push(const LocateTagScreen())),
                  _SmallTile(
                      icon: LucideIcons.clipboardList,
                      label: 'Status',
                      onTap: () => _push(const StatusChangeScreen())),
                  _SmallTile(
                      icon: LucideIcons.printer,
                      label: 'Print',
                      onTap: () =>
                          _push(const EncodeSuiteScreen(initialTab: 1))),
                  _SmallTile(
                      icon: LucideIcons.upload,
                      label: 'Upload',
                      onTap: () =>
                          _push(const EncodeSuiteScreen(initialTab: 2))),
                ]),
              ),
            ),
          ],
        );
      },
    );
  }

  /// Returns true only if [server] version is strictly greater than [installed].
  bool _isVersionNewer(String server, String installed) {
    List<int> parse(String v) =>
        v.split('.').map((p) => int.tryParse(p) ?? 0).toList();
    final s = parse(server);
    final i = parse(installed);
    final len = s.length > i.length ? s.length : i.length;
    for (var x = 0; x < len; x++) {
      final sv = x < s.length ? s[x] : 0;
      final iv = x < i.length ? i[x] : 0;
      if (sv > iv) return true;
      if (sv < iv) return false;
    }
    return false;
  }

  String _fmtNum(int n) {
    if (n >= 1000000) return '${(n / 1000000).toStringAsFixed(1)}M';
    if (n >= 1000) return '${(n / 1000).toStringAsFixed(1)}K';
    return n.toString();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BOTTOM NAV
  // ═══════════════════════════════════════════════════════════════════════════
  Widget _buildBottomNav(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    const items = [
      (icon: Icons.dashboard, label: 'Dash'),
      (icon: Icons.inventory_2_outlined, label: 'Stock'),
      (icon: Icons.precision_manufacturing_outlined, label: 'Ops'),
      (icon: Icons.qr_code_scanner, label: 'Tags'),
    ];

    return Container(
      height: 72 + MediaQuery.of(context).padding.bottom,
      decoration: BoxDecoration(
        color: isDark ? const Color(0xFF1C2828) : Colors.white,
        border: Border(
            top: BorderSide(
                color: isDark ? Colors.white12 : const Color(0xFFEDF2F1),
                width: 1)),
        boxShadow: isDark
            ? null
            : const [
                BoxShadow(
                    color: Color(0x0A000000),
                    blurRadius: 24,
                    offset: Offset(0, -8)),
              ],
      ),
      child: SafeArea(
        top: false,
        child: Row(
          children: List.generate(items.length, (i) {
            final item = items[i];
            final active = i == _navIndex;
            return Expanded(
              child: GestureDetector(
                onTap: () => _onNavTap(i),
                behavior: HitTestBehavior.opaque,
                child: Container(
                  margin:
                      const EdgeInsets.symmetric(horizontal: 4, vertical: 8),
                  decoration: BoxDecoration(
                    color: active
                        ? (isDark
                            ? const Color(0xFF243030)
                            : _surfaceContainerHigh)
                        : Colors.transparent,
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(
                        item.icon,
                        size: 22,
                        color: active ? AppColors.primary : AppColors.textMuted,
                      ),
                      const SizedBox(height: 3),
                      Text(
                        item.label,
                        style: GoogleFonts.manrope(
                          fontSize: 12,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 0.8,
                          color:
                              active ? AppColors.primary : AppColors.textMuted,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            );
          }),
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WIDGETS
// ═══════════════════════════════════════════════════════════════════════════════

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
              width: 26,
              child: Icon(icon, size: large ? 26 : 24, color: fg),
            ),
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

class _StatCard extends StatelessWidget {
  const _StatCard({
    required this.label,
    required this.value,
    required this.cardColor,
    required this.mainColor,
    required this.mutedColor,
    this.dot = false,
    this.dotColor,
    this.onTap,
  });

  final String label;
  final String value;
  final Color cardColor;
  final Color mainColor;
  final Color mutedColor;
  final bool dot;
  final Color? dotColor;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: GestureDetector(
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          decoration: BoxDecoration(
              color: cardColor, borderRadius: BorderRadius.circular(4)),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  if (dot)
                    Container(
                      width: 8,
                      height: 8,
                      margin: const EdgeInsets.only(right: 6),
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: dotColor ?? mutedColor,
                      ),
                    ),
                  Flexible(
                    child: Text(label,
                        style: GoogleFonts.spaceGrotesk(
                            fontSize: 12,
                            fontWeight: FontWeight.w700,
                            letterSpacing: 1.4,
                            color: mutedColor)),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Text(value,
                  style: GoogleFonts.manrope(
                      fontSize: 28,
                      fontWeight: FontWeight.w800,
                      letterSpacing: -0.5,
                      color: mainColor)),
            ],
          ),
        ),
      ),
    );
  }
}

class _HeroTile extends StatelessWidget {
  const _HeroTile({
    required this.icon,
    required this.label,
    required this.teal,
    required this.onTap,
    required this.cardColor,
    required this.cardHigh,
    required this.mainColor,
    this.highSurface = false,
  });

  final IconData icon;
  final String label;
  final bool teal;
  final bool highSurface;
  final VoidCallback onTap;
  final Color cardColor;
  final Color cardHigh;
  final Color mainColor;

  @override
  Widget build(BuildContext context) {
    final bg = teal
        ? AppColors.primary
        : highSurface
            ? cardHigh
            : cardColor;
    final fg = teal ? Colors.white : mainColor;
    final watermarkColor = teal
        ? Colors.white.withValues(alpha: 0.12)
        : mainColor.withValues(alpha: 0.07);

    return Material(
      color: bg,
      borderRadius: BorderRadius.circular(2),
      clipBehavior: Clip.hardEdge,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(2),
        child: Stack(
          children: [
            Positioned(
              right: 8,
              bottom: 8,
              child: Icon(icon, size: 92, color: watermarkColor),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 28),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Icon(icon, size: 36, color: fg),
                  Text(
                    label.toUpperCase(),
                    style: GoogleFonts.manrope(
                      fontSize: 16,
                      fontWeight: FontWeight.w900,
                      letterSpacing: 0.2,
                      color: fg,
                    ),
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

class _PulseCard extends StatelessWidget {
  const _PulseCard({
    required this.label,
    required this.value,
    required this.active,
    required this.cardColor,
    required this.mainColor,
    required this.mutedColor,
    this.noSource = false,
  });

  final String label;
  final String value;
  final bool active;
  final bool noSource;
  final Color cardColor;
  final Color mainColor;
  final Color mutedColor;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
          color: cardColor, borderRadius: BorderRadius.circular(2)),
      child: Row(
        children: [
          Container(
            width: 7,
            height: 7,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: active
                  ? AppColors.primary
                  : mutedColor.withValues(alpha: 0.3),
            ),
          ),
          const SizedBox(width: 10),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text(label.toUpperCase(),
                  style: GoogleFonts.spaceGrotesk(
                      fontSize: 11,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 1.0,
                      color: mutedColor)),
              Text(value,
                  style: GoogleFonts.manrope(
                      fontSize: 15,
                      fontWeight: FontWeight.w700,
                      color: noSource
                          ? mainColor.withValues(alpha: 0.6)
                          : mainColor)),
            ],
          ),
        ],
      ),
    );
  }
}

class _InfoCard extends StatelessWidget {
  const _InfoCard({required this.label, required this.value, this.trailing});

  final String label;
  final String value;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final cardColor = isDark ? const Color(0xFF1C2828) : _surfaceContainerLow;
    final mainColor = isDark ? const Color(0xFFE0ECEC) : AppColors.textMain;
    final mutedColor = isDark ? const Color(0xFF7A9090) : AppColors.textMuted;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
          color: cardColor, borderRadius: BorderRadius.circular(2)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label.toUpperCase(),
              style: GoogleFonts.spaceGrotesk(
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 1.5,
                  color: mutedColor)),
          const SizedBox(height: 6),
          Row(
            children: [
              Expanded(
                child: Text(value,
                    style: GoogleFonts.manrope(
                        fontSize: 15,
                        fontWeight: FontWeight.w700,
                        color: mainColor.withValues(alpha: 0.6))),
              ),
              if (trailing != null) trailing!,
            ],
          ),
        ],
      ),
    );
  }
}

class _SmallTile extends StatelessWidget {
  const _SmallTile(
      {required this.icon, required this.label, required this.onTap});

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final cardColor = isDark ? const Color(0xFF1C2828) : _surfaceContainerLow;
    final iconColor = isDark ? const Color(0xFF7A9090) : AppColors.slateAction;
    final textColor = isDark ? const Color(0xFF7A9090) : AppColors.textMuted;
    return Material(
      color: cardColor,
      borderRadius: BorderRadius.circular(2),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(2),
        child: Padding(
          padding: const EdgeInsets.all(10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(icon, size: 20, color: iconColor),
              const Spacer(),
              Text(label.toUpperCase(),
                  style: GoogleFonts.manrope(
                      fontSize: 11,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 0.6,
                      color: textColor)),
            ],
          ),
        ),
      ),
    );
  }
}
