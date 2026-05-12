import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/add_on_session_state.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/add_on_epc_card.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart' show CarbonScaffold;

/// Review screen for an Add-On Count session.
///
/// One container per EPC — no grouping, no per-SKU quantity. Each tag stays
/// separate so the operator confirms exactly what they scanned.
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
    this.failedEntries = const [],
  });

  final String sessionId;
  final String sourceType;
  final String sourceId;
  final String sourceSlip;
  final List<NewEpcEntry> newEntries;
  // Defective EPCs scanned this session (failed Carbon EPC formula). Not
  // rendered as cards — only the count is shown next to the new-EPC count.
  // The server already has them in add_on_sessions.failed_ledger (we POST
  // each with validationFailed=true during scan); scan-finalize pulls
  // failed_ledger and emits a "Defective" sheet on SAVE / threads them
  // through the defective-CSV pipeline on UPLOAD.
  final List<FailedEpcEntry> failedEntries;

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
    final entries = widget.newEntries;
    return CarbonScaffold(
      pageTitle: 'review',
      body: ColoredBox(
        color: Colors.white,
        child: Column(
          children: [
            Padding(
              padding: EdgeInsets.fromLTRB(20.w, 12.h, 20.w, 6.h),
              child: Row(
                children: [
                  Text(
                    '${entries.length} new EPCs',
                    style: GoogleFonts.manrope(
                      fontSize: 13.sp,
                      fontWeight: FontWeight.w700,
                      color: AppColors.textMain,
                    ),
                  ),
                  if (widget.failedEntries.isNotEmpty) ...[
                    SizedBox(width: 8.w),
                    Container(
                      padding: EdgeInsets.symmetric(horizontal: 8.w, vertical: 2.h),
                      decoration: BoxDecoration(
                        color: const Color(0xFFFDECEA),
                        border: Border.all(color: const Color(0xFFD9534F)),
                        borderRadius: BorderRadius.circular(2.r),
                      ),
                      child: Text(
                        '${widget.failedEntries.length} defective',
                        style: GoogleFonts.spaceGrotesk(
                          fontSize: 10.sp,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 0.6,
                          color: const Color(0xFFD9534F),
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
            Expanded(
              child: entries.isEmpty
                  ? Center(
                      child: Text(
                        'No new EPCs to review',
                        style: GoogleFonts.manrope(color: AppColors.textMuted),
                      ),
                    )
                  : ListView.separated(
                      padding: EdgeInsets.fromLTRB(16.w, 8.h, 16.w, 8.h),
                      itemCount: entries.length,
                      separatorBuilder: (_, __) => SizedBox(height: 8.h),
                      itemBuilder: (_, i) => AddOnEpcCard(entry: entries[i]),
                    ),
            ),
            _ActionBar(busy: _busy, onSave: () => _finalize('save'), onUpload: () => _finalize('upload')),
          ],
        ),
      ),
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
