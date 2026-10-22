package com.shopcarbon.gradingai.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * Light, Apple iOS 26 style (owner-approved mockups, 2026-10-22): system grey
 * grounds, white grouped cards, Apple blue as the one accent; green, orange
 * and red only for status. The camera keeps its own dark glass overlay.
 */
object Palette {
    val ground = Color(0xFFF2F2F7)
    val surface = Color(0xFFFFFFFF)
    /** Tinted buttons, chips, image placeholders. */
    val raised = Color(0xFFE9E9EE)
    val line = Color(0xFFE3E3E8)
    val text = Color(0xFF1C1C1E)
    val muted = Color(0xFF8E8E93)
    val accent = Color(0xFF007AFF)
    val accentSoft = Color(0xFFE5F0FF)
    val ok = Color(0xFF34C759)
    val warn = Color(0xFFFF9500)
    val bad = Color(0xFFFF3B30)
    /** Line colours on the photo: from the outline, placed by the AI, moved by you. */
    val outline = Color(0xFF34C759)
    val ai = Color(0xFF5856D6)
    val manual = Color(0xFFFF9500)
    /** The camera overlay's dark glass. */
    val glassDark = Color(0x8C000000)
}

private val scheme = lightColorScheme(
    primary = Palette.accent,
    onPrimary = Color.White,
    secondary = Palette.ai,
    background = Palette.ground,
    onBackground = Palette.text,
    surface = Palette.surface,
    onSurface = Palette.text,
    surfaceVariant = Palette.raised,
    onSurfaceVariant = Palette.muted,
    outline = Palette.line,
    error = Palette.bad,
)

private val type = Typography(
    /** iOS large title. */
    headlineLarge = TextStyle(fontWeight = FontWeight.Bold, fontSize = 32.sp, lineHeight = 38.sp, letterSpacing = (-0.4).sp),
    headlineSmall = TextStyle(fontWeight = FontWeight.Bold, fontSize = 24.sp, lineHeight = 30.sp),
    titleLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 19.sp, lineHeight = 24.sp),
    titleMedium = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 16.sp, lineHeight = 22.sp),
    bodyLarge = TextStyle(fontSize = 17.sp, lineHeight = 22.sp),
    bodyMedium = TextStyle(fontSize = 15.sp, lineHeight = 20.sp),
    bodySmall = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
    labelLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 17.sp),
    labelMedium = TextStyle(fontWeight = FontWeight.Medium, fontSize = 13.sp),
    labelSmall = TextStyle(fontWeight = FontWeight.Medium, fontSize = 12.sp, letterSpacing = 0.3.sp),
)

/** The Carbon logo's typeface (Neuzeit Grotesk), for the app's name. */
val Brand = FontFamily(androidx.compose.ui.text.font.Font(com.shopcarbon.gradingai.R.font.neuzeit_grotesk))

/** Numbers that line up (measurements). */
val Mono = FontFamily.Monospace

@Composable
fun GradingTheme(content: @Composable () -> Unit) = MaterialTheme(colorScheme = scheme, typography = type, content = content)
