import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

/// Industrial dark palette — [AppTheme.dark] only (MaterialApp shell: boot + login).
abstract final class _IndustrialDark {
  static const Color background = Color(0xFF0F1115);
  static const Color surface = Color(0xFF1E2128);
  static const Color primary = Color(0xFF10B981);
  static const Color textMain = Color(0xFFF8FAFC);
  static const Color textMuted = Color(0xFF94A3B8);
  static const Color slateAction = Color(0xFF475569);
  static const Color slateActionDark = Color(0xFF334155);
}

/// CarbonWMS light warehouse tokens — used under [AppTheme.authenticated] (post-login).
abstract final class AppColors {
  static const Color background = Color(0xFFFFFFFF);
  static const Color surface = Color(0xFFF7F9F9);
  static const Color surfaceContainer = Color(0xFFF0F5F4);
  static const Color surfaceContainerHigh = Color(0xFFEDF2F1);
  static const Color outlineMuted = Color(0xFFDEE3E3);
  static const Color primary = Color(0xFF006768);
  static const Color primaryStrong = Color(0xFF008284);
  static const Color success = Color(0xFF0D9488);
  static const Color textMain = Color(0xFF171D1D);
  static const Color textMuted = Color(0xFF6D7979);
  static const Color textSecondary = Color(0xFF3D4949);
  static const Color slateAction = Color(0xFF6D7979);
  static const Color slateActionDark = Color(0xFF3D4949);

  /// Light warning strip / snackbar (queue, offline hints) — dark text for contrast.
  static const Color warningSurface = Color(0xFFFFEFD6);
}

abstract final class AppTheme {
  /// Unauthenticated shell — unchanged dark industrial (login + boot inherit this).
  static ThemeData get dark {
    final base = ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      scaffoldBackgroundColor: _IndustrialDark.background,
      colorScheme: const ColorScheme.dark(
        surface: _IndustrialDark.surface,
        primary: _IndustrialDark.primary,
        onPrimary: _IndustrialDark.background,
        secondary: _IndustrialDark.slateAction,
        onSurface: _IndustrialDark.textMain,
        error: Color(0xFFEF4444),
      ),
    );

