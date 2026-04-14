import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/mobile_settings_repository.dart';
import 'package:carbon_wms/services/theme_notifier.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/app_auth_gate.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
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
  runApp(const CarbonWmsRoot());
}

class CarbonWmsRoot extends StatefulWidget {
  const CarbonWmsRoot({super.key});

  @override
  State<CarbonWmsRoot> createState() => _CarbonWmsRootState();
}

class _CarbonWmsRootState extends State<CarbonWmsRoot> {
  final _themeNotifier = ThemeNotifier();

  @override
  void initState() {
    super.initState();
    _themeNotifier.load();
  }

  @override
  void dispose() {
    _themeNotifier.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        Provider<WmsApiClient>(create: (_) => WmsApiClient()),
        ChangeNotifierProvider<MobileSettingsRepository>(
          create: (_) => MobileSettingsRepository()..loadFromPrefs(),
        ),
        ChangeNotifierProvider<RfidManager>(
          create: (context) {
            return RfidManager(
              api: context.read<WmsApiClient>(),
              settings: context.read<MobileSettingsRepository>(),
            );
          },
        ),
        ChangeNotifierProvider<ThemeNotifier>.value(value: _themeNotifier),
      ],
      child: Consumer<ThemeNotifier>(
        builder: (_, notifier, __) => MaterialApp(
          title: 'CarbonWMS',
          debugShowCheckedModeBanner: false,
          theme: AppTheme.light,
          darkTheme: AppTheme.dark,
          themeMode: notifier.mode,
          home: const AppAuthGate(),
        ),
      ),
    );
  }
}
