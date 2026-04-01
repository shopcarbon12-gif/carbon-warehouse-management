import 'package:flutter/material.dart';

/// Persistent shell: Carbon WMS title + optional back navigation.
class CarbonScaffold extends StatelessWidget {
  const CarbonScaffold({
    super.key,
    required this.body,
    this.title = 'Carbon WMS',
    this.bottomBar,
    this.floatingActionButton,
    this.actions,
  });

  final Widget body;
  /// App bar title (reference layout: full product name).
  final String title;
  final Widget? bottomBar;
  final Widget? floatingActionButton;
  final List<Widget>? actions;

  @override
  Widget build(BuildContext context) {
    final canPop = Navigator.canPop(context);

    final dividerColor = Theme.of(context).dividerTheme.color;

    return Scaffold(
      appBar: AppBar(
        title: Text(title),
        actions: actions,
        leading: canPop
            ? IconButton(
                icon: const Icon(Icons.arrow_back),
                onPressed: () => Navigator.of(context).maybePop(),
              )
            : null,
        automaticallyImplyLeading: false,
        bottom: dividerColor != null
            ? PreferredSize(
                preferredSize: const Size.fromHeight(1),
                child: Divider(height: 1, thickness: 1, color: dividerColor),
              )
            : null,
      ),
      body: ColoredBox(
        color: Theme.of(context).scaffoldBackgroundColor,
        child: body,
      ),
      bottomNavigationBar: bottomBar,
      floatingActionButton: floatingActionButton,
    );
  }
}