    return base.copyWith(
      appBarTheme: AppBarTheme(
        elevation: 0,
        centerTitle: false,
        backgroundColor: _IndustrialDark.surface,
        foregroundColor: _IndustrialDark.textMain,
        titleTextStyle: GoogleFonts.inter(
          fontSize: 18,
          fontWeight: FontWeight.w700,
          letterSpacing: 1.2,
          color: _IndustrialDark.textMain,
        ),
      ),
      textTheme: GoogleFonts.interTextTheme(base.textTheme).apply(
        bodyColor: _IndustrialDark.textMain,
        displayColor: _IndustrialDark.textMain,
      ),
      cardTheme: CardThemeData(
        color: _IndustrialDark.surface,
        elevation: 0,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: _IndustrialDark.surface,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: const BorderSide(color: _IndustrialDark.slateActionDark),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: const BorderSide(color: _IndustrialDark.slateActionDark),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: const BorderSide(color: _IndustrialDark.primary, width: 2),
        ),
        labelStyle: const TextStyle(color: _IndustrialDark.textMuted),
      ),
    );
  }

  /// Authenticated handheld UI — light CarbonWMS warehouse theme.
  static ThemeData get authenticated {
    final base = ThemeData(
      useMaterial3: true,
      brightness: Brightness.light,
      visualDensity: VisualDensity.compact,
      scaffoldBackgroundColor: AppColors.background,
      colorScheme: const ColorScheme.light(
        primary: AppColors.primary,
        onPrimary: Colors.white,
        primaryContainer: AppColors.surfaceContainer,
        onPrimaryContainer: AppColors.textMain,
        secondary: AppColors.primaryStrong,
        onSecondary: Colors.white,
        surface: AppColors.surface,
        onSurface: AppColors.textMain,
        onSurfaceVariant: AppColors.textMuted,
        surfaceContainerHighest: AppColors.surfaceContainerHigh,
        outline: AppColors.outlineMuted,
        outlineVariant: AppColors.outlineMuted,
        error: Color(0xFFDC2626),
        onError: Colors.white,
      ),
    );

    final interBody = GoogleFonts.interTextTheme(base.textTheme).apply(
      bodyColor: AppColors.textMain,
      displayColor: AppColors.textMain,
    );

    return base.copyWith(
      scaffoldBackgroundColor: AppColors.background,
      appBarTheme: AppBarTheme(
        elevation: 0,
        scrolledUnderElevation: 0.5,
        centerTitle: false,
        backgroundColor: AppColors.background,
        foregroundColor: AppColors.textMain,
        surfaceTintColor: Colors.transparent,
        titleTextStyle: GoogleFonts.manrope(
          fontSize: 17,
          fontWeight: FontWeight.w700,
          letterSpacing: -0.2,
          color: AppColors.textMain,
        ),
        iconTheme: const IconThemeData(color: AppColors.textMain, size: 22),
      ),
      textTheme: interBody.copyWith(
        bodySmall: GoogleFonts.inter(
          fontSize: 12,
          height: 1.35,
          color: AppColors.textMuted,
        ),
        labelSmall: GoogleFonts.spaceGrotesk(
          fontSize: 10,
          fontWeight: FontWeight.w700,
          letterSpacing: 1.8,
          color: AppColors.textMuted,
        ),
        titleMedium: GoogleFonts.manrope(
          fontSize: 15,
          height: 1.3,
          fontWeight: FontWeight.w700,
          color: AppColors.textSecondary,
        ),
        titleLarge: GoogleFonts.manrope(
          fontSize: 20,
          height: 1.25,
          fontWeight: FontWeight.w800,
          color: AppColors.textMain,
        ),
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: AppColors.background,
        surfaceTintColor: Colors.transparent,
        titleTextStyle: GoogleFonts.manrope(
          fontSize: 18,
          fontWeight: FontWeight.w700,
          color: AppColors.textMain,
        ),
        contentTextStyle: GoogleFonts.inter(
          fontSize: 14,
          height: 1.4,
          color: AppColors.textSecondary,
        ),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(8),
          side: const BorderSide(color: AppColors.outlineMuted),
        ),
      ),
      listTileTheme: ListTileThemeData(
        iconColor: AppColors.textMuted,
        textColor: AppColors.textMain,
        titleTextStyle: GoogleFonts.inter(
          fontSize: 15,
          fontWeight: FontWeight.w600,
          color: AppColors.textMain,
        ),
        subtitleTextStyle: GoogleFonts.inter(
          fontSize: 12,
          height: 1.3,
          color: AppColors.textMuted,
        ),
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      ),
      bottomSheetTheme: const BottomSheetThemeData(
        backgroundColor: AppColors.background,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(8)),
        ),
      ),
      iconButtonTheme: IconButtonThemeData(
        style: IconButton.styleFrom(foregroundColor: AppColors.textMain),
      ),
      cardTheme: CardThemeData(
        color: AppColors.surface,
        elevation: 0,
        shadowColor: Color.fromARGB((0.06 * 255).round(), 0, 0, 0),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(8),
          side: const BorderSide(color: AppColors.outlineMuted),
        ),
      ),
      dividerTheme: const DividerThemeData(
        color: AppColors.outlineMuted,
        thickness: 1,
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: AppColors.surface,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(6),
          borderSide: const BorderSide(color: AppColors.outlineMuted),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(6),
          borderSide: const BorderSide(color: AppColors.outlineMuted),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(6),
          borderSide: const BorderSide(color: AppColors.primary, width: 2),
        ),
        labelStyle: const TextStyle(color: AppColors.textMuted, fontSize: 13),
        hintStyle: TextStyle(color: AppColors.textMuted.withValues(alpha: 0.9)),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: AppColors.primary,
          foregroundColor: Colors.white,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: AppColors.textMain,
          side: const BorderSide(color: AppColors.outlineMuted),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
        ),
      ),
      sliderTheme: SliderThemeData(
        activeTrackColor: AppColors.primary,
        inactiveTrackColor: AppColors.outlineMuted,
        thumbColor: AppColors.primary,
        overlayColor: AppColors.primary.withValues(alpha: 0.12),
      ),
      tabBarTheme: const TabBarThemeData(
        labelColor: AppColors.primary,
        unselectedLabelColor: AppColors.textMuted,
        dividerColor: AppColors.outlineMuted,
      ),
      snackBarTheme: SnackBarThemeData(
        backgroundColor: AppColors.textSecondary,
        contentTextStyle: GoogleFonts.inter(color: Colors.white, fontSize: 14),
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
      ),
      progressIndicatorTheme: const ProgressIndicatorThemeData(
        color: AppColors.primary,
      ),
    );
  }

  /// Uppercase section labels — Space Grotesk, wide tracking (warehouse ops).
  static TextStyle headline(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return GoogleFonts.spaceGrotesk(
      fontSize: 11,
      fontWeight: FontWeight.w700,
      letterSpacing: 2.4,
      color: cs.onSurfaceVariant,
    );
  }

  /// Secondary floor action — light fill, subtle border (COMMIT, APPEND EPCS, etc.).
  static ButtonStyle warehouseSecondaryAction() {
    return FilledButton.styleFrom(
      backgroundColor: AppColors.surfaceContainer,
      foregroundColor: AppColors.textMain,
      elevation: 0,
      padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 20),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(6),
        side: const BorderSide(color: AppColors.outlineMuted),
      ),
    );
  }
}
