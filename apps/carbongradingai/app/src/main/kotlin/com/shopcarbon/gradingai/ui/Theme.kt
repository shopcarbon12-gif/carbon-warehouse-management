package com.shopcarbon.gradingai.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/** One dark palette: the app is used over a bright table and in the camera view. */
object Palette {
    val ground = Color(0xFF0C0F12)
    val surface = Color(0xFF151A1F)
    val raised = Color(0xFF1D242B)
    val line = Color(0xFF2A333B)
    val text = Color(0xFFE8ECEF)
    val muted = Color(0xFF8E99A3)
    val accent = Color(0xFF3DDC97)
    val accentDim = Color(0xFF1F5E46)
    val warn = Color(0xFFF5B83D)
    val bad = Color(0xFFFF6B6B)
    val ai = Color(0xFF7FB8FF)
    val manual = Color(0xFFFFB86B)
}

private val scheme = darkColorScheme(
    primary = Palette.accent,
    onPrimary = Color(0xFF00281A),
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
    headlineSmall = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 22.sp, lineHeight = 28.sp),
    titleLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 19.sp, lineHeight = 24.sp),
    titleMedium = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 16.sp, lineHeight = 22.sp),
    bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 22.sp),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
    bodySmall = TextStyle(fontSize = 12.sp, lineHeight = 16.sp),
    labelLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 15.sp),
    labelMedium = TextStyle(fontWeight = FontWeight.Medium, fontSize = 13.sp, letterSpacing = 0.3.sp),
    labelSmall = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 11.sp, letterSpacing = 0.4.sp),
)

@Composable
fun GradingTheme(content: @Composable () -> Unit) = MaterialTheme(colorScheme = scheme, typography = type, content = content)
