import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/epc/epc_codec.dart';
import 'package:carbon_wms/services/handheld_device_identity.dart';
import 'package:carbon_wms/services/mobile_permissions.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/guards/permission_guard.dart';
import 'package:carbon_wms/ui/screens/locate_tag_screen.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart' show CarbonScaffold;

/// Cloud + Geiger — landing pad for EPCs that were "Sent to handheld" from
/// the web defective-EPCs drawer. Each EPC renders as a count-style
/// container (mirrors encode-screen visual): if the EPC passes the Carbon
/// formula we show the decoded SKU + description (enriched via
/// /epc-lookup); otherwise we show the raw EPC. The trash slot is replaced
/// with a Geiger (radio) icon — tapping it pushes [LocateTagScreen] in
/// `cloudGeigerMode: true` so the operator can range-find that specific tag.
///
/// Slide a container left to reveal a red delete affordance (Dismissible),
/// matching the count screen pattern. Persistence: list state lives on the
/// server — entries stay until the operator explicitly slide-deletes or
/// marks complete (server hides the row from subsequent polls).
class CloudGeigerScreen extends StatefulWidget {
  const CloudGeigerScreen({super.key});

  @override
  State<CloudGeigerScreen> createState() => _CloudGeigerScreenState();
}

const Color _kCardGrey = Color(0xFFECECEC);
const Color _kTrashRed = Color(0xFFBF2E2E);
const Color _kTextMuted = Color(0xFF8A9090);

class _CloudGeigerScreenState extends State<CloudGeigerScreen> {
  static const Duration _pollInterval = Duration(seconds: 8);

  final List<_GeigerItem> _items = <_GeigerItem>[];
  final Set<String> _seenEpcs = <String>{};

