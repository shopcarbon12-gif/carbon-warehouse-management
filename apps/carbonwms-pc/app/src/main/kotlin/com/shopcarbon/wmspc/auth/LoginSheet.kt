package com.shopcarbon.wmspc.auth

import android.net.Uri
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.core.view.isVisible
import com.google.android.material.materialswitch.MaterialSwitch
import com.google.android.material.progressindicator.CircularProgressIndicator
import com.google.android.material.textfield.TextInputEditText
import com.shopcarbon.wmspc.MainActivity
import com.shopcarbon.wmspc.R
import com.shopcarbon.wmspc.util.Diag
import com.shopcarbon.wmspc.util.Prefs
import javax.crypto.Cipher
import kotlin.concurrent.thread

/**
 * Native sign-in overlay shown whenever the WebView lands on /login.
 *  - email + password → POST /api/auth/login → cookie → continue to `next`
 *  - optional "use fingerprint / screen lock next time" (SecureStore)
 *  - with a saved login: BiometricPrompt → decrypt → sign in, no typing
 */
class LoginSheet(private val a: MainActivity, private val container: ViewGroup) {
    private val store = SecureStore(a)
    private val authenticators = BIOMETRIC_STRONG or DEVICE_CREDENTIAL

    private val subtitle: TextView
    private val email: TextInputEditText
    private val password: TextInputEditText
    private val remember: MaterialSwitch
    private val error: TextView
    private val status: TextView
    private val progress: CircularProgressIndicator
    private val btnSignIn: Button
    private val btnBiometric: Button
    private val btnForget: Button
    private val form: View

    private var nextPath: String? = null
    private var busy = false
    private var autoPromptDone = false

    val isVisible: Boolean get() = container.isVisible

