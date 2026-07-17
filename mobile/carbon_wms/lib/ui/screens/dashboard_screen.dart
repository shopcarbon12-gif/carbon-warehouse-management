import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:flutter/services.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/handheld_device_identity.dart';
import 'package:carbon_wms/services/mobile_permissions.dart';
import 'package:carbon_wms/services/mobile_settings_repository.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/guards/permission_guard.dart';
import 'package:carbon_wms/ui/screens/handheld_settings_screen.dart';
import 'package:carbon_wms/ui/screens/inventory_lookup_screen.dart';
import 'package:carbon_wms/ui/screens/inventory_catalog_screen.dart';
import 'package:carbon_wms/ui/screens/geiger_search_screen.dart';
import 'package:carbon_wms/ui/screens/print_screen.dart';
import 'package:carbon_wms/ui/screens/category_hub_screen.dart';
import 'package:carbon_wms/ui/screens/transfer_in_pending_screen.dart';
import 'package:carbon_wms/ui/widgets/carbon_app_drawer.dart';
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
  // Count of OPEN incoming transfer slips (in-transit / partially_received)
  // whose destination is this location — drives the RECEIVING KPI. 0 = none.
  int? _receivingOpen;
  // Hardware Pulse — counts come from /api/dashboard/summary, scoped to the
  // session's location server-side.
  int? _hwReaders;
  int? _hwReadersOnline;
  int? _hwAntennas;
  int? _hwAntennasOnline;
  int? _hwPrinters;
  int? _hwPrintersOnline;
  bool _statsLoading = false;

  // user identity
  String? _userEmail;

  // locations
  List<Map<String, String>> _locations = [];
  String? _currentLocationId;
  // Empty until /api/auth/session-locations resolves — we deliberately
  // do NOT default to a real warehouse name (was 'Orlando Warehouse'),
  // which would mislead an operator who logged into a different site
  // before the location list arrived.
  String _currentLocationName = '';

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
        if (locs.isNotEmpty && _currentLocationId == null) {
          // Server sets the active lid at login to the user's first
          // location (sorted by code). Mirror that here for the initial
          // header text; once the user picks via Change Location we
          // track the chosen id explicitly.
          _currentLocationId = locs.first['id'];
          _currentLocationName =
              locs.first['name'] ?? locs.first['code'] ?? _currentLocationName;
        }
      });
    } catch (_) {}
  }

  void _pickLocation() {
    if (_locations.length <= 1) return;
    showModalBottomSheet<void>(
      context: context,
      shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(12.r))),
      builder: (ctx) => ListView(
        shrinkWrap: true,
        children: [
          Padding(
            padding: EdgeInsets.fromLTRB(20.w, 16.h, 20.w, 8.h),
            child: Text('Select Location',
                style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15.sp)),
          ),
          ..._locations.map((loc) {
            final name = loc['name'] ?? loc['code'] ?? '';
            final id = loc['id'] ?? '';
            final selected = name == _currentLocationName;
            return ListTile(
              title: Text(name),
              trailing: selected
                  ? const Icon(Icons.check, color: AppColors.primary)
                  : null,
              onTap: () {
                Navigator.pop(ctx);
                if (!selected && id.isNotEmpty) {
                  unawaited(_applyLocationSwitch(id: id, name: name));
                }
              },
            );
          }),
          SizedBox(height: 16.h),
        ],
      ),
    );
  }

  /// Server-side location switch: mints a fresh JWT scoped to [id], saves
  /// it via setSessionToken, and re-fetches dashboard stats so the new
  /// scope is reflected immediately. All other screens (catalog, count,
  /// status change…) call the API with the saved token, so the switch
  /// propagates to them automatically as soon as they refetch.
  Future<void> _applyLocationSwitch({
    required String id,
    required String name,
  }) async {
    if (!mounted) return;
    final api = context.read<WmsApiClient>();
    final messenger = ScaffoldMessenger.of(context);
    messenger.showSnackBar(SnackBar(
      content: Text('Switching to $name…'),
      duration: const Duration(seconds: 1),
    ));
    try {
      final ok = await api.switchSessionLocation(id);
      if (!mounted) return;
      if (!ok) {
        messenger.showSnackBar(const SnackBar(
          content: Text('Location switch refused — check permissions.'),
        ));
        return;
      }
      setState(() {
        _currentLocationId = id;
        _currentLocationName = name;
        // Clear stats so the UI shows "…" while the new scope loads.
        _inventoryUnits = null;
        _receivingOpen = null;
        _hwReaders = null;
        _hwReadersOnline = null;
        _hwAntennas = null;
        _hwAntennasOnline = null;
        _hwPrinters = null;
        _hwPrintersOnline = null;
      });
      await _refreshDashboardStats();
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(
        content: Text('Active location: $name'),
        duration: const Duration(seconds: 2),
      ));
    } catch (e) {
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text('Switch failed: $e')));
    }
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
      // Server-side reachable but auth/decode failed → surface a snackbar
      // so operators can see why the tiles are dashed (Chainway dash-vs-
      // Samsung-26/3 was a stale-JWT mismatch with no UI clue).
      //
      // Transient network failures (handheld coming out of sleep, Wi-Fi
      // reconnecting, mobile data flapping) get suppressed in 1.2.47.
      // Operators were seeing the snackbar fire every time they unlocked
      // the device, with the toString'd SocketException about failed
      // host lookups. The 3-minute periodic refresh already self-heals
      // the tiles once the radio is back, so the noise serves no
      // purpose. Schedule a fast follow-up retry instead.
      final apiError = stats['__error']?.toString();
      if (apiError != null) {
        if (_isTransientNetworkError(apiError)) {
          // Silent retry in 5s — by then the radio is usually back up.
          Future<void>.delayed(const Duration(seconds: 5), () {
            if (mounted) unawaited(_refreshDashboardStats());
          });
        } else {
          final messenger = ScaffoldMessenger.of(context);
          messenger.hideCurrentSnackBar();
          messenger.showSnackBar(SnackBar(
            content: Text('Dashboard: $apiError — try Refresh / re-sign-in'),
            duration: const Duration(seconds: 4),
          ));
        }
      }
      setState(() {
        _inventoryUnits = (stats['inventory_units'] as num?)?.toInt();
        _hwReaders = (stats['hw_readers'] as num?)?.toInt();
        _hwReadersOnline = (stats['hw_readers_online'] as num?)?.toInt();
        _hwAntennas = (stats['hw_antennas'] as num?)?.toInt();
        _hwAntennasOnline = (stats['hw_antennas_online'] as num?)?.toInt();
        _hwPrinters = (stats['hw_printers'] as num?)?.toInt();
        _hwPrintersOnline = (stats['hw_printers_online'] as num?)?.toInt();
        _statsLoading = false;
      });
      // RECEIVING KPI — the count of open incoming transfer slips for this
      // location. Separate light query (the dashboard stats endpoint doesn't
      // track transfers); failures just leave the previous value.
      try {
        final pending = await api.fetchPendingIncomingTransfers();
        if (mounted) setState(() => _receivingOpen = pending.length);
      } catch (_) {/* keep last known value */}
    } catch (_) {
      if (mounted) setState(() => _statsLoading = false);
    }
  }

  /// Match the kind of failure that fires when the handheld's radio
  /// hasn't reconnected yet after a screen unlock — DNS lookup, broken
  /// pipe, or socket reset. We retry these silently instead of yelling
  /// at the operator with a SnackBar they can't act on.
  bool _isTransientNetworkError(String msg) {
    final m = msg.toLowerCase();
    return m.contains('failed host lookup') ||
        m.contains('socketexception') ||
        m.contains('handshakeexception') ||
        m.contains('connection closed') ||
        m.contains('connection reset') ||
        m.contains('network is unreachable') ||
        m.contains('software caused connection abort') ||
        m.contains('os error');
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

  /// Phase 2 RBAC-aware push. Skips the push (with a one-shot snackbar)
  /// when [screenId] is in the operator's hidden-screens list and wraps
  /// the destination in [PermissionGuard] so a deep-link / scan
  /// shortcut can't bypass the check either.
  Future<void> _pushGuarded(String screenId, WidgetBuilder builder) {
    return context.pushGuarded<void>(screenId, builder);
  }

  /// Plain push for the category hubs (they have no single screen id; the hub
  /// itself filters its tiles by permission, and the dashboard square is gated
  /// by the OR of its children).
  Future<void> _pushScreen(Widget screen) {
    return Navigator.of(context)
        .push(MaterialPageRoute<void>(builder: (_) => screen));
  }

  void _onNavTap(int idx) {
    if (idx == _navIndex) return;
    setState(() => _navIndex = idx);
    switch (idx) {
      case 1:
        _pushGuarded(
            ScreenIds.inventoryCatalog, (_) => const InventoryCatalogScreen());
      case 2:
        _pushGuarded(
            ScreenIds.geigerSearch, (_) => const GeigerSearchScreen());
      case 3:
        _pushGuarded(
            ScreenIds.print, (_) => const PrintScreen(mode: PrintMode.rfid));
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
    return CarbonAppDrawer(
      userEmail: _userEmail,
      currentLocationName: _currentLocationName,
      canChangeLocation: _locations.length > 1,
      onChangeLocation: () {
        Navigator.pop(context);
        _pickLocation();
      },
      onSettings: () {
        Navigator.pop(context);
        _pushGuarded(
          ScreenIds.handheldSettings,
          (_) => const HandheldSettingsScreen(),
        );
      },
      onRefresh: () async {
        Navigator.pop(context);
        final messenger = ScaffoldMessenger.of(context);
        final api = context.read<WmsApiClient>();
        final perms = context.read<MobilePermissions>();
        messenger.showSnackBar(
          const SnackBar(
            content: Text('Syncing settings...'),
            duration: Duration(seconds: 1),
          ),
        );
        await _syncMobileSettings();
        await _refreshDashboardStats();
        // Refresh the Phase 2 RBAC payload as part of the manual sync so
        // operators can pull a role change without logging out.
        await perms.refresh(api);
        if (mounted) {
          messenger.showSnackBar(
            const SnackBar(
              content: Text('Settings refreshed.'),
              duration: Duration(seconds: 2),
            ),
          );
        }
      },
      onLogout: widget.onLogout == null
          ? null
          : () {
              Navigator.pop(context);
              widget.onLogout!();
            },
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
            padding: EdgeInsets.only(left: 14.w),
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
                  width: 40.w,
                  height: 40.w,
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
              fontSize: 20.sp,
              fontWeight: FontWeight.w800,
              letterSpacing: -0.3,
              color: isDark ? const Color(0xFFE0ECEC) : AppColors.textMain,
            ),
          ),
          WmsText(
            color: isDark ? const Color(0xFF4DB6AC) : AppColors.primary,
            fontSize: 20.sp,
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
              icon: Icon(Icons.system_update_alt, size: 27.sp),
              color: AppColors.textMuted,
              onPressed: () => _installOta(context),
            ),
            if (_updateAvailable)
              Positioned(
                right: 6.w,
                top: 10.h,
                child: Container(
                  width: 8.w,
                  height: 8.h,
                  decoration: BoxDecoration(
                    color: AppColors.success,
                    shape: BoxShape.circle,
                    border: Border.all(
                        color: isDark ? const Color(0xFF111A1A) : Colors.white,
                        width: 1.5.w),
                  ),
                ),
              ),
          ],
        ),
        if (widget.onLogout != null)
          IconButton(
            tooltip: 'Sign out',
            icon: Icon(Icons.power_settings_new, size: 27.sp),
            color: AppColors.textMuted,
            onPressed: () => widget.onLogout!(),
          ),
        SizedBox(width: 4.w),
      ],
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BODY
  // ═══════════════════════════════════════════════════════════════════════════
  Widget _buildBody(BuildContext context) {
    return Consumer2<RfidManager, MobileSettingsRepository>(
      builder: (context, rfid, settings, _) {
        // Permissions drive which tiles appear — watching forces a rebuild
        // whenever the post-login refresh lands. Until the first fetch
        // completes [hasFullAccess] is true (fail-open) so nothing is
        // hidden during the brief window before the cached value loads.
        final perms = context.watch<MobilePermissions>();
        final isDark = Theme.of(context).brightness == Brightness.dark;
        final mutedColor =
            isDark ? const Color(0xFF7A9090) : AppColors.textMuted;
        final mainColor = isDark ? const Color(0xFFE0ECEC) : AppColors.textMain;
        final cardColor =
            isDark ? const Color(0xFF1C2828) : _surfaceContainerLow;
        final cardHigh =
            isDark ? const Color(0xFF243030) : _surfaceContainerHigh;

        return CustomScrollView(
          slivers: [
            // ── A. Location header — sits above the stat cards. No
            //      "LOCATIONS" label and no inline switcher: the switcher
            //      moved into the side drawer's "Change Location" item.
            SliverToBoxAdapter(
              child: Padding(
                padding: EdgeInsets.fromLTRB(20.w, 8.h, 20.w, 0),
                child: Text(
                  _currentLocationName,
                  style: GoogleFonts.manrope(
                    fontSize: 22.sp,
                    fontWeight: FontWeight.w800,
                    letterSpacing: -1.0,
                    color: mainColor,
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ),

            // ── B. Stat cards ──────────────────────────────────────────
            //   "Live Scan" was removed — it was a hardware-link mirror,
            //   not an actionable KPI. Inventory + Receiving remain and
            //   are wired to /api/dashboard/summary, which scopes by the
            //   current session location server-side.
            SliverToBoxAdapter(
              child: Padding(
                padding: EdgeInsets.fromLTRB(20.w, 8.h, 20.w, 0.h),
                child: Row(
                  children: [
                    _StatCard(
                      label: 'INVENTORY',
                      value: _statsLoading
                          ? '…'
                          : (_inventoryUnits != null
                              ? _fmtNum(_inventoryUnits!)
                              : '—'),
                      // When the value is dashed, tap = retry the
                      // dashboard summary fetch (covers stale-JWT cases
                      // where the tiles silently empty out). When the
                      // value is loaded, tap drills into Inventory
                      // Lookup as before.
                      onTap: () {
                        if (_inventoryUnits == null) {
                          unawaited(_refreshDashboardStats());
                        } else {
                          _pushGuarded(
                            ScreenIds.inventoryLookup,
                            (_) => const InventoryLookupScreen(),
                          );
                        }
                      },
                      cardColor: cardColor,
                      mainColor: mainColor,
                      mutedColor: mutedColor,
                    ),
                    SizedBox(width: 8.w),
                    _StatCard(
                      label: 'RECEIVING',
                      value: (_statsLoading && _receivingOpen == null)
                          ? '…'
                          : (_receivingOpen?.toString() ?? '0'),
                      onTap: () => _pushGuarded(
                        ScreenIds.transferInPending,
                        (_) => const TransferInPendingScreen(),
                      ),
                      cardColor: cardColor,
                      mainColor: mainColor,
                      mutedColor: mutedColor,
                    ),
                    SizedBox(width: 8.w),
                    // Item Lookup — icon-only quick box on the right.
                    GestureDetector(
                      onTap: () => _pushGuarded(
                        ScreenIds.inventoryLookup,
                        (_) => const InventoryLookupScreen(),
                      ),
                      child: Container(
                        width: 58.w,
                        height: 58.w,
                        decoration: BoxDecoration(
                          color: cardColor,
                          borderRadius: BorderRadius.circular(4.r),
                        ),
                        child: Icon(Icons.search,
                            size: 26.sp, color: mainColor),
                      ),
                    ),
                  ],
                ),
              ),
            ),


            // ── E. Hardware Pulse — 1×3 row, location-scoped counts.
            //   Each card shows total/online (e.g. "3/2") so the operator
            //   sees both fleet size and current health at a glance.
            //   "Handhelds" was dropped since handhelds are inherently
            //   per-device and not part of the fixed-hardware fleet.
            SliverToBoxAdapter(
              child: Padding(
                padding: EdgeInsets.fromLTRB(20.w, 14.h, 20.w, 0.h),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'HARDWARE PULSE',
                      style: GoogleFonts.spaceGrotesk(
                        fontSize: 12.sp,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 2.0,
                        color: mutedColor,
                      ),
                    ),
                    SizedBox(height: 12.h),
                    Row(
                      children: [
                        Expanded(
                          child: _PulseCard(
                            label: 'Readers',
                            value: _hwPulseValue(_hwReaders, _hwReadersOnline),
                            active: (_hwReadersOnline ?? 0) > 0,
                            noSource: _hwReaders == null,
                            cardColor: cardColor,
                            mainColor: mainColor,
                            mutedColor: mutedColor,
                          ),
                        ),
                        SizedBox(width: 8.w),
                        Expanded(
                          child: _PulseCard(
                            label: 'Antennas',
                            value: _hwPulseValue(_hwAntennas, _hwAntennasOnline),
                            active: (_hwAntennasOnline ?? 0) > 0,
                            noSource: _hwAntennas == null,
                            cardColor: cardColor,
                            mainColor: mainColor,
                            mutedColor: mutedColor,
                          ),
                        ),
                        SizedBox(width: 8.w),
                        Expanded(
                          child: _PulseCard(
                            label: 'Printers',
                            value: _hwPulseValue(_hwPrinters, _hwPrintersOnline),
                            active: (_hwPrintersOnline ?? 0) > 0,
                            noSource: _hwPrinters == null,
                            cardColor: cardColor,
                            mainColor: mainColor,
                            mutedColor: mutedColor,
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),

            // ── D. 2×2 Hero tile grid ─────────────────────────────────
            // Each tile owns a Phase 2 screen id; hidden ones drop out so
            // the grid reflows from 4 to N. Empty grid hides the section
            // entirely (rare — would require all four to be hidden).
            SliverPadding(
              padding: EdgeInsets.fromLTRB(20.w, 16.h, 20.w, 0.h),
              sliver: SliverToBoxAdapter(
                child: GridView.count(
                  shrinkWrap: true,
                  physics: const NeverScrollableScrollPhysics(),
                  crossAxisCount: 2,
                  mainAxisSpacing: 12,
                  crossAxisSpacing: 12,
                  childAspectRatio: 1,
                  children: <Widget>[
                    if (perms.canView(ScreenIds.inventoryHub))
                      _HeroTile(
                        icon: Icons.inventory_2_outlined,
                        label: 'Inventory',
                        teal: false,
                        cardColor: cardColor,
                        cardHigh: cardHigh,
                        mainColor: mainColor,
                        onTap: () => _pushScreen(CategoryHubScreen.inventory()),
                      ),
                    if (perms.canView(ScreenIds.fastPutaway) ||
                        perms.canView(ScreenIds.cleanBin) ||
                        perms.canView(ScreenIds.itemBinLookup))
                      _HeroTile(
                        icon: Icons.qr_code_scanner,
                        label: 'Bin Management',
                        teal: false,
                        highSurface: true,
                        cardColor: cardColor,
                        cardHigh: cardHigh,
                        mainColor: mainColor,
                        onTap: () => _pushScreen(CategoryHubScreen.binManagement()),
                      ),
                    if (perms.canView(ScreenIds.encode) ||
                        perms.canView(ScreenIds.encodeAndPrint) ||
                        perms.canView(ScreenIds.searchAndEncode) ||
                        perms.canView(ScreenIds.print) ||
                        perms.canView(ScreenIds.printNonRfid) ||
                        perms.canView(ScreenIds.statusChange))
                      _HeroTile(
                        icon: Icons.local_printshop_outlined,
                        label: 'Tags & Labels',
                        teal: true,
                        cardColor: cardColor,
                        cardHigh: cardHigh,
                        mainColor: mainColor,
                        onTap: () => _pushScreen(CategoryHubScreen.encodePrint()),
                      ),
                    if (perms.canView(ScreenIds.inventoryLookup) ||
                        perms.canView(ScreenIds.geigerSearch) ||
                        perms.canView(ScreenIds.cloudGeiger))
                      _HeroTile(
                        icon: Icons.radar,
                        label: 'Find & Locate',
                        teal: false,
                        cardColor: cardColor,
                        cardHigh: cardHigh,
                        mainColor: mainColor,
                        onTap: () => _pushScreen(CategoryHubScreen.findLocate()),
                      ),
                    if (perms.canView(ScreenIds.transferSlips) ||
                        perms.canView(ScreenIds.transferInPending))
                      _HeroTile(
                        icon: Icons.swap_horiz,
                        label: 'Transfers',
                        teal: true,
                        cardColor: cardColor,
                        cardHigh: cardHigh,
                        mainColor: mainColor,
                        onTap: () => _pushScreen(CategoryHubScreen.transfers()),
                      ),
                    if (perms.canView(ScreenIds.reportsHub))
                      _HeroTile(
                        icon: Icons.bar_chart_outlined,
                        label: 'Reports',
                        teal: false,
                        cardColor: cardColor,
                        cardHigh: cardHigh,
                        mainColor: mainColor,
                        onTap: () => _pushScreen(CategoryHubScreen.reports()),
                      ),
                  ],
                ),
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

  /// Hardware Pulse cell value. Mirrors the web dashboard's command-center
  /// PulsePill — single number representing currently-online devices at
  /// the session location. Em-dash while loading; '0' once the server
  /// answers with no online devices in that category.
  String _hwPulseValue(int? total, int? online) {
    if (online == null) {
      // No online figure yet — fall back to total if we have it.
      if (total == null) return _statsLoading ? '…' : '—';
      return total.toString();
    }
    return online.toString();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BOTTOM NAV
  // ═══════════════════════════════════════════════════════════════════════════
  Widget _buildBottomNav(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    const items = [
      (icon: Icons.dashboard, label: 'Dash'),
      (icon: Icons.menu_book_outlined, label: 'Catalog'),
      (icon: Icons.radar, label: 'Find'),
      (icon: Icons.local_offer_outlined, label: 'Tags'),
    ];

    return Container(
      height: 72.h + MediaQuery.of(context).padding.bottom,
      decoration: BoxDecoration(
        color: isDark ? const Color(0xFF1C2828) : Colors.white,
        border: Border(
            top: BorderSide(
                color: isDark ? Colors.white12 : const Color(0xFFEDF2F1),
                width: 1.w)),
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
                      EdgeInsets.symmetric(horizontal: 4.w, vertical: 8.h),
                  decoration: BoxDecoration(
                    color: active
                        ? (isDark
                            ? const Color(0xFF243030)
                            : _surfaceContainerHigh)
                        : Colors.transparent,
                    borderRadius: BorderRadius.circular(4.r),
                  ),
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(
                        item.icon,
                        size: 22.sp,
                        color: active ? AppColors.primary : AppColors.textMuted,
                      ),
                      SizedBox(height: 3.h),
                      Text(
                        item.label,
                        style: GoogleFonts.manrope(
                          fontSize: 12.sp,
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


class _StatCard extends StatelessWidget {
  const _StatCard({
    required this.label,
    required this.value,
    required this.cardColor,
    required this.mainColor,
    required this.mutedColor,
    this.onTap,
  });

  final String label;
  final String value;
  final Color cardColor;
  final Color mainColor;
  final Color mutedColor;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: GestureDetector(
        onTap: onTap,
        child: Container(
          padding: EdgeInsets.symmetric(horizontal: 10.w, vertical: 8.h),
          decoration: BoxDecoration(
              color: cardColor, borderRadius: BorderRadius.circular(4.r)),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(label,
                  style: GoogleFonts.spaceGrotesk(
                      fontSize: 11.sp,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 1.4,
                      color: mutedColor)),
              SizedBox(height: 2.h),
              Text(value,
                  style: GoogleFonts.manrope(
                      fontSize: 22.sp,
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
      borderRadius: BorderRadius.circular(2.r),
      clipBehavior: Clip.hardEdge,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(2.r),
        child: Stack(
          children: [
            Positioned(
              right: 8.w,
              bottom: 8.h,
              child: Icon(icon, size: 92.sp, color: watermarkColor),
            ),
            Padding(
              padding: EdgeInsets.fromLTRB(16.w, 16.h, 16.w, 28.h),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Icon(icon, size: 36.sp, color: fg),
                  Text(
                    label.toUpperCase(),
                    style: GoogleFonts.manrope(
                      fontSize: 16.sp,
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
      padding: EdgeInsets.symmetric(horizontal: 12.w, vertical: 8.h),
      decoration: BoxDecoration(
          color: cardColor, borderRadius: BorderRadius.circular(2.r)),
      child: Row(
        children: [
          Container(
            width: 7.w,
            height: 7.h,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: active
                  ? AppColors.primary
                  : mutedColor.withValues(alpha: 0.3),
            ),
          ),
          SizedBox(width: 10.w),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text(label.toUpperCase(),
                  style: GoogleFonts.spaceGrotesk(
                      fontSize: 11.sp,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 1.0,
                      color: mutedColor)),
              Text(value,
                  style: GoogleFonts.manrope(
                      fontSize: 15.sp,
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