  Timer? _poller;
  bool _loading = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      unawaited(_pollOnce());
    });
    _poller = Timer.periodic(_pollInterval, (_) => unawaited(_pollOnce()));
  }

  @override
  void dispose() {
    _poller?.cancel();
    _poller = null;
    super.dispose();
  }

  Future<void> _pollOnce() async {
    if (!mounted || _loading) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final api = context.read<WmsApiClient>();
      final deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
      final result = await api.pollMyEpcQueue(deviceId: deviceId);
      if (!mounted) return;

      final fresh = <String>[];
      for (final raw in result.epcs) {
        final e = raw.trim().toUpperCase();
        if (e.isEmpty) continue;
        if (_seenEpcs.add(e)) {
          fresh.add(e);
          _items.add(_GeigerItem.bare(e));
        }
      }
      if (fresh.isNotEmpty) {
        unawaited(_enrich(fresh));
      }
      setState(() {});
    } on WmsApiException catch (e) {
      if (!mounted) return;
      setState(() => _error = 'HTTP ${e.statusCode}');
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _enrich(List<String> epcs) async {
    try {
      final api = context.read<WmsApiClient>();
      final rows = await api.lookupEpcs(epcs);
      if (!mounted) return;
      final byEpc = <String, Map<String, dynamic>>{};
      for (final r in rows) {
        final e = (r['epc'] as String?)?.trim().toUpperCase();
        if (e == null || e.isEmpty) continue;
        byEpc[e] = r;
      }
      setState(() {
        for (var i = 0; i < _items.length; i++) {
          final it = _items[i];
          final r = byEpc[it.epc];
          if (r == null) continue;
          _items[i] = it.withResolved(r);
        }
      });
    } catch (_) {
      /* enrichment best-effort; raw EPC still renders */
    }
  }

  void _removeItem(_GeigerItem item) {
    setState(() {
      _items.removeWhere((e) => e.epc == item.epc);
      _seenEpcs.remove(item.epc);
    });
  }

  Future<void> _openGeiger(_GeigerItem item) async {
    await context.pushGuarded<void>(
      ScreenIds.locateTag,
      (_) => LocateTagScreen(
        targetEpc: item.epc,
        cloudGeigerMode: true,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      pageTitle: 'cloud + geiger',
      actions: [
        IconButton(
          onPressed: _loading ? null : () => unawaited(_pollOnce()),
          icon: const Icon(Icons.refresh),
          tooltip: 'Refresh',
        ),
      ],
      body: ColoredBox(
        color: Colors.white,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (_error != null)
              Container(
                width: double.infinity,
                color: const Color(0xFFFFF4F4),
                padding: EdgeInsets.symmetric(horizontal: 16.w, vertical: 8.h),
                child: Text(
                  _error!,
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 12.sp,
                    fontWeight: FontWeight.w700,
                    color: const Color(0xFFD9534F),
                  ),
                ),
              ),
            Expanded(
              child: _items.isEmpty ? _buildEmpty() : _buildList(),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildEmpty() {
    return Center(
      child: Padding(
        padding: EdgeInsets.symmetric(horizontal: 24.w),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(LucideIcons.radio, size: 48.sp, color: _kTextMuted),
            SizedBox(height: 12.h),
            Text(
              'Waiting for EPCs from the cloud',
              textAlign: TextAlign.center,
              style: GoogleFonts.spaceGrotesk(
                fontSize: 18.sp,
                fontWeight: FontWeight.w800,
                color: AppColors.textMain,
              ),
            ),
            SizedBox(height: 6.h),
            Text(
              'Use “Send to handheld” on the web defective-EPCs table to push tags here.',
              textAlign: TextAlign.center,
              style: GoogleFonts.spaceGrotesk(
                fontSize: 13.sp,
                color: _kTextMuted,
                height: 1.35,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildList() {
    return ListView.separated(
      padding: EdgeInsets.fromLTRB(20.w, 12.h, 20.w, 16.h),
      itemCount: _items.length,
      separatorBuilder: (_, __) => SizedBox(height: 12.h),
      itemBuilder: (_, i) {
        final item = _items[i];
        return Dismissible(
          key: ValueKey<String>('geiger-${item.epc}'),
          direction: DismissDirection.endToStart,
          background: Container(
            alignment: Alignment.centerRight,
            padding: EdgeInsets.symmetric(horizontal: 18.w),
            color: _kTrashRed,
            child: Icon(Icons.delete_outline,
                color: Colors.white, size: 26.sp),
          ),
          onDismissed: (_) => _removeItem(item),
          child: _GeigerItemContainer(
            item: item,
            onGeigerTap: () => _openGeiger(item),
          ),
        );
      },
    );
  }
}

/// In-memory row backing a single Cloud+Geiger container. Decoded SKU/desc
/// is best-effort — when the EPC is foreign or enrichment hasn't landed yet,
/// the container falls back to the raw EPC string.
class _GeigerItem {
  const _GeigerItem({
    required this.epc,
    required this.formulaOk,
    this.sku,
    this.itemName,
    this.color,
    this.size,
  });

  factory _GeigerItem.bare(String epc) {
    final formulaOk = isCurrentFormat(epc);
    return _GeigerItem(epc: epc, formulaOk: formulaOk);
  }

  final String epc;
  final bool formulaOk;
  final String? sku;
  final String? itemName;
  final String? color;
  final String? size;

  _GeigerItem withResolved(Map<String, dynamic> row) {
    String? s(String k) {
      final v = row[k];
      if (v == null) return null;
      final str = v.toString().trim();
      return str.isEmpty ? null : str;
    }
    return _GeigerItem(
      epc: epc,
      formulaOk: formulaOk,
      sku: s('sku') ?? s('custom_sku'),
      itemName: s('name') ?? s('item_name'),
      color: s('color'),
      size: s('size'),
    );
  }
}

class _GeigerItemContainer extends StatelessWidget {
  const _GeigerItemContainer({
    required this.item,
    required this.onGeigerTap,
  });

  final _GeigerItem item;
  final VoidCallback onGeigerTap;

  String _primaryLine() {
    if (item.formulaOk && (item.sku ?? '').isNotEmpty) {
      return 'SKU: ${item.sku}';
    }
    return item.epc;
  }

  String _secondaryLine() {
    if (!item.formulaOk) return 'Foreign EPC / no Carbon prefix';
    final parts = <String>[
      if ((item.itemName ?? '').isNotEmpty) item.itemName!,
      if ((item.color ?? '').isNotEmpty) item.color!,
      if ((item.size ?? '').isNotEmpty) item.size!,
    ];
    if (parts.isEmpty) return 'Resolving…';
    return parts.join(' · ').toUpperCase();
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      color: _kCardGrey,
      child: IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Container(width: 4, color: AppColors.primary),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      _primaryLine(),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.w700,
                        color: Color(0xFF171D1D),
                        fontFamily: 'monospace',
                        height: 1.2,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      _secondaryLine(),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w700,
                        color: item.formulaOk
                            ? AppColors.textMain
                            : _kTextMuted,
                        height: 1.2,
                      ),
                    ),
                  ],
                ),
              ),
            ),
            GestureDetector(
              onTap: onGeigerTap,
              behavior: HitTestBehavior.opaque,
              child: Container(
                width: 56,
                alignment: Alignment.center,
                color: AppColors.primary,
                child: const Icon(
                  LucideIcons.radio,
                  size: 26,
                  color: Colors.white,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
