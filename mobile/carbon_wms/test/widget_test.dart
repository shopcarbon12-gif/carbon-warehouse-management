import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/live_catalog_cache.dart';
import 'package:carbon_wms/services/mobile_permissions.dart';
import 'package:carbon_wms/services/mobile_settings_repository.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/dashboard_screen.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('dashboard loads (smoke)', (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues({});
    // A phone, not the default 800×600 test window: the app's design size
    // (Samsung S25 Ultra, portrait) so ScreenUtil scales 1:1.
    tester.view.physicalSize = const Size(412, 917);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    // Same providers and ScreenUtilInit as main.dart (CarbonWmsRoot): the
    // theme sizes its text with ScreenUtil, so it must be built inside
    // ScreenUtilInit's builder, exactly like the app does.
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          Provider<WmsApiClient>(create: (_) => WmsApiClient()),
          ChangeNotifierProvider<LiveCatalogCache>(
            create: (context) => LiveCatalogCache(api: context.read<WmsApiClient>()),
          ),
          ChangeNotifierProvider<MobileSettingsRepository>(
            create: (_) => MobileSettingsRepository()..loadFromPrefs(),
          ),
          ChangeNotifierProvider<MobilePermissions>(
            create: (_) => MobilePermissions()..loadCached(),
          ),
          ChangeNotifierProvider<RfidManager>(
            create: (context) => RfidManager(
              api: context.read<WmsApiClient>(),
              settings: context.read<MobileSettingsRepository>(),
            ),
          ),
        ],
        child: ScreenUtilInit(
          designSize: const Size(412, 917),
          minTextAdapt: true,
          splitScreenMode: false,
          builder: (_, __) => MaterialApp(
            theme: AppTheme.light,
            home: const DashboardScreen(),
          ),
        ),
      ),
    );
    // Avoid pumpAndSettle: root app uses a spinning boot indicator; dashboard has sliders.
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    // The stat + hardware cards at the top (the "MODULES" heading went with
    // the 2026-04 redesign).
    expect(find.text('RECEIVING'), findsOneWidget);
    expect(find.text('READERS'), findsOneWidget);
  });
}
