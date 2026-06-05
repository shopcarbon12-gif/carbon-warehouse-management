import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/add_on_session_realtime.dart';
import 'package:carbon_wms/services/scan_sounds.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/add_on_count_screen.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart' show CarbonScaffold;

/// Source-picker screen for Add-On Count.
///
/// Shows the 3 v1 source types (Q3/Q5 dropped Live Scan + Antenna Test):
///   - Mobile Count (M-NNNNN)
///   - Cycle Count  (C-NNNNN)
///   - CSV Import   (I-NNNNN)
///
/// Newest-first sort (Q28 lock). Hides completed rows by default — the gear
/// menu toggles them on. Tap a free row → starts a session and pushes the
/// scan screen. Tap a locked row → join-request flow (Phase 4b).
class AddOnCountSourcePickerScreen extends StatefulWidget {
  const AddOnCountSourcePickerScreen({super.key});

  @override
  State<AddOnCountSourcePickerScreen> createState() =>
      _AddOnCountSourcePickerScreenState();
}

class _AddOnCountSourcePickerScreenState
    extends State<AddOnCountSourcePickerScreen> {
  bool _loading = true;
  bool _includeCompleted = false;
  String? _error;
  List<Map<String, dynamic>> _rows = const [];
  // Logged-in operator's email, cached at mount. Used to detect "I'm the
  // owner of this locked row" so we can resume the session directly instead
  // of sending a join-request to ourselves (which deadlocks: the server
  // gates 'respond' on owner == requester, and the picker just sits on
  // "Waiting for owner" forever). See _onRowTap below.
  String? _currentUserEmail;

  @override
  void initState() {
    super.initState();
    _loadCurrentUserEmail();
    _refresh();
  }

  Future<void> _loadCurrentUserEmail() async {
    final api = context.read<WmsApiClient>();
    final email = await api.getSavedLoginEmail();
    if (!mounted) return;
    setState(() => _currentUserEmail = email?.toLowerCase().trim());
  }

  Future<void> _refresh() async {
    if (!mounted) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final api = context.read<WmsApiClient>();
      final rows = await api.listScanSources(includeCompleted: _includeCompleted);
      if (!mounted) return;
      setState(() {
        _rows = rows;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  Future<void> _onRowTap(Map<String, dynamic> row) async {
    final state = (row['state'] as String?) ?? 'free';
    if (state == 'completed') {
      // Q29 lock: super-admin only re-open. Picker offers the re-open path
      // to any user; the /reopen endpoint server-side gates on role and
      // returns 403 for non-super-admins. We surface the 403 as a
      // friendly snackbar so a regular operator sees what's going on.
      await _offerReopenCompleted(row);
      return;
    }
    if (state == 'in_use') {
      // Same-user resume: if the operator who locked this row is me, skip
      // the join-request dance and just walk back into the existing
      // session. Without this branch the server treats me as a stranger
      // asking for permission, and the picker hangs on "Waiting for owner"
      // because owner == me and I can't approve my own request from this
      // screen.
      final lockedBy =
          (row['locked_by_user_email'] as String?)?.toLowerCase().trim();
      final me = _currentUserEmail;
      if (lockedBy != null &&
          lockedBy.isNotEmpty &&
          me != null &&
          me.isNotEmpty &&
          lockedBy == me) {
        await _resumeOwnSession(row);
        return;
      }
      await _requestJoin(row);
      return;
    }

    // Free → start a session and push the scan screen.
    final api = context.read<WmsApiClient>();
    try {
      final session = await api.startAddOnSession(
        sourceType: row['source_type'] as String,
        sourceId: row['source_id'] as String,
        sourceSlip: row['slip'] as String,
      );
      final epcs = await api.getScanSourceEpcs(
        sourceType: row['source_type'] as String,
        sourceId: row['source_id'] as String,
      );
      if (!mounted) return;
      await Navigator.of(context).push<void>(
        MaterialPageRoute<void>(
          builder: (_) => AddOnCountScreen(
            sessionId: session['id'] as String,
            sourceType: row['source_type'] as String,
            sourceId: row['source_id'] as String,
            sourceSlip: row['slip'] as String,
            sourceEpcs: epcs,
          ),
        ),
      );
      // On return: refresh the picker so the row's new state shows.
      await _refresh();
    } catch (e) {
      _showSnackbar('Could not start session: $e');
    }
  }

  void _showSnackbar(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  /// Tap on a completed row → confirm + POST /reopen + navigate. The
  /// server gates on super-admin role; non-super-admins get a 403 here
  /// which we surface as a snackbar. EPC ledger + failed ledger are
  /// preserved server-side, so the operator walks into the scan screen
  /// with the prior session state intact and the counters resume.
  Future<void> _offerReopenCompleted(Map<String, dynamic> row) async {
    // "First L." name only — never the raw email (server provides *_user_name).
    final completedBy =
        (row['completed_by_user_name'] as String?) ?? 'another user';
    final completedAt = (row['completed_at'] as String?) ?? '';
    final slip = (row['slip'] as String?) ?? '—';
    final go = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Re-open completed count?'),
        content: Text(
          '$slip was completed by $completedBy on ${completedAt.substring(0, completedAt.length.clamp(0, 16))}.\n\n'
          'Re-opening lets you continue scanning. Super-admin only.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('CANCEL'),
          ),
          ElevatedButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('RE-OPEN'),
          ),
        ],
      ),
    );
    if (go != true || !mounted) return;

    final lockedSessionId = row['locked_session_id'] as String?;
    final api = context.read<WmsApiClient>();
    String? sessionIdToUse = lockedSessionId;

    // If the picker row doesn't carry a locked_session_id (sessions get
    // unlinked when finalize runs), we'd have nothing to re-open. Try the
    // start path instead — but the user explicitly asked for re-open, so
    // surface that with a snackbar and bail.
    if (sessionIdToUse == null || sessionIdToUse.isEmpty) {
      _showSnackbar('No session record for this count to re-open. Pull to refresh.');
      return;
    }

    try {
      await api.reopenAddOnSession(sessionIdToUse);
    } catch (e) {
      if (!mounted) return;
      // WmsApiException carries the HTTP status — 403 = not super admin.
      // Use the message body as fallback so the server's text shows.
      final msg = e.toString();
      if (msg.contains('403')) {
        _showSnackbar('Only super-admin can re-open a completed count.');
      } else {
        _showSnackbar('Re-open failed: $msg');
      }
      return;
    }

    if (!mounted) return;
    try {
      final epcs = await api.getScanSourceEpcs(
        sourceType: row['source_type'] as String,
        sourceId: row['source_id'] as String,
      );
      if (!mounted) return;
      await Navigator.of(context).push<void>(
        MaterialPageRoute<void>(
          builder: (_) => AddOnCountScreen(
            sessionId: sessionIdToUse!,
            sourceType: row['source_type'] as String,
            sourceId: row['source_id'] as String,
            sourceSlip: slip,
            sourceEpcs: epcs,
          ),
        ),
      );
      await _refresh();
    } catch (e) {
      _showSnackbar('Could not enter re-opened session: $e');
    }
  }

  /// Same operator who originally locked the row is back — walk directly
  /// into the existing session without any join-request round-trip. Mirrors
  /// the post-approval branch of [_requestJoin] (fetch source EPCs, push
  /// AddOnCountScreen with the locked_session_id) but no SSE dialog.
  Future<void> _resumeOwnSession(Map<String, dynamic> row) async {
    final api = context.read<WmsApiClient>();
    final lockedSessionId = row['locked_session_id'] as String?;
    if (lockedSessionId == null || lockedSessionId.isEmpty) {
      _showSnackbar('Cannot resume — session info unavailable. Pull to refresh.');
      return;
    }
    try {
      final epcs = await api.getScanSourceEpcs(
        sourceType: row['source_type'] as String,
        sourceId: row['source_id'] as String,
      );
      if (!mounted) return;
      await Navigator.of(context).push<void>(
        MaterialPageRoute<void>(
          builder: (_) => AddOnCountScreen(
            sessionId: lockedSessionId,
            sourceType: row['source_type'] as String,
            sourceId: row['source_id'] as String,
            sourceSlip: row['slip'] as String,
            sourceEpcs: epcs,
          ),
        ),
      );
      await _refresh();
    } catch (e) {
      _showSnackbar('Could not resume session: $e');
    }
  }

  /// In-use row → POST /join-request, open SSE on that session, await
  /// join_approved or join_declined response. On approve → push scan screen.
  Future<void> _requestJoin(Map<String, dynamic> row) async {
    final api = context.read<WmsApiClient>();
    final lockedSessionId = row['locked_session_id'] as String?;
    if (lockedSessionId == null || lockedSessionId.isEmpty) {
      _showSnackbar('Cannot join — session info unavailable. Pull to refresh.');
      return;
    }
    final sse = AddOnSessionRealtime(api: api, sessionId: lockedSessionId);
    final completer = Completer<bool>();
    final sub = sse.events.listen((ev) {
      if (ev.type == 'join_approved') {
        if (!completer.isCompleted) completer.complete(true);
      } else if (ev.type == 'join_declined') {
        if (!completer.isCompleted) completer.complete(false);
      }
    });
    unawaited(sse.start());
    try {
      await api.requestJoinAddOnSession(lockedSessionId);
    } catch (e) {
      _showSnackbar('Could not request join: $e');
      await sub.cancel();
      await sse.dispose();
      return;
    }

    if (!mounted) {
      await sub.cancel();
      await sse.dispose();
      return;
    }

    // Auto-pop the dialog when the SSE delivers a verdict.
    unawaited(completer.future.then((v) {
      if (!mounted) return;
      final nav = Navigator.of(context);
      if (nav.canPop()) nav.pop(v);
    }));

    final approved = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        title: const Text('Waiting for owner'),
        content: const Padding(
          padding: EdgeInsets.symmetric(vertical: 8),
          child: Row(children: [
            CircularProgressIndicator(),
            SizedBox(width: 16),
            Expanded(child: Text('Asking the current operator to approve…')),
          ]),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('CANCEL'),
          ),
        ],
      ),
    );

    await sub.cancel();
    await sse.dispose();

    if (approved != true) {
      ScanSounds.instance.play(ScanCue.error);
      _showSnackbar('Join declined or cancelled');
      return;
    }
    ScanSounds.instance.play(ScanCue.success);

    // Approval received — fetch source EPCs and navigate to the scan screen
    // using the existing session.
    try {
      final epcs = await api.getScanSourceEpcs(
        sourceType: row['source_type'] as String,
        sourceId: row['source_id'] as String,
      );
      if (!mounted) return;
      await Navigator.of(context).push<void>(
        MaterialPageRoute<void>(
          builder: (_) => AddOnCountScreen(
            sessionId: lockedSessionId,
            sourceType: row['source_type'] as String,
            sourceId: row['source_id'] as String,
            sourceSlip: row['slip'] as String,
            sourceEpcs: epcs,
          ),
        ),
      );
      await _refresh();
    } catch (e) {
      _showSnackbar('Could not join: $e');
    }
  }

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      pageTitle: 'add-on count',
      onRefreshFromDrawer: _refresh,
      body: ColoredBox(
        color: Colors.white,
        child: Column(
          children: [
            _Header(
              includeCompleted: _includeCompleted,
              onToggleCompleted: (v) {
                setState(() => _includeCompleted = v);
                _refresh();
              },
            ),
            Expanded(
              child: _loading
                  ? const Center(child: CircularProgressIndicator())
                  : _error != null
                      ? _ErrorView(error: _error!, onRetry: _refresh)
                      : _SourceList(rows: _rows, onTap: _onRowTap),
            ),
          ],
        ),
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.includeCompleted, required this.onToggleCompleted});

  final bool includeCompleted;
  final ValueChanged<bool> onToggleCompleted;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(20.w, 12.h, 20.w, 6.h),
      child: Row(
        children: [
          Expanded(
            child: Text(
              'Pick a source to add on to',
              style: GoogleFonts.manrope(
                fontSize: 14.sp,
                fontWeight: FontWeight.w700,
                color: AppColors.textMain,
              ),
            ),
          ),
          Switch(
            value: includeCompleted,
            onChanged: onToggleCompleted,
          ),
          SizedBox(width: 4.w),
          Text(
            'Show completed',
            style: GoogleFonts.manrope(fontSize: 12.sp, color: AppColors.textMuted),
          ),
        ],
      ),
    );
  }
}

