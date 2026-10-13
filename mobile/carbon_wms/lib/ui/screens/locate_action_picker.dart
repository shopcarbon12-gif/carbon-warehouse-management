import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/services/mobile_permissions.dart';
import 'package:carbon_wms/services/scan_sounds.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/guards/permission_guard.dart';
import 'package:carbon_wms/ui/screens/encode_screen.dart';
import 'package:carbon_wms/ui/screens/search_and_encode_screen.dart';
import 'package:carbon_wms/ui/screens/status_change_screen.dart';

/// Cloud+Geiger "Take an action" sheet for Locate 2.0 (same choices as the
/// classic screen). Before navigating, the radio is handed off clean: Locate
/// stays in the stack, so its dispose() does not run and its single-EPC
/// filter / S0 / beep suppression would otherwise leak into the next screen.
void showLocateActionPicker(
  BuildContext context, {
  required String epc,
  required bool cloudGeigerMode,
  VoidCallback? onHandOff,
}) {
  Future<void> handOffRadio() async {
    onHandOff?.call();
    try {
      await RfidVendorChannel.nativeLocateStop();
    } catch (_) {}
    try {
      await RfidVendorChannel.stopChainwayInventory();
    } catch (_) {}
    try {
      await RfidVendorChannel.stopZebraInventory();
    } catch (_) {}
    try {
      await RfidVendorChannel.setEpcInventoryFilter(null);
    } catch (_) {}
    try {
      await RfidVendorChannel.setSingulationSession(useSessionZero: false);
    } catch (_) {}
    try {
      await ScanSounds.instance.setTagBeepSuppressed(false);
    } catch (_) {}
  }

  final perms = context.read<MobilePermissions>();
  final resolveEpc = cloudGeigerMode ? epc : null;

  showModalBottomSheet<void>(
    context: context,
    backgroundColor: Colors.white,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (sheetCtx) {
      Widget tile(IconData icon, String label, String screenId, WidgetBuilder builder) {
        return InkWell(
          onTap: () async {
            Navigator.of(sheetCtx).pop();
            await handOffRadio();
            if (!context.mounted) return;
            await context.pushGuarded<void>(screenId, builder);
          },
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 18),
            child: Row(
              children: [
                Icon(icon, size: 24, color: AppColors.primary),
                const SizedBox(width: 14),
                Text(
                  label,
                  style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: Color(0xFF171D1D)),
                ),
              ],
            ),
          ),
        );
      }

      return SafeArea(
        top: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 16, 20, 8),
              child: Text(
                'TAKE AN ACTION',
                style: TextStyle(fontSize: 13, fontWeight: FontWeight.w800, letterSpacing: 1.6, color: Color(0xFF6D7979)),
              ),
            ),
            if (perms.canView(ScreenIds.statusChange)) ...[
              const Divider(height: 1),
              tile(Icons.swap_horiz, 'Status change', ScreenIds.statusChange,
                  (_) => StatusChangeScreen(cloudGeigerResolveEpc: resolveEpc)),
            ],
            if (perms.canView(ScreenIds.encode)) ...[
              const Divider(height: 1),
              tile(Icons.tag, 'Encode', ScreenIds.encode, (_) => EncodeScreen(cloudGeigerResolveEpc: resolveEpc)),
            ],
            if (perms.canView(ScreenIds.searchAndEncode)) ...[
              const Divider(height: 1),
              tile(Icons.refresh, 'Re-encode', ScreenIds.searchAndEncode,
                  (_) => SearchAndEncodeScreen(cloudGeigerResolveEpc: resolveEpc)),
            ],
            const SizedBox(height: 8),
          ],
        ),
      );
    },
  );
}
