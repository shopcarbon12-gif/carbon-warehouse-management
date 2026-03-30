import 'dart:async';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/services/mobile_settings_repository.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';
import 'package:carbon_wms/ui/widgets/tactical_bottom_bar.dart';

class GeigerScreen extends StatefulWidget {
  const GeigerScreen({super.key});

  @override
  State<GeigerScreen> createState() => _GeigerScreenState();
}

class _GeigerScreenState extends State<GeigerScreen> {
  final _targetCtrl = TextEditingController(text: '104499100000000000000001');
  double _level = 0;
  Timer? _sim;
  final _rand = Random();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<RfidManager>().scanContext = 'GEIGER_FIND';
    });
  }

  @override
  void dispose() {
    _sim?.cancel();
    _targetCtrl.dispose();
    super.dispose();
  }

  void _startSim() {
    _sim?.cancel();
    _sim = Timer.periodic(const Duration(milliseconds: 200), (_) {
      if (!mounted) return;
      setState(() {
        _level = _rand.nextDouble();
      });
    });
    setState(() {});
  }

  void _stopSim() {
    _sim?.cancel();
    _sim = null;
    setState(() => _level = 0);
  }

  @override
  Widget build(BuildContext context) {
    final holdRelease = context.watch<MobileSettingsRepository>().config.triggerModeHoldRelease;

    return CarbonScaffold(
      bottomBar: TacticalBottomBar(
        children: [
          if (holdRelease)
            TacticalEmeraldButton(
              label: 'HOLD TO SCAN',
              onLongPressStart: _startSim,
              onLongPressEnd: _stopSim,
            )
          else
            TacticalEmeraldButton(
              label: _sim != null ? 'STOP SCAN' : 'TAP TO SCAN',
              onPressed: () {
                if (_sim != null) {
                  _stopSim();
                } else {
                  _startSim();
                }
              },
            ),
        ],
      ),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('TARGET EPC', style: AppTheme.headline(context)),
            const SizedBox(height: 8),
            TextField(
              controller: _targetCtrl,
              style: const TextStyle(
                color: AppColors.textMain,
                fontWeight: FontWeight.w600,
                letterSpacing: 1.2,
              ),
              decoration: const InputDecoration(
                hintText: '24-char hex EPC',
              ),
            ),
            const SizedBox(height: 24),
            Text('SIGNAL', style: AppTheme.headline(context)),
            const SizedBox(height: 12),
            Expanded(
              child: Center(
                child: _SignalBar(level: _level),
              ),
            ),
            Text(
              'PROXIMITY ${(_level * 100).round()}%',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    color: AppColors.textMuted,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 1.2,
                  ),
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }
}

class _SignalBar extends StatelessWidget {
  const _SignalBar({required this.level});

  final double level;

  @override
  Widget build(BuildContext context) {
    final t = level.clamp(0.0, 1.0);
    final color = Color.lerp(AppColors.surface, AppColors.success, t)!;
    return SizedBox(
      width: 120,
      height: 280,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(16),
        child: ColoredBox(
          color: AppColors.surface,
          child: Align(
            alignment: Alignment.bottomCenter,
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 120),
              curve: Curves.easeOut,
              width: double.infinity,
              height: 280 * t,
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.bottomCenter,
                  end: Alignment.topCenter,
                  colors: [
                    AppColors.primary,
                    color,
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
