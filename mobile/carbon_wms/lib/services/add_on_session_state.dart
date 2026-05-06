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
      _newEntries.insert(0, entry);
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

  void setScanning(bool value) {
    if (_disposed || _scanning == value) return;
    _scanning = value;
    notifyListeners();
  }

  int get newCount => _newEntries.length;

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
