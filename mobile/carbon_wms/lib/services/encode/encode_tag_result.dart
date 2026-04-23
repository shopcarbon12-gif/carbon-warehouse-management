import 'package:flutter/material.dart';

enum EncodeStatus {
  encoded,
  detected,
  notFound,
  tagIssue,
  alreadyNew,
}

extension EncodeStatusLabel on EncodeStatus {
  String get label {
    switch (this) {
      case EncodeStatus.encoded:
        return 'Encoded';
      case EncodeStatus.detected:
        return 'Detected';
      case EncodeStatus.notFound:
        return 'Not Found';
      case EncodeStatus.tagIssue:
        return 'Tag Issue';
      case EncodeStatus.alreadyNew:
        return 'Already New';
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
    required this.at,
  });

  final String oldEpc;
  String? newEpc;
  int? systemId;
  int? serial;
  String? customSku;
  String? itemName;
  EncodeStatus status;
  final DateTime at;
}
