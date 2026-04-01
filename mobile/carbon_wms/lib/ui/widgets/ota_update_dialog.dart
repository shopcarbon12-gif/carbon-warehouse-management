import 'package:flutter/material.dart';
import 'package:package_info_plus/package_info_plus.dart';

/// OTA prompt: shows **current** app version vs **server** release label; **Install** or **Close** (same install flow as before).
Future<void> showCarbonWmsOtaDialog({
  required BuildContext context,
  required String downloadUrl,
  String? latestVersion,
  VoidCallback? onAnyClose,
  required Future<void> Function(String url) onInstallChosen,
}) async {
  final pkg = await PackageInfo.fromPlatform();
  if (!context.mounted) return;

  final label = latestVersion?.trim();
  final installed = '${pkg.version} (${pkg.buildNumber})';

  final body = (label != null && label.isNotEmpty)
      ? 'A new CarbonWMS release is available.\n\n'
          'New release: $label\n'
          'This device: $installed\n\n'
          'Tap Install to download and run the Android installer, or Close to stay on this version. '
          'You can install later from the dashboard download icon.'
      : 'A newer CarbonWMS build is published.\n\n'
          'This device: $installed\n\n'
          'Tap Install to download and run the Android installer, or Close to stay on this version. '
          'You can install later from the dashboard download icon.';

  return showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (ctx) => AlertDialog(
      title: Text(
        (label != null && label.isNotEmpty) ? 'New release: $label' : 'Update available',
      ),
      content: Text(body),
      actions: [
        TextButton(
          onPressed: () {
            onAnyClose?.call();
            Navigator.of(ctx).pop();
          },
          child: const Text('Close'),
        ),
        FilledButton(
          onPressed: () async {
            onAnyClose?.call();
            Navigator.of(ctx).pop();
            await onInstallChosen(downloadUrl);
          },
          child: const Text('Install'),
        ),
      ],
    ),
  );
}
