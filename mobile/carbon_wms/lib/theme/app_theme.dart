import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

/// Carbon Industrial — strict dark surfaces for warehouse floor use.
abstract final class AppColors {
  static const Color background = Color(0xFF0F1115);
  static const Color surface = Color(0xFF1E2128);
  static const Color primary = Color(0xFF10B981);
  static const Color success = Color(0xFF34D399);
  static const Color textMain = Color(0xFFF8FAFC);
  static const Color textMuted = Color(0xFF94A3B8);
  static const Color slateAction = Color(0xFF475569);
  static const Color slateActionDark = Color(0xFF334155);
}

abstract final class AppTheme {
  static ThemeData get dark {
    final base = ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      scaffoldBackgroundColor: AppColors.background,
      colorScheme: const ColorScheme.dark(
        surface: AppColors.surface,
        primary: AppColors.primary,
        onPrimary: AppColors.background,
        secondary: AppColors.slateAction,
        onSurface: AppColors.textMain,
        error: Color(0xFFEF4444),
      ),
    );

    return base.copyWith(
      appBarTheme: AppBarTheme(
        elevation: 0,
        centerTitle: false,
        backgroundColor: AppColors.surface,
        foregroundColor: AppColors.textMain,
        titleTextStyle: GoogleFonts.inter(
          fontSize: 18,
          fontWeight: FontWeight.w700,
          letterSpacing: 1.2,
          color: AppColors.textMain,
        ),
      ),
      textTheme: GoogleFonts.interTextTheme(base.textTheme).apply(
        bodyColor: AppColors.textMain,
        displayColor: AppColors.textMain,
      ),
      cardTheme: CardTheme(
        color: AppColors.surface,
        elevation: 0,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: AppColors.surface,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: const BorderSide(color: Color(0xFF334155)),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: const BorderSide(color: Color(0xFF334155)),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: const BorderSide(color: AppColors.primary, width: 2),
        ),
        labelStyle: const TextStyle(color: AppColors.textMuted),
      ),
    );
  }

  /// Headline: bold, uppercase, tight tracking (industrial).
  static TextStyle headline(BuildContext context) {
    return GoogleFonts.inter(
      fontSize: 13,
      fontWeight: FontWeight.w800,
      letterSpacing: 1.4,
      color: AppColors.textMuted,
    );
  }
}
