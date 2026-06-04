import 'package:flutter/material.dart';

enum EncodeStatus {
  encoded,
  detected,
  notFound,
  tagIssue,
  alreadyNew,
  foreignCurrent, // F0A0B-prefixed but system_id is not in our catalog
}

// Mutually-exclusive machine-readable failure reasons for CSV/analytics.
// [none] means the row succeeded (status = encoded OR alreadyNew with our system_id).
enum EncodeFailureReason {
  none,
  notInCatalog,
  foreignEpc,
  serialFetchFailed,
  writeFailed,
  badSystemId,
  configInvalid,
}

extension EncodeFailureReasonLabel on EncodeFailureReason {
  String get csv {
    switch (this) {
      case EncodeFailureReason.none:              return '';
      case EncodeFailureReason.notInCatalog:      return 'NOT_IN_CATALOG';
      case EncodeFailureReason.foreignEpc:        return 'FOREIGN_EPC';
      case EncodeFailureReason.serialFetchFailed: return 'SERIAL_FETCH_FAILED';
      case EncodeFailureReason.writeFailed:       return 'WRITE_FAILED';
      case EncodeFailureReason.badSystemId:       return 'BAD_SYSTEM_ID';
      case EncodeFailureReason.configInvalid:     return 'CONFIG_INVALID';
    }
  }

  // Human-readable version shown inside the popup.
  String get display {
    switch (this) {
      case EncodeFailureReason.none:              return '';
      case EncodeFailureReason.notInCatalog:      return 'Custom SKU not found in catalog';
      case EncodeFailureReason.foreignEpc:        return 'EPC from another system';
      case EncodeFailureReason.serialFetchFailed: return 'Could not fetch next serial from server';
      case EncodeFailureReason.writeFailed:       return 'Tag write failed (move closer and retry)';
      case EncodeFailureReason.badSystemId:       return 'Catalog returned an unusable system_id';
      case EncodeFailureReason.configInvalid:     return 'Position config invalid';
    }
  }
}

extension EncodeStatusLabel on EncodeStatus {
  String get label {
    switch (this) {
      case EncodeStatus.encoded:        return 'Encoded';
      case EncodeStatus.detected:       return 'Detected';
      case EncodeStatus.notFound:       return 'Not Found';
      case EncodeStatus.tagIssue:       return 'Tag Issue';
      case EncodeStatus.alreadyNew:     return 'Already New';
      case EncodeStatus.foreignCurrent: return 'Foreign EPC';
    }
  }

  // CSV-safe status token (stable across UI changes).
  String get csv {
    switch (this) {
      case EncodeStatus.encoded:        return 'ENCODED';
      case EncodeStatus.detected:       return 'DETECTED';
      case EncodeStatus.notFound:       return 'NOT_FOUND';
      case EncodeStatus.tagIssue:       return 'TAG_ISSUE';
      case EncodeStatus.alreadyNew:     return 'ALREADY_NEW';
      case EncodeStatus.foreignCurrent: return 'FOREIGN_CURRENT';
    }
  }

  Color get chipColor {
    switch (this) {
      case EncodeStatus.encoded:
        return const Color(0xFF16A34A);
      case EncodeStatus.detected:
        return const Color(0xFFD97706);
      case EncodeStatus.notFound:
      case EncodeStatus.tagIssue:
      case EncodeStatus.foreignCurrent:
        return const Color(0xFFDC2626);
      case EncodeStatus.alreadyNew:
        return const Color(0xFF6A7070);
    }
  }
}

class EncodeTagResult {
  EncodeTagResult({
    required this.oldEpc,
    this.newEpc,
    this.systemId,
    this.serial,
    this.customSku,
    this.itemName,
    required this.status,
    this.failureReason = EncodeFailureReason.none,
    required this.at,
  });

  final String oldEpc;
  String? newEpc;
  int? systemId;
  int? serial;
  String? customSku;
  String? itemName;
  String? color;
  String? size;
  EncodeStatus status;
  EncodeFailureReason failureReason;
  final DateTime at;

  bool get wasSuccessful => status == EncodeStatus.encoded;
}
