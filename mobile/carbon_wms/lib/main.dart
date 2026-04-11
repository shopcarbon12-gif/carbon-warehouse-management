import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/mobile_settings_repository.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/app_auth_gate.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const CarbonWmsRoot());
}

class CarbonWmsRoot extends StatelessWidget {
  const CarbonWmsRoot({super.key});

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
      ],
      child: MaterialApp(
        title: 'CarbonWMS',
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light,
        home: const AppAuthGate(),
      ),
    );
  }
}
