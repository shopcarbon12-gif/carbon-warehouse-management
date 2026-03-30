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
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  String? _err;

  @override
  void dispose() {
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
    final r = await api.login(email: _email.text.trim(), password: _password.text);
    if (!mounted) return;
    setState(() => _busy = false);
    if (!r.ok) {
      setState(() => _err = r.error ?? 'Login failed');
      return;
    }
    await widget.onSuccess();
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
              const SizedBox(height: 28),
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
