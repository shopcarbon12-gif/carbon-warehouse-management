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
          MobileScanner(onDetect: _onDetect),
          Positioned(
            left: 0.w,
            right: 0.w,
            top: 0.h,
            child: Container(
              color: Colors.black,
              padding: EdgeInsets.fromLTRB(16.w, 40.h, 16.w, 24.h),
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
          ),
        ],
      ),
    );
  }
}