    init {
        val v = LayoutInflater.from(a).inflate(R.layout.view_login, container, false)
        container.addView(v)
        subtitle = v.findViewById(R.id.login_subtitle)
        email = v.findViewById(R.id.login_email)
        password = v.findViewById(R.id.login_password)
        remember = v.findViewById(R.id.login_remember)
        error = v.findViewById(R.id.login_error)
        status = v.findViewById(R.id.login_status)
        progress = v.findViewById(R.id.login_progress)
        btnSignIn = v.findViewById(R.id.login_submit)
        btnBiometric = v.findViewById(R.id.login_biometric)
        btnForget = v.findViewById(R.id.login_forget)
        form = v.findViewById(R.id.login_form)

        btnSignIn.setOnClickListener { signIn() }
        btnBiometric.setOnClickListener { startBiometric() }
        btnForget.setOnClickListener {
            store.clear()
            Toast.makeText(a, R.string.login_forgotten, Toast.LENGTH_SHORT).show()
            refresh()
        }
        password.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE) { signIn(); true } else false
        }
    }

    /** Called by the WebViewClient when the main view navigates to /login[?next=…]. */
    fun onLoginPage(next: String?) {
        if (next != null) nextPath = next
        if (busy) return
        show()
        if (store.hasSaved() && canUseBiometrics() && !autoPromptDone) {
            autoPromptDone = true
            startBiometric()
        }
    }

    fun show() {
        refresh()
        container.isVisible = true
    }

    fun hide() {
        container.isVisible = false
    }

    private fun canUseBiometrics(): Boolean =
        BiometricManager.from(a).canAuthenticate(authenticators) == BiometricManager.BIOMETRIC_SUCCESS

    private fun refresh() {
        val saved = store.hasSaved()
        val bio = canUseBiometrics()
        subtitle.text = a.getString(R.string.login_subtitle, Uri.parse(Prefs.origin).host ?: Prefs.origin)
        if (saved && email.text.isNullOrBlank()) email.setText(store.email())
        btnBiometric.isVisible = saved && bio
        btnForget.isVisible = saved
        remember.isVisible = bio && !saved
        if (!bio) remember.isChecked = false
        setBusy(false)
    }

    private fun setBusy(b: Boolean, message: String? = null) {
        busy = b
        progress.isVisible = b
        status.isVisible = b && message != null
        status.text = message ?: ""
        form.alpha = if (b) 0.4f else 1f
        btnSignIn.isEnabled = !b
        btnBiometric.isEnabled = !b
        email.isEnabled = !b
        password.isEnabled = !b
    }

    private fun showError(msg: String?) {
        error.text = msg ?: ""
        error.isVisible = !msg.isNullOrBlank()
    }

    // ---- typed sign-in ------------------------------------------------------------------------

    private fun signIn() {
        if (busy) return
        val e = email.text?.toString()?.trim().orEmpty()
        val p = password.text?.toString().orEmpty()
        if (e.isBlank() || p.isBlank()) { showError(a.getString(R.string.login_missing)); return }
        showError(null)
        setBusy(true, a.getString(R.string.login_signing_in))
        thread(name = "wms-login") {
            val result = WmsAuth.login(Prefs.origin, e, p)
            a.runOnUiThread {
                when (result) {
                    is WmsAuth.Result.Ok -> {
                        password.setText("")
                        if (remember.isVisible && remember.isChecked) enroll(e, p) else finishLogin()
                    }
                    is WmsAuth.Result.Fail -> { setBusy(false); showError(result.message) }
                }
            }
        }
    }

    /** After a successful typed login: unlock the keystore key once and save the password. */
    private fun enroll(e: String, p: String) {
        val cipher = store.encryptCipher()
        if (cipher == null) { Toast.makeText(a, R.string.login_saved_not_enabled, Toast.LENGTH_SHORT).show(); finishLogin(); return }
        setBusy(true, a.getString(R.string.login_enrolling))
        prompt(
            subtitle = a.getString(R.string.login_bio_enroll_subtitle, e),
            cipher = cipher,
            onSuccess = { c ->
                val ok = store.save(e, c, p)
                Toast.makeText(a, if (ok) R.string.login_saved_enabled else R.string.login_saved_not_enabled, Toast.LENGTH_SHORT).show()
                finishLogin()
            },
            onFailure = { _, _ ->
                Toast.makeText(a, R.string.login_saved_not_enabled, Toast.LENGTH_SHORT).show()
                finishLogin()
            },
        )
    }

    // ---- biometric sign-in --------------------------------------------------------------------

    fun startBiometric() {
        if (busy) return
        val e = store.email()
        val cipher = store.decryptCipher()
        if (e == null || cipher == null) { refresh(); showError(a.getString(R.string.login_saved_expired)); return }
        showError(null)
        setBusy(true, a.getString(R.string.login_bio_waiting))
        prompt(
            subtitle = a.getString(R.string.login_bio_subtitle, e),
            cipher = cipher,
            onSuccess = { c ->
                val p = store.load(c)
                if (p == null) { store.clear(); refresh(); showError(a.getString(R.string.login_saved_expired)); return@prompt }
                setBusy(true, a.getString(R.string.login_signing_in))
                thread(name = "wms-login-bio") {
                    val result = WmsAuth.login(Prefs.origin, e, p)
                    a.runOnUiThread {
                        when (result) {
                            is WmsAuth.Result.Ok -> finishLogin()
                            is WmsAuth.Result.Fail -> {
                                if (result.status == 401) { store.clear(); refresh(); showError(a.getString(R.string.login_saved_invalid)) }
                                else { setBusy(false); showError(result.message) }
                            }
                        }
                    }
                }
            },
            onFailure = { code, msg ->
                setBusy(false)
                val silent = code == BiometricPrompt.ERROR_USER_CANCELED || code == BiometricPrompt.ERROR_NEGATIVE_BUTTON || code == BiometricPrompt.ERROR_CANCELED
                if (!silent) showError(msg)
            },
        )
    }

    private fun prompt(subtitle: String, cipher: Cipher, onSuccess: (Cipher) -> Unit, onFailure: (Int, String) -> Unit) {
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(a.getString(R.string.login_bio_title))
            .setSubtitle(subtitle)
            .setAllowedAuthenticators(authenticators)
            .setConfirmationRequired(false)
            .build()
        val prompt = BiometricPrompt(a, ContextCompat.getMainExecutor(a), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                val c = result.cryptoObject?.cipher
                if (c == null) onFailure(BiometricPrompt.ERROR_VENDOR, "No crypto object") else onSuccess(c)
            }
            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                Diag.log("biometric error $errorCode $errString")
                onFailure(errorCode, errString.toString())
            }
            override fun onAuthenticationFailed() { /* wrong finger — the prompt stays open */ }
        })
        runCatching { prompt.authenticate(info, BiometricPrompt.CryptoObject(cipher)) }
            .onFailure { Diag.log("biometric prompt failed: $it"); onFailure(BiometricPrompt.ERROR_VENDOR, it.message ?: "Biometric prompt unavailable") }
    }

    private fun finishLogin() {
        setBusy(false)
        showError(null)
        hide()
        a.onLoggedIn(nextPath)
        nextPath = null
    }
}