class _SourceList extends StatelessWidget {
  const _SourceList({required this.rows, required this.onTap});

  final List<Map<String, dynamic>> rows;
  final void Function(Map<String, dynamic>) onTap;

  @override
  Widget build(BuildContext context) {
    if (rows.isEmpty) {
      return Center(
        child: Text(
          'No sources available',
          style: GoogleFonts.manrope(color: AppColors.textMuted),
        ),
      );
    }
    return ListView.separated(
      padding: EdgeInsets.fromLTRB(16.w, 14.h, 16.w, 28.h),
      itemCount: rows.length,
      separatorBuilder: (_, __) => SizedBox(height: 14.h),
      itemBuilder: (_, i) => _SourceTile(row: rows[i], onTap: () => onTap(rows[i])),
    );
  }
}

class _SourceTile extends StatelessWidget {
  const _SourceTile({required this.row, required this.onTap});

  final Map<String, dynamic> row;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final state = (row['state'] as String?) ?? 'free';
    final slip = (row['slip'] as String?) ?? '—';
    final type = (row['source_type'] as String?) ?? '';
    final uploadedAt = (row['uploaded_at'] as String?) ?? '';
    final rowCount = row['row_count'];
    final by = (row['uploaded_by_name'] as String?) ?? '';

    final bg = switch (state) {
      'in_use' => const Color(0xFFFFF1E0),
      'completed' => const Color(0xFFE8F5E9),
      _ => Colors.white,
    };
    final border = switch (state) {
      'in_use' => const Color(0xFFE5A65C),
      'completed' => const Color(0xFF66B26B),
      _ => const Color(0xFFE0E5E5),
    };

