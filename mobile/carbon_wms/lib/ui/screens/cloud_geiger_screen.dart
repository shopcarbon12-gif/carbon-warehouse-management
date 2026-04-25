import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/handheld_device_identity.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart' show CarbonScaffold;

/// Cloud + Geiger — landing pad for EPCs sent from the web catalog's
/// "Send to handheld" drawer. Intentionally minimal scaffolding for v1:
/// poll the per-device queue, list received EPCs, allow refresh + clear.
/// Geiger interaction (locate via RFID range scan) is intentionally not wired
/// here yet; product owner will iterate on this screen later.
class CloudGeigerScreen extends StatefulWidget {
  const CloudGeigerScreen({super.key});

  @override
  State<CloudGeigerScreen> createState() => _CloudGeigerScreenState();
}

class _CloudGeigerScreenState extends State<CloudGeigerScreen> {
  static const Duration _pollInterval = Duration(seconds: 8);

  final List<String> _epcs = <String>[];
  Timer? _poller;
  bool _loading = false;
  String? _error;
  String? _lastFetchedAt;

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
      setState(() {
        if (result.epcs.isNotEmpty) {
          /* Append new drops; server already returns only newly-consumed rows. */
          _epcs.addAll(result.epcs);
        }
        _lastFetchedAt = DateTime.now().toLocal().toString().substring(11, 19);
      });
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

  void _clear() {
    setState(() {
      _epcs.clear();
      _error = null;
    });
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
        IconButton(
          onPressed: _epcs.isEmpty ? null : _clear,
          icon: const Icon(Icons.clear_all),
          tooltip: 'Clear',
        ),
      ],
      body: ColoredBox(
        color: Colors.white,
        child: Padding(
          padding: EdgeInsets.fromLTRB(16.w, 12.h, 16.w, 12.h),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                _epcs.isEmpty
                    ? 'Waiting for EPCs from the cloud…'
                    : '${_epcs.length} EPC(s) received',
                style: TextStyle(
                  fontSize: 16.sp,
                  fontWeight: FontWeight.w700,
                  color: Colors.black87,
                ),
              ),
              SizedBox(height: 4.h),
              Text(
                _lastFetchedAt != null
                    ? 'Last poll: $_lastFetchedAt'
                    : 'No poll yet.',
                style: TextStyle(
                  fontSize: 12.sp,
                  color: Colors.black54,
                ),
              ),
              if (_error != null) ...[
                SizedBox(height: 8.h),
                Text(
                  _error!,
                  style: TextStyle(
                    fontSize: 12.sp,
                    color: Colors.red.shade700,
                  ),
                ),
              ],
              SizedBox(height: 12.h),
              Expanded(
                child: _epcs.isEmpty
                    ? Center(
                        child: Text(
                          'Send EPCs from /inventory/catalog → RFID popup → Send to handheld.',
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            fontSize: 13.sp,
                            color: Colors.black45,
                          ),
                        ),
                      )
                    : ListView.builder(
                        itemCount: _epcs.length,
                        itemBuilder: (_, i) => Padding(
                          padding: EdgeInsets.symmetric(vertical: 4.h),
                          child: Container(
                            padding: EdgeInsets.symmetric(
                                horizontal: 12.w, vertical: 8.h),
                            decoration: BoxDecoration(
                              border: Border.all(color: const Color(0xFFE0E0E0)),
                              borderRadius: BorderRadius.circular(4.r),
                              color: const Color(0xFFFAFAFA),
                            ),
                            child: Text(
                              _epcs[i],
                              style: TextStyle(
                                fontSize: 13.sp,
                                fontFamily: 'monospace',
                                color: Colors.black87,
                              ),
                            ),
                          ),
                        ),
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
