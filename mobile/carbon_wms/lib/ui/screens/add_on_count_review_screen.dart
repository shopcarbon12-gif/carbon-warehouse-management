import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/add_on_session_state.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart' show CarbonScaffold;

/// Review screen for an Add-On Count session.
///
/// SAVE  → audit only. POST /api/handheld/scan-finalize { intent: 'save' }.
/// UPLOAD → audit + per-EPC ingest + defective CSV. Server validates each EPC,
///          tag-kills failures, creates new items rows for valid never-seen
///          EPCs (Q9 lock).
class AddOnCountReviewScreen extends StatefulWidget {
  const AddOnCountReviewScreen({
    super.key,
    required this.sessionId,
    required this.sourceType,
    required this.sourceId,
    required this.sourceSlip,
    required this.newEntries,
  });

  final String sessionId;
  final String sourceType;
  final String sourceId;
  final String sourceSlip;
  final List<NewEpcEntry> newEntries;

  @override
  State<AddOnCountReviewScreen> createState() => _AddOnCountReviewScreenState();
}

class _AddOnCountReviewScreenState extends State<AddOnCountReviewScreen> {
  bool _busy = false;

  Future<void> _finalize(String intent) async {
    if (_busy) return;
    setState(() => _busy = true);
    final api = context.read<WmsApiClient>();
    try {
      final rows = widget.newEntries.map((e) => e.toFinalizeRow()).toList();
      final result = await api.postScanFinalize(
        intent: intent,
        screen: 'add_on_count',
        rows: rows,
        addOnSourceType: widget.sourceType,
        addOnSourceId: widget.sourceId,
        addOnSessionId: widget.sessionId,
      );
      if (!mounted) return;
      _showResult(intent, result);
      Navigator.of(context).pop();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('$intent failed: $e')),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _showResult(String intent, Map<String, dynamic> result) {
    final valid = result['rowsValid'] ?? 0;
    final failed = result['rowsFailed'] ?? 0;
    final msg = intent == 'save'
        ? 'Saved ${result['rowsArchived'] ?? 0} rows to reports'
        : 'Uploaded · $valid live · $failed defective';
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  @override
  Widget build(BuildContext context) {
    final groups = _groupBySku(widget.newEntries);
    return CarbonScaffold(
      pageTitle: 'review',
      body: ColoredBox(
        color: Colors.white,
        child: Column(
          children: [
            Padding(
              padding: EdgeInsets.fromLTRB(20.w, 12.h, 20.w, 6.h),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  '${widget.newEntries.length} new EPCs · grouped by SKU',
                  style: GoogleFonts.manrope(
                    fontSize: 13.sp,
                    fontWeight: FontWeight.w700,
                    color: AppColors.textMain,
                  ),
                ),
              ),
            ),
            Expanded(
              child: ListView.separated(
                padding: EdgeInsets.fromLTRB(16.w, 8.h, 16.w, 8.h),
                itemCount: groups.length,
                separatorBuilder: (_, __) => Divider(height: 12.h),
                itemBuilder: (_, i) {
                  final g = groups[i];
                  return _GroupedRow(group: g);
                },
              ),
            ),
            _ActionBar(busy: _busy, onSave: () => _finalize('save'), onUpload: () => _finalize('upload')),
          ],
        ),
      ),
    );
  }

  static List<_SkuGroup> _groupBySku(List<NewEpcEntry> entries) {
    final map = <String, _SkuGroup>{};
    for (final e in entries) {
      final key = e.customSku ?? e.epc;
      final g = map.putIfAbsent(key, () => _SkuGroup(label: _labelFor(e), count: 0));
      g.count++;
    }
    return map.values.toList()..sort((a, b) => a.label.compareTo(b.label));
  }

  static String _labelFor(NewEpcEntry e) => [
        e.customSku,
        e.itemName,
        e.color,
        e.size,
      ].where((s) => s != null && s.toString().isNotEmpty).join(' · ');
}

class _SkuGroup {
  _SkuGroup({required this.label, required this.count});
  String label;
  int count;
}

class _GroupedRow extends StatelessWidget {
  const _GroupedRow({required this.group});
  final _SkuGroup group;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: Text(
            group.label.isEmpty ? '(unknown)' : group.label,
            style: GoogleFonts.manrope(
              fontSize: 12.sp,
              fontWeight: FontWeight.w700,
              color: AppColors.textMain,
            ),
          ),
        ),
        Text(
          '×${group.count}',
          style: GoogleFonts.spaceGrotesk(
            fontSize: 14.sp,
            fontWeight: FontWeight.w800,
            color: AppColors.primary,
          ),
        ),
      ],
    );
  }
}

class _ActionBar extends StatelessWidget {
  const _ActionBar({required this.busy, required this.onSave, required this.onUpload});
  final bool busy;
  final VoidCallback onSave;
  final VoidCallback onUpload;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(16.w, 8.h, 16.w, 16.h),
      child: Row(
        children: [
          Expanded(
            child: OutlinedButton(
              style: OutlinedButton.styleFrom(
                padding: EdgeInsets.symmetric(vertical: 16.h),
              ),
              onPressed: busy ? null : onSave,
              child: Text(
                'SAVE',
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 14.sp,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 1.4,
                ),
              ),
            ),
          ),
          SizedBox(width: 12.w),
          Expanded(
            child: ElevatedButton(
              style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.primary,
                padding: EdgeInsets.symmetric(vertical: 16.h),
              ),
              onPressed: busy ? null : onUpload,
              child: Text(
                'UPLOAD',
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 14.sp,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 1.4,
                  color: Colors.white,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
