import 'package:flutter/material.dart';

/// OTA prompt: announces optional [latestVersion], **Install** or **Close** (same install flow as before).
Future<void> showCarbonWmsOtaDialog({
  required BuildContext context,
  required String downloadUrl,
  String? latestVersion,
  VoidCallback? onAnyClose,
  required Future<void> Function(String url) onInstallChosen,
}) {
  final label = latestVersion?.trim();
  final body = (label != null && label.isNotEmpty)
      ? 'A new CarbonWMS release is available: $label\n\n'
          'Install now, or close and update later from the header icon.'
      : 'A newer CarbonWMS build is published.\n\n'
          'Install now, or close and update later from the header icon.';

  return showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (ctx) => AlertDialog(
      title: const Text('Update available'),
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