    return Material(
      color: bg,
      borderRadius: BorderRadius.circular(2.r),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(2.r),
        child: Container(
          decoration: BoxDecoration(
            border: Border.all(color: border),
            borderRadius: BorderRadius.circular(2.r),
          ),
          padding: EdgeInsets.fromLTRB(16.w, 18.h, 12.w, 18.h),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Text(
                          slip,
                          style: GoogleFonts.spaceGrotesk(
                            fontSize: 18.sp,
                            fontWeight: FontWeight.w800,
                            color: AppColors.textMain,
                          ),
                        ),
                        SizedBox(width: 8.w),
                        _TypeBadge(type: type),
                        if (state == 'completed') ...[
                          SizedBox(width: 6.w),
                          const Icon(Icons.check_circle,
                              size: 18, color: Color(0xFF66B26B)),
                        ],
                      ],
                    ),
                    SizedBox(height: 5.h),
                    Text(
                      _subtitleFor(state, uploadedAt, rowCount, by, row),
                      style: GoogleFonts.manrope(
                        fontSize: 14.sp,
                        fontWeight: FontWeight.w600,
                        color: const Color(0xFF3F4A4A),
                      ),
                    ),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right,
                  size: 26, color: Color(0xFF3F4A4A)),
            ],
          ),
        ),
      ),
    );
  }

  String _subtitleFor(String state, String at, dynamic rowCount, String by,
      Map<String, dynamic> row) {
    final dateStr = at.isEmpty ? '—' : at.substring(0, at.length.clamp(0, 16));
    if (state == 'in_use') {
      final lockedBy =
          (row['locked_by_user_name'] as String?) ?? 'another user';
      return 'In use by $lockedBy';
    }
    if (state == 'completed') {
      final completedAt = (row['completed_at'] as String?) ?? at;
      final completedBy =
          (row['completed_by_user_name'] as String?) ?? by;
      return 'Completed by $completedBy · ${completedAt.substring(0, completedAt.length.clamp(0, 16))}';
    }
    final live = rowCount is num ? '${rowCount.toInt()} EPCs' : '$rowCount EPCs';
    return '$dateStr · $live${by.isEmpty ? '' : ' · by $by'}';
  }
}

