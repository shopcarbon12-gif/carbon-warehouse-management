import 'package:flutter/foundation.dart';

/// In-memory mirror of the server's add_on_sessions row + the EPC ledger
/// driving the Add-On Count scan screen.
///
/// Lifecycle (matches Q18 lock — trigger toggles start/pause):
///   - createdAfterStart  → screen shows source slip + ready
///   - scanning           → radio firing, _new EPCs ticking up
///   - paused             → trigger pressed again; radio off but state preserved
///   - finalized          → SAVE/UPLOAD ran; screen returns to picker
///
/// On crash / app dispose: server-side janitor catches us via heartbeat
/// timeout (Q19 lock). Local state is discarded — we never persist Add-On
/// session state across app restarts (Q22 spec contract).
class AddOnSessionState extends ChangeNotifier {
  AddOnSessionState({
    required this.sessionId,
    required this.sourceType,
    required this.sourceId,
    required this.sourceSlip,
    required Iterable<String> sourceEpcs,
  }) : _sourceEpcs = sourceEpcs.map((e) => e.toUpperCase()).toSet();

  final String sessionId;
  final String sourceType;
  final String sourceId;
  final String sourceSlip;

  final Set<String> _sourceEpcs;
  Set<String> get sourceEpcs => _sourceEpcs;

  /// Server-confirmed "new" EPCs this session — what the operator actually sees.
  final List<NewEpcEntry> _newEntries = [];
  List<NewEpcEntry> get newEntries => List.unmodifiable(_newEntries);
  final Set<String> _newSeen = {};

  /// Defective EPCs — failed the Carbon EPC formula check (wrong prefix /
  /// bad hex / wrong length). Captured locally so the Review screen can
  /// show the count and forward to scan-finalize, but never beep / display
  /// in the main scan list. Server-side mirror lives in
  /// `add_on_sessions.failed_ledger` (populated by our /epc POSTs with
  /// validationFailed=true).
  final List<FailedEpcEntry> _failedEntries = [];
  List<FailedEpcEntry> get failedEntries => List.unmodifiable(_failedEntries);
  final Set<String> _failedSeen = {};

  /// EPCs we've already submitted to the server this session (any outcome).
  /// Stops us from spamming /epc with the same tag on re-reads.
  final Set<String> _submitted = {};

  bool _scanning = false;
  bool get scanning => _scanning;

  bool _disposed = false;

  /// Returns true if we should submit this EPC to the server. Caller still
  /// must call /epc to get the authoritative outcome (other devices may
  /// have already counted this tag — server-mediated dedup).
  bool shouldSubmit(String epc) {
    final u = epc.toUpperCase();
    if (_sourceEpcs.contains(u)) return false; // silently in source — no submit
    if (_submitted.contains(u)) return false; // already in flight or counted
    _submitted.add(u);
    return true;
  }

  void recordNew(NewEpcEntry entry) {
    if (_newSeen.add(entry.epc)) {
      // Append (O(1)) rather than insert(0) (O(n)) — at 10k+ EPCs the
      // shift-everything insert was a per-tag cost that compounded into
      // visible jank. The list view renders newest-first by reading from the
      // end, so display order is unchanged.
      _newEntries.add(entry);
      notifyListeners();
    }
  }

  /// Replace product-info on a row already in the list (used after async
  /// catalog enrichment lands).
  void enrichEntry(String epc, NewEpcEntry enriched) {
    final i = _newEntries.indexWhere((e) => e.epc == epc.toUpperCase());
    if (i < 0) return;
    _newEntries[i] = enriched;
    notifyListeners();
  }

  /// Caller learned the EPC was already counted by another device — don't
  /// surface to the operator but keep the dedup mark so we don't re-submit.
  void recordRemoteDuplicate(String epc) {
    _submitted.add(epc.toUpperCase());
  }

