package com.shopcarbon.wmspc.auth

import android.webkit.CookieManager
import com.shopcarbon.wmspc.util.Diag
import com.shopcarbon.wmspc.web.WebViewConfig
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Native sign-in against the unchanged WMS endpoint POST /api/auth/login.
 * On success the server's Set-Cookie (wms_session, httpOnly/Secure/Lax, 7 days) is copied into the
 * WebView's CookieManager, so the page session is identical to a browser login.
 */
object WmsAuth {
    sealed class Result {
        object Ok : Result()
        data class Fail(val status: Int, val message: String) : Result()
    }

    fun login(origin: String, email: String, password: String): Result {
        return try {
            val conn = (URL("$origin/api/auth/login").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 15000
                readTimeout = 20000
                doOutput = true
                instanceFollowRedirects = false
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Accept", "application/json")
                setRequestProperty("X-Carbon-Mobile", "1")
                setRequestProperty("User-Agent", WebViewConfig.userAgent("Mozilla/5.0 (Linux; Android)"))
            }
            conn.outputStream.use { it.write(JSONObject().put("email", email).put("password", password).toString().toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            val body = (if (code in 200..299) conn.inputStream else conn.errorStream)?.bufferedReader()?.readText().orEmpty()
            val setCookies = conn.headerFields.entries.firstOrNull { it.key.equals("Set-Cookie", ignoreCase = true) }?.value.orEmpty()
            conn.disconnect()

            if (code !in 200..299) {
                val msg = runCatching { JSONObject(body).optString("error") }.getOrNull()?.takeIf { it.isNotBlank() } ?: "Login failed ($code)"
                Diag.log("native login: HTTP $code $msg")
                return Result.Fail(code, msg)
            }

            val cm = CookieManager.getInstance()
            var applied = false
            for (c in setCookies) {
                if (c.startsWith("wms_session=")) {
                    cm.setCookie(origin, c)
                    applied = true
                }
            }
            if (!applied) {
                val token = runCatching { JSONObject(body).optString("token") }.getOrNull().orEmpty()
                if (token.isBlank()) return Result.Fail(code, "No session returned by the server")
                val secure = if (origin.startsWith("https://")) "; Secure" else ""
                cm.setCookie(origin, "wms_session=$token; Path=/; Max-Age=604800; HttpOnly; SameSite=Lax$secure")
            }
            cm.flush()
            Diag.log("native login ok for $email (cookie ${if (applied) "from Set-Cookie" else "from token"})")
            Result.Ok
        } catch (e: Exception) {
            Diag.log("native login error: $e")
            Result.Fail(0, "Network error — ${e.message ?: e.javaClass.simpleName}")
        }
    }
}
