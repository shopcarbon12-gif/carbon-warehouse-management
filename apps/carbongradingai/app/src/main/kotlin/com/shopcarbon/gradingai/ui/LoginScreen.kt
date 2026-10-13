package com.shopcarbon.gradingai.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.shopcarbon.gradingai.App
import kotlinx.coroutines.launch

/** WMS sign-in. The login is kept (encrypted) so the app signs in again by itself. */
@Composable
fun LoginScreen(onDone: () -> Unit) {
    val app = App.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    var email by remember { mutableStateOf(app.vault.email().orEmpty()) }
    var pw by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var err by remember { mutableStateOf<String?>(null) }
    val activity = LocalContext.current as? androidx.fragment.app.FragmentActivity
    val canFinger = remember { activity?.let { com.shopcarbon.gradingai.auth.Biometric.available(it) } == true }
    var useFinger by remember { mutableStateOf(canFinger) }
    Column(
        Modifier.fillMaxSize().padding(24.dp).imePadding(),
        verticalArrangement = Arrangement.spacedBy(14.dp, androidx.compose.ui.Alignment.CenterVertically),
    ) {
        Text("CarbonGradingAI", style = MaterialTheme.typography.headlineSmall, color = Palette.text)
        Muted("Sign in with your WMS account. Measurements save straight into the WMS.")
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(email, { email = it }, Modifier.fillMaxWidth(), label = { Text("Email") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email))
        OutlinedTextField(pw, { pw = it }, Modifier.fillMaxWidth(), label = { Text("Password") }, singleLine = true,
            visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
        if (canFinger) androidx.compose.foundation.layout.Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            Text("Unlock with fingerprint next time", Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, color = Palette.text)
            androidx.compose.material3.Switch(useFinger, { useFinger = it })
        }
        err?.let { Notice(it, Palette.bad) }
        Primary(if (busy) "Signing in…" else "Sign in", enabled = !busy && email.isNotBlank() && pw.isNotBlank()) {
            busy = true; err = null
            scope.launch {
                try {
                    app.api.login(email.trim(), pw)
                    app.prefs.biometricLock = canFinger && useFinger
                    runCatching { app.config = app.api.config() }
                    onDone()
                } catch (e: Exception) {
                    err = e.message ?: "Sign-in failed"
                } finally { busy = false }
            }
        }
        Muted("Server: ${app.prefs.origin}")
    }
}