  /// Record a defective EPC (failed Carbon formula check). Silent — does
  /// not beep, does not render in the main list. Surfaces only on the
  /// Review screen as a count and as an extra "Defective" sheet/blob in
  /// the SAVE/UPLOAD output.
  void recordFailed(FailedEpcEntry entry) {
    if (_failedSeen.add(entry.epc)) {
      _failedEntries.add(entry);
      notifyListeners();
    }
  }

  int get failedCount => _failedEntries.length;

  void setScanning(bool value) {
    if (_disposed || _scanning == value) return;
    _scanning = value;
    notifyListeners();
  }

  int get newCount => _newEntries.length;

  /// Populate the in-memory ledger from a `getAddOnSession` server response.
  /// Used on screen entry so a resumed/joined session shows the EPCs other
  /// devices already counted (and our own scans from a previous run, since
  /// Q22-mobile-state-doesn't-persist means we have nothing locally on
  /// re-entry). Each EPC is also marked as already-submitted so the scan
  /// loop won't re-POST it to /epc.
  ///
  /// Server format (from lib/server/add-on-sessions.ts:getSession):
  ///   epc_ledger:    Map<epc, {u, d, at}>
  ///   failed_ledger: Map<epc, {u, d, at, r}>
  void hydrateFromServer(Map<String, dynamic> serverSession) {
    final newLedger = serverSession['epc_ledger'];
    if (newLedger is Map) {
      for (final e in newLedger.entries) {
        final epcKey = e.key.toString().toUpperCase();
        final meta = e.value;
        DateTime at;
        if (meta is Map && meta['at'] is String) {
          at = DateTime.tryParse(meta['at'] as String) ?? DateTime.now().toUtc();
        } else {
          at = DateTime.now().toUtc();
        }
        if (_newSeen.add(epcKey)) {
          _newEntries.add(NewEpcEntry(epc: epcKey, scannedAtUtc: at));
        }
        _submitted.add(epcKey);
      }
    }
    final failLedger = serverSession['failed_ledger'];
    if (failLedger is Map) {
      for (final e in failLedger.entries) {
        final epcKey = e.key.toString().toUpperCase();
        final meta = e.value;
        DateTime at;
        String reason = 'unknown';
        if (meta is Map) {
          if (meta['at'] is String) {
            at = DateTime.tryParse(meta['at'] as String) ?? DateTime.now().toUtc();
          } else {
            at = DateTime.now().toUtc();
          }
          if (meta['r'] is String) reason = meta['r'] as String;
        } else {
          at = DateTime.now().toUtc();
        }
        if (_failedSeen.add(epcKey)) {
          _failedEntries.add(FailedEpcEntry(epc: epcKey, reason: reason, scannedAtUtc: at));
        }
        _submitted.add(epcKey);
      }
    }
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}

@immutable
class NewEpcEntry {
  const NewEpcEntry({
    required this.epc,
    required this.scannedAtUtc,
    this.systemId,
    this.customSku,
    this.itemName,
    this.color,
    this.size,
    this.bin,
    this.retailPrice,
  });

  final String epc;
  final DateTime scannedAtUtc;
  final String? systemId;
  final String? customSku;
  final String? itemName;
  final String? color;
  final String? size;
  final String? bin;
  final num? retailPrice;

  Map<String, dynamic> toFinalizeRow({int seenCount = 1}) => <String, dynamic>{
        'epc': epc,
        'system_id': systemId,
        'custom_sku': customSku,
        'item_name': itemName,
        'color': color,
        'size': size,
        'retail_price': retailPrice,
        'bin': bin,
        'seen_count': seenCount,
        'first_seen_iso': scannedAtUtc.toIso8601String(),
        'last_seen_iso': scannedAtUtc.toIso8601String(),
      };
}

/// Defective EPC entry — failed the Carbon formula check (wrong prefix,
/// bad hex, or wrong length). Held locally + mirrored server-side in
/// `add_on_sessions.failed_ledger`.
@immutable
class FailedEpcEntry {
  const FailedEpcEntry({
    required this.epc,
    required this.reason,
    required this.scannedAtUtc,
  });

  final String epc;
  final String reason;
  final DateTime scannedAtUtc;
}
