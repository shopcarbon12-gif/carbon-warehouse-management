import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/util/demo_epc.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';
import 'package:carbon_wms/ui/widgets/tactical_bottom_bar.dart';

/// Transfer OUT: create slip + append scanned EPCs. Transfer IN: select slip + mark received/missing.
class TransferSlipsScreen extends StatefulWidget {
  const TransferSlipsScreen({super.key});

  @override
  State<TransferSlipsScreen> createState() => _TransferSlipsScreenState();
}

class _TransferSlipsScreenState extends State<TransferSlipsScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabs;
  final _sourceCtrl = TextEditingController();
  final _destCtrl = TextEditingController();

  List<dynamic> _slips = [];
  bool _loadingSlips = false;
  int? _activeSlipOut;
  int? _selectedSlipIn;
  Map<String, dynamic>? _slipDetailIn;
  bool _busy = false;
  String? _msg;

  @override
  void initState() {
    super.initState();
    _tabs = TabController(length: 2, vsync: this);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<RfidManager>().scanContext = 'TRANSFER_SLIP';
      unawaited(_reloadSlips());
      unawaited(_prefillLocations());
    });
  }

  @override
  void dispose() {
    _tabs.dispose();
    _sourceCtrl.dispose();
    _destCtrl.dispose();
    super.dispose();
  }

  Future<void> _prefillLocations() async {
    try {
      final codes = await context.read<WmsApiClient>().fetchSessionLocationCodes();
      if (!mounted || codes.length < 2) return;
      setState(() {
        _sourceCtrl.text = codes.first;
        _destCtrl.text = codes[1];
      });
    } catch (_) {}
  }

  Future<void> _reloadSlips() async {
    setState(() => _loadingSlips = true);
    try {
      final rows = await context.read<WmsApiClient>().fetchTransferSlips();
      if (mounted) setState(() => _slips = rows);
    } catch (e) {
      if (mounted) setState(() => _msg = 'Slips: $e');
    } finally {
      if (mounted) setState(() => _loadingSlips = false);
    }
  }

  Future<void> _createSlipOut() async {
    final src = _sourceCtrl.text.trim();
    final dst = _destCtrl.text.trim();
    if (src.isEmpty || dst.isEmpty) {
      setState(() => _msg = 'Source and destination required');
      return;
    }
    setState(() {
      _busy = true;
      _msg = null;
    });
    try {
      final j = await context.read<WmsApiClient>().createTransferSlip(
            sourceLoc: src,
            destLoc: dst,
          );
      final n = j['slipNumber'];
      if (mounted) {
        setState(() {
          _activeSlipOut = n is int ? n : int.tryParse('$n');
          _msg = 'Created slip #$_activeSlipOut';
        });
      }
      await _reloadSlips();
    } catch (e) {
      if (mounted) setState(() => _msg = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _appendScansToSlip() async {
    final slip = _activeSlipOut;
    if (slip == null) {
      setState(() => _msg = 'Create a slip first');
      return;
    }
    final m = context.read<RfidManager>();
    final epcs = m.sessionEpcs;
    if (epcs.isEmpty) {
      setState(() => _msg = 'No EPCs in session');
      return;
    }
    setState(() {
      _busy = true;
      _msg = null;
    });
    try {
      await context.read<WmsApiClient>().postTransferSlipAction(slip, {
        'action': 'append_epcs',
        'epcs': epcs,
      });
      m.clearSessionScans();
      if (mounted) setState(() => _msg = 'Appended ${epcs.length} EPC(s) to slip #$slip');
    } catch (e) {
      if (mounted) setState(() => _msg = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _loadSlipIn(int slipNumber) async {
    setState(() {
      _selectedSlipIn = slipNumber;
      _busy = true;
      _slipDetailIn = null;
      _msg = null;
    });
    try {
      final d = await context.read<WmsApiClient>().getTransferSlip(slipNumber);
      if (mounted) setState(() => _slipDetailIn = d);
    } catch (e) {
      if (mounted) setState(() => _msg = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Set<String> _allowedEpcsIn() {
    final d = _slipDetailIn;
    if (d == null) return {};
    final items = d['items'];
    if (items is! List) return {};
    final set = <String>{};
    for (final it in items) {
      if (it is Map && it['epc'] != null) {
        set.add(it['epc'].toString().trim().toUpperCase());
      }
    }
    return set;
  }

  Future<void> _receiveOutcome(String outcome) async {
    final slip = _selectedSlipIn;
    if (slip == null) return;
    final m = context.read<RfidManager>();
    final epcs = m.sessionEpcs.map((e) => e.trim().toUpperCase()).toList();
    if (epcs.isEmpty) {
      setState(() => _msg = 'Scan EPCs first');
      return;
    }
    final allowed = _allowedEpcsIn();
    final filtered = epcs.where((e) => allowed.contains(e)).toList();
    if (filtered.isEmpty) {
      setState(() => _msg = 'No scanned EPCs belong to this slip');
      return;
    }
    setState(() {
      _busy = true;
      _msg = null;
    });
    try {
      await context.read<WmsApiClient>().postTransferSlipAction(slip, {
        'action': 'receive',
        'epcs': filtered,
        'outcome': outcome,
      });
      m.clearSessionScans();
      await _loadSlipIn(slip);
      if (mounted) setState(() => _msg = 'Updated ${filtered.length} line(s) as $outcome');
    } catch (e) {
      if (mounted) setState(() => _msg = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final rfid = context.watch<RfidManager>();

    return CarbonScaffold(
      pageTitle: 'TRANSFERS',
      bottomBar: TacticalBottomBar(
          ),
        ],
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Material(
            color: AppColors.surface,
            child: TabBar(
              controller: _tabs,
              indicatorColor: AppColors.primary,
              tabs: const [
                Tab(text: 'TRANSFER OUT'),
                Tab(text: 'TRANSFER IN'),
              ],
            ),
          ),
          if (_msg != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
              child: Text(_msg!, style: const TextStyle(color: AppColors.textMuted, fontSize: 12)),
            ),
          Expanded(
            child: TabBarView(
              controller: _tabs,
              children: [
                _buildOutTab(context, rfid),
                _buildInTab(context, rfid),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildOutTab(BuildContext context, RfidManager rfid) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text('CREATE SLIP', style: AppTheme.headline(context)),
        const SizedBox(height: 8),
        TextField(
          controller: _sourceCtrl,
          style: const TextStyle(color: AppColors.textMain, fontWeight: FontWeight.w600),
          decoration: const InputDecoration(labelText: 'Source location code'),
        ),
        const SizedBox(height: 8),
        TextField(
          controller: _destCtrl,
          style: const TextStyle(color: AppColors.textMain, fontWeight: FontWeight.w600),
          decoration: const InputDecoration(labelText: 'Destination location code'),
        ),
        const SizedBox(height: 12),
        FilledButton(
          onPressed: _busy ? null : () => unawaited(_createSlipOut()),
          child: Text(_busy ? '…' : 'CREATE SLIP'),
        ),
        if (_activeSlipOut != null) ...[
          const SizedBox(height: 16),
          Text('ACTIVE SLIP #$_activeSlipOut', style: AppTheme.headline(context)),
          Text('Session EPCs: ${rfid.sessionCount}', style: const TextStyle(color: AppColors.textMuted)),
          const SizedBox(height: 8),
          FilledButton(
            onPressed: _busy ? null : () => unawaited(_appendScansToSlip()),
            style: FilledButton.styleFrom(
              backgroundColor: AppColors.slateActionDark,
              foregroundColor: Colors.white,
            ),
            child: const Text('APPEND SESSION EPCS TO SLIP'),
          ),
        ],
      ],
    );
  }

  Widget _buildInTab(BuildContext context, RfidManager rfid) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Row(
          children: [
            Text('SELECT SLIP', style: AppTheme.headline(context)),
            const Spacer(),
            IconButton(
              icon: const Icon(Icons.refresh),
              onPressed: _loadingSlips ? null : () => unawaited(_reloadSlips()),
            ),
          ],
        ),
        if (_loadingSlips) const LinearProgressIndicator(),
        ..._slips.map((row) {
          if (row is! Map) return const SizedBox.shrink();
          final n = row['slip_number'];
          final num = n is int ? n : int.tryParse('$n') ?? 0;
          return ListTile(
            title: Text('#$num  ${row['source_loc']} → ${row['dest_loc']}', style: const TextStyle(fontSize: 13)),
            subtitle: Text('${row['status']}', style: const TextStyle(fontSize: 11)),
            onTap: num > 0 ? () => unawaited(_loadSlipIn(num)) : null,
          );
        }),
        if (_slipDetailIn != null) ...[
          const Divider(height: 24),
          Text('SLIP #$_selectedSlipIn — scan only tags on this slip', style: AppTheme.headline(context)),
          Text('Session: ${rfid.sessionCount} EPC(s)', style: const TextStyle(color: AppColors.textMuted)),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: FilledButton(
                  onPressed: _busy ? null : () => unawaited(_receiveOutcome('received')),
                  child: const Text('MARK RECEIVED'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: OutlinedButton(
                  onPressed: _busy ? null : () => unawaited(_receiveOutcome('missing')),
                  child: const Text('MARK MISSING'),
                ),
              ),
            ],
          ),
        ],
      ],
    );
  }
}
