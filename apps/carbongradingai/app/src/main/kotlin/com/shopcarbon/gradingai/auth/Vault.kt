package com.shopcarbon.gradingai.auth

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The sign-in, encrypted with a key that never leaves the phone's hardware
 * keystore. Only the owner uses the app (plan v3), so it keeps the password and
 * signs in again by itself when the 7-day WMS session runs out — a measuring
 * session is never interrupted by a login screen.
 */
class Vault(ctx: Context) {
    private val sp = ctx.getSharedPreferences("vault", Context.MODE_PRIVATE)

    fun email(): String? = sp.getString("email", null)
    fun hasLogin(): Boolean = !email().isNullOrBlank() && sp.contains("pw")

    fun token(): String? = read("tok")
    fun setToken(t: String?) = if (t == null) sp.edit().remove("tok").apply() else write("tok", t)

    fun password(): String? = read("pw")

    fun saveLogin(email: String, password: String) {
        sp.edit().putString("email", email).apply()
        write("pw", password)
    }

    fun clear() = sp.edit().clear().apply()

    private fun write(k: String, v: String) {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        val ct = c.doFinal(v.toByteArray(Charsets.UTF_8))
        sp.edit()
            .putString(k, Base64.encodeToString(ct, Base64.NO_WRAP))
            .putString("$k.iv", Base64.encodeToString(c.iv, Base64.NO_WRAP))
            .apply()
    }

    private fun read(k: String): String? = runCatching {
        val ct = Base64.decode(sp.getString(k, null) ?: return null, Base64.NO_WRAP)
        val iv = Base64.decode(sp.getString("$k.iv", null) ?: return null, Base64.NO_WRAP)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
        String(c.doFinal(ct), Charsets.UTF_8)
    }.getOrNull()

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    private companion object { const val ALIAS = "carbongradingai.vault" }
}
