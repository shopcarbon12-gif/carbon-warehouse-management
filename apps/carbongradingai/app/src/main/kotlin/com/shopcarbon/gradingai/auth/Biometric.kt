package com.shopcarbon.gradingai.auth

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity

/** Fingerprint (or the phone's PIN / pattern) to open the app. */
object Biometric {
    private const val KINDS = BIOMETRIC_STRONG or DEVICE_CREDENTIAL

    fun available(a: FragmentActivity): Boolean = BiometricManager.from(a).canAuthenticate(KINDS) == BiometricManager.BIOMETRIC_SUCCESS

    fun prompt(a: FragmentActivity, onOk: () -> Unit, onFail: (String) -> Unit) {
        val p = BiometricPrompt(a, ContextCompat.getMainExecutor(a), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = onOk()
            override fun onAuthenticationError(code: Int, msg: CharSequence) = onFail(msg.toString())
        })
        p.authenticate(
            BiometricPrompt.PromptInfo.Builder()
                .setTitle("CarbonTools")
                .setSubtitle("Unlock with your fingerprint")
                .setAllowedAuthenticators(KINDS)
                .build(),
        )
    }
}
