import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/theme/app_theme.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.onSuccess});

  final Future<void> Function() onSuccess;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _serverUrl = TextEditingController();
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  String? _err;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadSavedServerUrl());
  }

  Future<void> _loadSavedServerUrl() async {
    if (!mounted) return;
    final api = context.read<WmsApiClient>();
    final u = await api.resolveBaseUrl();
    if (!mounted) return;
    setState(() {
      if (u.isNotEmpty) _serverUrl.text = u;
    });
  }

  @override
  void dispose() {
    _serverUrl.dispose();
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _err = null;
    });
    final api = context.read<WmsApiClient>();
    final base = WmsApiClient.normalizeBaseUrl(_serverUrl.text);
    if (base.isEmpty) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _err = 'Enter your WMS server URL (e.g. https://wms.shopcarbon.com).';
      });
      return;
    }
    await api.setBaseUrl(base);
    try {
      final r = await api
          .login(email: _email.text.trim(), password: _password.text)
          .timeout(const Duration(seconds: 45));
      if (!mounted) return;
      setState(() => _busy = false);
      if (!r.ok) {
        setState(() => _err = r.error ?? 'Login failed');
        return;
      }
      await widget.onSuccess();
    } on Object catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _err =
            'Cannot reach server. Check the URL (https), Wi‑Fi, and that the site is up.\n${e.runtimeType}';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('CARBON WMS', style: AppTheme.headline(context)),
              const SizedBox(height: 8),
              Text(
                'Sign in with your web admin credentials. The device will register its Android ID for approval.',
                style: TextStyle(color: AppColors.textMuted, fontSize: 12, fontFamily: 'monospace'),
              ),
              const SizedBox(height: 20),
              TextField(
                controller: _serverUrl,
                keyboardType: TextInputType.url,
                autocorrect: false,
                style: const TextStyle(color: Colors.white),
                decoration: const InputDecoration(
                  labelText: 'Server URL',
                  hintText: 'https://wms.shopcarbon.com',
                  helperText: 'Your production or LAN WMS base URL (no path after .com)',
                ),
              ),
              const SizedBox(height: 16),
              TextField(
                controller: _email,
                keyboardType: TextInputType.emailAddress,
                style: const TextStyle(color: Colors.white),
                decoration: const InputDecoration(labelText: 'Email'),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _password,
                obscureText: true,
                style: const TextStyle(color: Colors.white),
                decoration: const InputDecoration(labelText: 'Password'),
                onSubmitted: (_) => _busy ? null : _submit(),
              ),
              if (_err != null) ...[
                const SizedBox(height: 12),
                Text(_err!, style: const TextStyle(color: Colors.redAccent, fontSize: 12)),
              ],
              const Spacer(),
              FilledButton(
                onPressed: _busy ? null : () => _submit(),
                child: Text(_busy ? 'Signing in…' : 'Sign in'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
