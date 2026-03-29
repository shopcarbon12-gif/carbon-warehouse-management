import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/dashboard_screen.dart';

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
        ChangeNotifierProvider<RfidManager>(
          create: (context) {
            final m = RfidManager(api: context.read<WmsApiClient>());
            Future.microtask(() => m.useChainway());
            return m;
          },
        ),
      ],
      child: MaterialApp(
        title: 'Carbon WMS',
        debugShowCheckedModeBanner: false,
        theme: AppTheme.dark,
        home: const DashboardScreen(),
      ),
    );
  }
}
