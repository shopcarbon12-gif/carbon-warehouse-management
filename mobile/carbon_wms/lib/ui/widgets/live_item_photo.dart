// Product photo read LIVE from the WMS each time a screen opens (owner,
// 2026-10-16: "all pics must sync live from WMS to the mobile app — if I
// click a line in any mode a picture is part of the following screen").
//
// The URL is asked for on every open — by EPC (item detail) first, then by
// SKU (catalog row) — never taken from a copy the phone kept, so a photo
// changed in the WMS / Studio shows the next time a line is tapped.

import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/theme/app_theme.dart';

class LiveItemPhoto extends StatefulWidget {
  const LiveItemPhoto({super.key, this.epc, this.sku, this.height = 160, this.title});

  final String? epc;
  final String? sku;
  final double height;

  /// Shown above the enlarged photo.
  final String? title;

  @override
  State<LiveItemPhoto> createState() => _LiveItemPhotoState();
}

class _LiveItemPhotoState extends State<LiveItemPhoto> {
  String? _url;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  @override
  void didUpdateWidget(covariant LiveItemPhoto oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.epc != widget.epc || oldWidget.sku != widget.sku) _load();
  }

  Future<void> _load() async {
    if (!mounted) return;
    final api = context.read<WmsApiClient>();
    setState(() => _loading = true);
    String? url;
    final epc = (widget.epc ?? '').trim();
    final sku = (widget.sku ?? '').trim();
    try {
      if (epc.length == 24) {
        final d = await api.fetchItemDetailByEpc(epc);
        final item = d?['item'];
        if (item is Map) url = item['shopify_image_url']?.toString();
      }
      if ((url == null || url.isEmpty) && sku.isNotEmpty) {
        final row = await api.catalogGridSearchFirstRow(sku);
        url = row?['shopify_image_url']?.toString();
      }
    } catch (_) {/* offline — placeholder */}
    if (!mounted) return;
    setState(() {
      _url = (url ?? '').trim().isEmpty ? null : url!.trim();
      _loading = false;
    });
  }

  void _enlarge() {
    final url = _url;
    if (url == null) return;
    showDialog<void>(
      context: context,
      builder: (ctx) => Dialog(
        insetPadding: EdgeInsets.all(12.w),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if ((widget.title ?? '').isNotEmpty)
              Padding(
                padding: EdgeInsets.all(12.w),
                child: Text(widget.title!, style: TextStyle(fontWeight: FontWeight.w700, fontSize: 14.sp)),
              ),
            InteractiveViewer(child: Image.network(url, fit: BoxFit.contain)),
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('CLOSE')),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final h = widget.height.h;
    final box = BoxDecoration(color: Colors.white, border: Border.all(color: AppColors.border));
    if (_loading && _url == null) {
      return Container(
        height: h,
        decoration: box,
        alignment: Alignment.center,
        child: const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2)),
      );
    }
    if (_url == null) {
      return Container(
        height: h,
        decoration: box,
        alignment: Alignment.center,
        child: Icon(Icons.image_outlined, size: 48.sp, color: AppColors.textMuted),
      );
    }
    return GestureDetector(
      onTap: _enlarge,
      child: Container(
        height: h,
        decoration: box,
        clipBehavior: Clip.antiAlias,
        child: Image.network(
          _url!,
          fit: BoxFit.contain,
          loadingBuilder: (ctx, child, p) =>
              p == null ? child : const Center(child: CircularProgressIndicator(strokeWidth: 2)),
          errorBuilder: (ctx, e, st) => Icon(Icons.broken_image_outlined, size: 48.sp, color: AppColors.textMuted),
        ),
      ),
    );
  }
}