class _TypeBadge extends StatelessWidget {
  const _TypeBadge({required this.type});
  final String type;

  @override
  Widget build(BuildContext context) {
    final (label, color) = switch (type) {
      'mobile_count' => ('MOBILE COUNT', AppColors.slateAction),
      'cycle_count' => ('CYCLE COUNT', AppColors.primary),
      'csv_import' => ('CSV IMPORT', const Color(0xFF8E5BA6)),
      _ => (type.toUpperCase(), AppColors.textMuted),
    };
    return Container(
      padding: EdgeInsets.symmetric(horizontal: 6.w, vertical: 2.h),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        border: Border.all(color: color),
        borderRadius: BorderRadius.circular(2.r),
      ),
      child: Text(
        label,
        style: GoogleFonts.spaceGrotesk(
          fontSize: 9.sp,
          fontWeight: FontWeight.w800,
          letterSpacing: 0.6,
          color: color,
        ),
      ),
    );
  }
}

class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.error, required this.onRetry});
  final String error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.cloud_off, size: 48, color: AppColors.textMuted),
          SizedBox(height: 12.h),
          Padding(
            padding: EdgeInsets.symmetric(horizontal: 32.w),
            child: Text(
              error,
              textAlign: TextAlign.center,
              style: GoogleFonts.manrope(fontSize: 12.sp, color: AppColors.textMuted),
            ),
          ),
          SizedBox(height: 12.h),
          ElevatedButton(onPressed: onRetry, child: const Text('Retry')),
        ],
      ),
    );
  }
}
