package com.shopcarbon.wmspc.auth

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import com.shopcarbon.wmspc.util.Diag
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Saved login for biometric sign-in.
 *
 * The password is AES-256-GCM encrypted with a key that lives in the Android hardware keystore and
 * can only be used right after a Class-3 biometric (fingerprint) or the device PIN/pattern succeeds
 * (per-use authentication, timeout 0). Enrolling a new fingerprint invalidates the key, which
 * invalidates the saved login. The email is stored in plain preferences (it is not a secret).
 */
class SecureStore(ctx: Context) {
    companion object {
        private const val KEY_ALIAS = "carbonwms_pc_login_v1"
        private const val PREFS = "carbonwms_pc_auth"
        private const val K_EMAIL = "email"
        private const val K_CT = "ct"
        private const val K_IV = "iv"
        private const val TRANSFORM = "AES/GCM/NoPadding"
        const val AUTHENTICATORS = KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL
    }

    private val sp = ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun hasSaved(): Boolean = sp.contains(K_CT) && sp.contains(K_IV) && !sp.getString(K_EMAIL, null).isNullOrBlank()

    fun email(): String? = sp.getString(K_EMAIL, null)

    /** Cipher for enrolling a new saved login. Must be unlocked through BiometricPrompt before use. */
    fun encryptCipher(): Cipher? = try {
        Cipher.getInstance(TRANSFORM).apply { init(Cipher.ENCRYPT_MODE, getOrCreateKey()) }
    } catch (e: KeyPermanentlyInvalidatedException) {
        Diag.log("secure store: key invalidated on encrypt → reset"); clear(); null
    } catch (e: Exception) {
        Diag.log("secure store: encrypt cipher failed: $e"); null
    }

    /** Cipher for reading the saved login. Null when nothing is saved or the key was invalidated. */
    fun decryptCipher(): Cipher? {
        val iv = sp.getString(K_IV, null)?.let { Base64.decode(it, Base64.NO_WRAP) } ?: return null
        return try {
            Cipher.getInstance(TRANSFORM).apply { init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(128, iv)) }
        } catch (e: KeyPermanentlyInvalidatedException) {
            Diag.log("secure store: key invalidated (biometrics changed) → saved login removed"); clear(); null
        } catch (e: Exception) {
            Diag.log("secure store: decrypt cipher failed: $e"); clear(); null
        }
    }

    /** Call with the cipher returned by BiometricPrompt (authenticated). */
    fun save(email: String, authenticatedCipher: Cipher, password: String): Boolean = runCatching {
        val ct = authenticatedCipher.doFinal(password.toByteArray(Charsets.UTF_8))
        sp.edit()
            .putString(K_EMAIL, email)
            .putString(K_CT, Base64.encodeToString(ct, Base64.NO_WRAP))
            .putString(K_IV, Base64.encodeToString(authenticatedCipher.iv, Base64.NO_WRAP))
            .apply()
        Diag.log("secure store: saved login for $email")
        true
    }.onFailure { Diag.log("secure store: save failed: $it") }.getOrDefault(false)

    /** Call with the cipher returned by BiometricPrompt (authenticated). */
    fun load(authenticatedCipher: Cipher): String? = runCatching {
        val ct = Base64.decode(sp.getString(K_CT, null) ?: return null, Base64.NO_WRAP)
        String(authenticatedCipher.doFinal(ct), Charsets.UTF_8)
    }.onFailure { Diag.log("secure store: load failed: $it") }.getOrNull()

    fun clear() {
        sp.edit().clear().apply()
        runCatching {
            KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(KEY_ALIAS)
        }
    }

    private fun getOrCreateKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val spec = KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .setUserAuthenticationParameters(0, AUTHENTICATORS)
            .setInvalidatedByBiometricEnrollment(true)
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply { init(spec) }.generateKey()
    }
}
