import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/mobile_settings_repository.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/dashboard_screen.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('dashboard loads (smoke)', (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues({});

    await tester.pumpWidget(
      MultiProvider(
        providers: [
          Provider<WmsApiClient>(create: (_) => WmsApiClient()),
          ChangeNotifierProvider<MobileSettingsRepository>(
            create: (_) => MobileSettingsRepository()..loadFromPrefs(),
          ),
          ChangeNotifierProvider<RfidManager>(
            create: (context) => RfidManager(
              api: context.read<WmsApiClient>(),
              settings: context.read<MobileSettingsRepository>(),
            ),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: const DashboardScreen(),
        ),
      ),
    );
    // Avoid pumpAndSettle: root app uses a spinning boot indicator; dashboard has sliders.
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('MODULES'), findsOneWidget);
  });
}
