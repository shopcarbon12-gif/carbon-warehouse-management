import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

/// Persists failed [postRfidCommission] jobs for retry from Encode suite → Upload tab.
class CommissionQueueJob {
  CommissionQueueJob({
    required this.customSkuId,
    required this.qty,
    required this.label,
  });

  final String customSkuId;
  final int qty;
  final String label;

  Map<String, dynamic> toJson() => {
        'customSkuId': customSkuId,
        'qty': qty,
        'label': label,
      };

  static CommissionQueueJob? fromJson(Map<String, dynamic> m) {
    final id = m['customSkuId']?.toString() ?? '';
    final q = m['qty'];
    final qty = q is int ? q : int.tryParse('$q') ?? 1;
    if (id.isEmpty) return null;
    return CommissionQueueJob(
      customSkuId: id,
      qty: qty < 1 ? 1 : qty,
      label: m['label']?.toString() ?? id,
    );
  }
}

class CommissionRetryQueue {
  static const _key = 'commission_retry_queue_v1';

  static Future<List<CommissionQueueJob>> load() async {
    final p = await SharedPreferences.getInstance();
    final s = p.getString(_key);
    if (s == null || s.isEmpty) return [];
    try {
      final decoded = jsonDecode(s);
      if (decoded is! List) return [];
      final out = <CommissionQueueJob>[];
      for (final e in decoded) {
        if (e is Map) {
          final j = CommissionQueueJob.fromJson(Map<String, dynamic>.from(e));
          if (j != null) out.add(j);
        }
      }
      return out;
    } catch (_) {
      return [];
    }
  }

  static Future<void> save(List<CommissionQueueJob> jobs) async {
    final p = await SharedPreferences.getInstance();
    await p.setString(_key, jsonEncode(jobs.map((j) => j.toJson()).toList()));
  }

  static Future<void> enqueue(CommissionQueueJob job) async {
    final jobs = await load();
    jobs.add(job);
    await save(jobs);
  }
}
