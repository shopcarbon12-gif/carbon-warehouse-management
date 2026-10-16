import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/locate_tag_screen.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart' show CarbonScaffold;
import 'package:carbon_wms/ui/widgets/item_line_format.dart';
import 'package:carbon_wms/ui/widgets/item_status_bin.dart';
import 'package:carbon_wms/ui/widgets/live_item_photo.dart';

/// One tag's page (owner, 2026-10-16): the product photo (read live from the
/// WMS), everything the WMS knows about this EPC, and GEIGER to find it.
///
/// Read fresh from the server on every open. For a tag the WMS has no record
/// of, [fallback] (e.g. a Zone Management "couldn't assign" row) fills in
/// what the number decodes to, and [reason] says why it couldn't be used.
class TagPageScreen extends StatefulWidget {
  const TagPageScreen({
    super.key,
    required this.epc,
    this.fallback,
    this.reason,
    this.fallbackSku,
    this.fallbackName,
  });

  final String epc;

  /// Zone Management details map (`/api/assigned-zones/check` shape).
  final Map<String, dynamic>? fallback;
  final String? reason;
  final String? fallbackSku;
  final String? fallbackName;

  @override
  State<TagPageScreen> createState() => _TagPageScreenState();
}

String _when(Object? iso) {
  if (iso is! String || iso.isEmpty) return '—';
  final t = DateTime.tryParse(iso)?.toLocal();
  if (t == null) return '—';
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  final h = t.hour % 12 == 0 ? 12 : t.hour % 12;
  return '${m[t.month - 1]} ${t.day}, ${t.year} $h:${t.minute.toString().padLeft(2, '0')} ${t.hour < 12 ? 'AM' : 'PM'}';
}

class _TagPageScreenState extends State<TagPageScreen> {
  Map<String, dynamic>? _item;
  bool _loading = true;
  bool _notInWms = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => unawaited(_load()));
  }

  Future<void> _load() async {
    final api = context.read<WmsApiClient>();
    try {
      final d = await api.fetchItemDetailByEpc(widget.epc);
      final item = d?['item'];
      if (!mounted) return;
      setState(() {
        _item = item is Map ? Map<String, dynamic>.from(item) : null;
        _notInWms = _item == null;
        _loading = false;
      });
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  String? _s(Object? v) {
    final t = v?.toString().trim() ?? '';
    return t.isEmpty ? null : t;
  }

  @override
  Widget build(BuildContext context) {
    final i = _item;
    final f = widget.fallback ?? const <String, dynamic>{};
    final sku = _s(i?['sku']) ?? _s(f['sku']) ?? widget.fallbackSku;
    final name = _s(i?['description']) ?? _s(f['product']) ?? widget.fallbackName;
    final color = _s(i?['color']) ?? _s(f['color']);
    final size = _s(i?['size']) ?? _s(f['size']);
    final price = _s(i?['retail_price']) ?? _s(f['retailPrice']);
    final status = _s(i?['status']) ?? _s(f['status']);
    final bin = _s(i?['bin_code']) ?? _s(f['bin']);
    final extra = (i?['extra_bin_codes'] is List)
        ? (i!['extra_bin_codes'] as List).map((e) => '$e').toList()
        : (f['extraBins'] is List ? (f['extraBins'] as List).map((e) => '$e').toList() : <String>[]);
    final zone = _s(i?['zone_name']) ?? _s(f['zone']);
    final rows = <List<String>>[
      if ((widget.reason ?? '').isNotEmpty) ['Why not', widget.reason!],
      ['EPC', widget.epc],
      ['Serial', _s(i?['serial_number']) ?? _s(f['serial']) ?? '—'],
      ['SKU', sku ?? '—'],
      ['Color · size', [color, size].whereType<String>().join(' · ').ifEmpty('—')],
      ['Price', price == null ? '—' : '\$$price'],
      ['Status', status == null ? (_notInWms ? 'Not in WMS' : '—') : itemStatusLabel(status)],
      ['Bin', bin == null ? (extra.isEmpty ? '—' : extra.join(', ')) : (extra.isEmpty ? formatBinCode(bin) : '${formatBinCode(bin)} (+ ${extra.join(', ')})')],
      ['Zone', zone == null ? '—' : '$zone${_s(i?['zone_assigned_at']) != null ? ' · since ${_when(i!['zone_assigned_at'])}' : ''}'],
      ['Location', _s(i?['location_name']) ?? _s(f['location']) ?? '—'],
      ['Last seen', '${_when(i?['last_seen_at'] ?? f['lastSeenAt'])}${(_s(i?['last_seen_reader_zone']) ?? _s(f['lastSeenReaderZone'])) != null ? ' · ${_s(i?['last_seen_reader_zone']) ?? _s(f['lastSeenReaderZone'])} reader' : ''}'],
      ['First seen', _when(i?['first_scanned_at'] ?? f['firstSeenAt'])],
      ['Source', _s(i?['source_device_name']) ?? _s(i?['source_device_label']) ?? _s(i?['source']) ?? _s(f['source']) ?? '—'],
    ];
    return CarbonScaffold(
      pageTitle: 'TAG',
      body: SafeArea(
        child: ListView(
          padding: EdgeInsets.all(16.w),
          children: [
            LiveItemPhoto(epc: widget.epc, sku: sku, height: 220, title: name),
            SizedBox(height: 12.h),
            Text(name ?? (_loading ? 'Loading…' : 'Unknown product'),
                style: GoogleFonts.manrope(fontSize: 18.sp, fontWeight: FontWeight.w800)),
            if (status != null) ...[
              SizedBox(height: 6.h),
              ItemStatusBinLine(status: status, bin: null, zone: zone),
            ],
            SizedBox(height: 12.h),
            for (final r in rows)
              Padding(
                padding: EdgeInsets.symmetric(vertical: 5.h),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox(
                      width: 100.w,
                      child: Text(r[0], style: TextStyle(color: AppColors.textMuted, fontSize: 12.5.sp)),
                    ),
                    Expanded(
                      child: SelectableText(
                        r[1],
                        style: TextStyle(
                          fontSize: 14.sp,
                          fontWeight: r[0] == 'Why not' ? FontWeight.w800 : FontWeight.w600,
                          color: r[0] == 'Why not' ? const Color(0xFFB45309) : AppColors.textMain,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            SizedBox(height: 16.h),
            FilledButton.icon(
              style: FilledButton.styleFrom(
                backgroundColor: AppColors.primary,
                minimumSize: Size(double.infinity, 54.h),
                shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
              ),
              icon: const Icon(Icons.radar_outlined),
              label: const Text('GEIGER — FIND THIS TAG'),
              onPressed: () => Navigator.push(
                context,
                MaterialPageRoute<void>(
                  builder: (_) => LocateTagScreen(
                    targetEpc: widget.epc,
                    targetSku: sku,
                    targetName: name,
                    targetColor: color,
                    targetSize: size,
                    targetBin: bin,
                  ),
                ),
              ),
            ),
            SizedBox(height: 8.h),
            OutlinedButton.icon(
              style: OutlinedButton.styleFrom(
                minimumSize: Size(double.infinity, 48.h),
                shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
              ),
              icon: const Icon(Icons.copy_outlined),
              label: const Text('COPY EPC'),
              onPressed: () {
                unawaited(Clipboard.setData(ClipboardData(text: widget.epc)));
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('EPC copied'), duration: Duration(seconds: 1)),
                );
              },
            ),
          ],
        ),
      ),
    );
  }
}

extension on String {
  String ifEmpty(String other) => isEmpty ? other : this;
}
