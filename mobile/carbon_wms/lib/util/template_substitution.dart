/// Replaces `{{path.to.key}}` segments using a flat map of full keys (e.g. `item.name`).
String applyMustacheTemplate(String template, Map<String, String> variables) {
  return template.replaceAllMapped(
    RegExp(r'\{\{\s*([^}]+?)\s*\}\}'),
    (m) {
      final key = m.group(1)?.trim() ?? '';
      if (key.isEmpty) return '';
      return variables[key] ?? '';
    },
  );
}
