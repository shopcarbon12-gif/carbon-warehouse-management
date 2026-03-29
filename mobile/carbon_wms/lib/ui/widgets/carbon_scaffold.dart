import 'package:flutter/material.dart';
import 'package:carbon_wms/theme/app_theme.dart';

/// Persistent shell: Carbon WMS title + optional back navigation.
class CarbonScaffold extends StatelessWidget {
  const CarbonScaffold({
    super.key,
    required this.body,
    this.bottomBar,
    this.floatingActionButton,
    this.actions,
  });

  final Widget body;
  final Widget? bottomBar;
  final Widget? floatingActionButton;
  final List<Widget>? actions;

  @override
  Widget build(BuildContext context) {
    final canPop = Navigator.canPop(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Carbon WMS'),
        actions: actions,
        leading: canPop
            ? IconButton(
                icon: const Icon(Icons.arrow_back),
                onPressed: () => Navigator.of(context).maybePop(),
              )
            : null,
        automaticallyImplyLeading: false,
      ),
      body: ColoredBox(
        color: AppColors.background,
        child: body,
      ),
      bottomNavigationBar: bottomBar,
      floatingActionButton: floatingActionButton,
    );
  }
}
