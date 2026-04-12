import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

/// Carbon Industrial — light surfaces matching the login screen palette.
abstract final class AppColors {
  static const Color background = Color(0xFFF5F5F5);
  static const Color surface = Color(0xFFECECEC);
  static const Color primary = Color(0xFF1B7D7D);
  static const Color success = Color(0xFF34D399);
  static const Color textMain = Color(0xFF171D1D);
  static const Color textMuted = Color(0xFF8A9090);
  static const Color slateAction = Color(0xFF4A5454);
  static const Color slateActionDark = Color(0xFF6A7070);
  /// Light border for input outlines and separators.
  static const Color border = Color(0xFFBCC9C9);
}

abstract final class AppTheme {
  static ThemeData get light {
    final base = ThemeData(
      useMaterial3: true,
      brightness: Brightness.light,
      scaffoldBackgroundColor: AppColors.background,
      colorScheme: const ColorScheme.light(
        surface: AppColors.surface,
        primary: AppColors.primary,
        onPrimary: Colors.white,
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
      cardTheme: CardThemeData(
        color: AppColors.surface,
        elevation: 0,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: AppColors.surface,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: const BorderSide(color: AppColors.border),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: const BorderSide(color: AppColors.border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: const BorderSide(color: AppColors.primary, width: 2),
        ),
        labelStyle: const TextStyle(color: AppColors.textMuted),
      ),
    );
  }

  static ThemeData get dark {
    const bg = Color(0xFF111A1A);
    const surface = Color(0xFF1C2828);
    const primary = Color(0xFF4DB6AC);
    const textMain = Color(0xFFE0ECEC);
    const textMuted = Color(0xFF7A9090);

    final base = ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      scaffoldBackgroundColor: bg,
      colorScheme: const ColorScheme.dark(
        surface: surface,
        primary: primary,
        onPrimary: Colors.black,
        secondary: Color(0xFF6A8080),
        onSurface: textMain,
        error: Color(0xFFEF4444),
      ),
    );

    return base.copyWith(
      appBarTheme: AppBarTheme(
        elevation: 0,
        centerTitle: false,
        backgroundColor: bg,
        foregroundColor: textMain,
        titleTextStyle: GoogleFonts.inter(
          fontSize: 18,
          fontWeight: FontWeight.w700,
          letterSpacing: 1.2,
          color: textMain,
        ),
      ),
      drawerTheme: const DrawerThemeData(backgroundColor: surface),
      textTheme: GoogleFonts.interTextTheme(base.textTheme).apply(
        bodyColor: textMain,
        displayColor: textMain,
      ),
      cardTheme: CardThemeData(
        color: surface,
        elevation: 0,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: const Color(0xFF243030),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: const BorderSide(color: Color(0xFF3A5050)),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: const BorderSide(color: Color(0xFF3A5050)),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: const BorderSide(color: primary, width: 2),
        ),
        labelStyle: const TextStyle(color: textMuted),
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
