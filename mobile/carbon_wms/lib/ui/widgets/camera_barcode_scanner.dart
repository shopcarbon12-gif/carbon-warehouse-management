import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

/// Full-screen camera barcode/QR scan. Returns first non-empty [Barcode.rawValue], or null if closed.
Future<String?> openCameraBarcodeScanner(
  BuildContext context, {
  required String title,
}) async {
  if (kIsWeb) {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Camera scanning is not available on web.')),
    );
    return null;
  }
  return Navigator.of(context).push<String>(
    MaterialPageRoute<String>(
      fullscreenDialog: true,
      builder: (ctx) => _CameraBarcodePage(title: title),
    ),
  );
}

class _CameraBarcodePage extends StatefulWidget {
  const _CameraBarcodePage({required this.title});

  final String title;

  @override
  State<_CameraBarcodePage> createState() => _CameraBarcodePageState();
}

class _CameraBarcodePageState extends State<_CameraBarcodePage> {
  bool _handled = false;

  void _onDetect(BarcodeCapture capture) {
    if (_handled || !mounted) return;
    for (final b in capture.barcodes) {
      final v = b.rawValue;
      if (v != null && v.trim().isNotEmpty) {
        _handled = true;
        Navigator.of(context).pop<String>(v.trim());
        return;
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: null,
      body: Stack(
        children: [
          MobileScanner(
            onDetect: _onDetect,
            // The scan page has no AppBar, so without a graceful error path an
            // operator who denies the camera prompt (common on a fresh
            // Android 13+ / Galaxy S25 first run) would be stranded on the
            // plugin's default error with no obvious way out. Show a clear
            // message and a Close button instead.
            errorBuilder: (context, error) => _CameraError(
              onClose: () => Navigator.of(context).maybePop(),
            ),
          ),
          Positioned(
            left: 0.w,
            right: 0.w,
            top: 0.h,
            child: Container(
              color: Colors.black,
              padding: EdgeInsets.fromLTRB(16.w, 40.h, 8.w, 24.h),
              child: Row(
                children: [
                  // Balances the trailing close button so the title stays centred.
                  SizedBox(width: 44.w),
                  Expanded(
                    child: Text(
                      widget.title,
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        color: Colors.white,
                        fontSize: 20.sp,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 0.5,
                      ),
                    ),
                  ),
                  SizedBox(
                    width: 44.w,
                    child: IconButton(
                      onPressed: () => Navigator.of(context).maybePop(),
                      icon: Icon(Icons.close, color: Colors.white, size: 24.sp),
                      tooltip: 'Close',
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Shown when the camera can't start (permission denied / unavailable). Gives
/// the operator a clear reason and a way back — the scan page has no AppBar.
class _CameraError extends StatelessWidget {
  const _CameraError({required this.onClose});

  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: Colors.black,
      alignment: Alignment.center,
      padding: EdgeInsets.all(28.w),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.no_photography_outlined, color: Colors.white, size: 48.sp),
          SizedBox(height: 16.h),
          Text(
            'Camera unavailable',
            textAlign: TextAlign.center,
            style: TextStyle(
              color: Colors.white,
              fontSize: 18.sp,
              fontWeight: FontWeight.w800,
            ),
          ),
          SizedBox(height: 10.h),
          Text(
            'Allow camera access for Carbon WMS in Settings, '
            'then reopen the scanner. You can still type or use the '
            'hardware scanner meanwhile.',
            textAlign: TextAlign.center,
            style: TextStyle(
              color: Colors.white70,
              fontSize: 14.sp,
              fontWeight: FontWeight.w500,
              height: 1.3,
            ),
          ),
          SizedBox(height: 22.h),
          OutlinedButton(
            onPressed: onClose,
            style: OutlinedButton.styleFrom(
              foregroundColor: Colors.white,
              side: const BorderSide(color: Colors.white54),
              padding: EdgeInsets.symmetric(horizontal: 28.w, vertical: 12.h),
            ),
            child: const Text('CLOSE'),
          ),
        ],
      ),
    );
  }
}
