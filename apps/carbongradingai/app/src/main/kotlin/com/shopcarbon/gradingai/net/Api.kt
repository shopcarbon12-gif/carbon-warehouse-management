package com.shopcarbon.gradingai.net

import android.webkit.CookieManager
import com.shopcarbon.gradingai.BuildConfig
import com.shopcarbon.gradingai.auth.Vault
import com.shopcarbon.gradingai.model.AppConfig
import com.shopcarbon.gradingai.model.CatalogRow
import com.shopcarbon.gradingai.model.Lookup
import com.shopcarbon.gradingai.model.Queue
import com.shopcarbon.gradingai.model.SaveResult
import com.shopcarbon.gradingai.util.Prefs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.File
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

class ApiError(val status: Int, message: String) : Exception(message)

/**
 * The WMS, as the phone sees it. Every call carries the session as a Bearer
 * token (the WMS accepts it on every /api route); a 401 signs in again with the
 * saved login once and retries, so an expired session never interrupts work.
 */
class Api(private val prefs: Prefs, private val vault: Vault) {
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()
    // The AI assist works through close-ups for up to ~2.5 minutes.
    private val slow = http.newBuilder().readTimeout(200, TimeUnit.SECONDS).build()

    val origin get() = prefs.origin

    suspend fun login(email: String, password: String): String = withContext(Dispatchers.IO) {
        val body = JSONObject().put("email", email).put("password", password).toString()
            .toRequestBody("application/json".toMediaType())
        val req = Request.Builder().url("$origin/api/auth/login").post(body)
            .header("X-Carbon-Mobile", "1").header("Accept", "application/json").header("User-Agent", ua()).build()
        http.newCall(req).execute().use { res ->
            val text = res.body?.string().orEmpty()
            val j = runCatching { JSONObject(text) }.getOrNull()
            if (!res.isSuccessful) throw ApiError(res.code, j?.optString("error")?.takeIf { it.isNotBlank() } ?: "Sign-in failed (${res.code})")
            val token = j?.optString("token").orEmpty()
            if (token.isBlank()) throw ApiError(res.code, "CarbonWMS did not return a session.")
            vault.saveLogin(email, password)
            vault.setToken(token)
            syncWebCookie(token)
            token
        }
    }

    /** The WebView (Studio, SEO) shares the session through its cookie. */
    fun syncWebCookie(token: String? = vault.token()) {
        if (token.isNullOrBlank()) return
        val secure = if (origin.startsWith("https://")) "; Secure" else ""
        CookieManager.getInstance().setCookie(origin, "wms_session=$token; Path=/; Max-Age=604800; HttpOnly; SameSite=Lax$secure")
        CookieManager.getInstance().flush()
    }

    suspend fun config(): AppConfig {
        val j = getJson("/api/grading-app/config")
        prefs.configJson = j.toString()
        return AppConfig.parse(j)
    }

    suspend fun lookupCode(code: String): Lookup = Lookup.parse(getJson("/api/grading-app/lookup?code=${enc(code)}"))
    suspend fun lookupMatrix(matrixId: String): Lookup = Lookup.parse(getJson("/api/grading-app/lookup?matrixId=${enc(matrixId)}"))
    suspend fun queue(): Queue = Queue.parse(getJson("/api/grading-app/queue"))

    /** The Catalog tab: name, UPC, custom SKU, vendor or colour. */
    suspend fun catalog(q: String, filter: String): List<CatalogRow> =
        CatalogRow.parseList(getJson("/api/grading-app/catalog?q=${enc(q)}&filter=${enc(filter)}&limit=60"))

    /** Compare: copy another product's grading onto every size of this one (the compared size as edited). */
    suspend fun copyGrading(fromMatrixId: String, toMatrixId: String, overrides: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        val body = JSONObject().put("fromMatrixId", fromMatrixId).put("toMatrixId", toMatrixId).put("overrides", overrides)
            .toString().toRequestBody("application/json".toMediaType())
        call { Request.Builder().url("$origin/api/grading-app/copy").post(body) }
    }

    /** Undo a Compare copy. */
    suspend fun undoCopy(rowIds: org.json.JSONArray): JSONObject = withContext(Dispatchers.IO) {
        val body = JSONObject().put("rowIds", rowIds).toString().toRequestBody("application/json".toMediaType())
        call { Request.Builder().url("$origin/api/grading-app/copy").delete(body) }
    }

    /** One saved scan with its lines (to edit it). */
    suspend fun scan(id: String): JSONObject = getJson("/api/grading-app/scans/${enc(id)}").let { it.optJSONObject("scan") ?: it }

    /** Lines moved on a saved scan: CarbonWMS works the numbers out again and updates the items. */
    suspend fun adjustScan(id: String, lines: JSONObject, crotchLines: JSONObject?): JSONObject = withContext(Dispatchers.IO) {
        val body = JSONObject().put("action", "adjust").put("lines", lines).put("crotchLines", crotchLines ?: JSONObject.NULL)
            .toString().toRequestBody("application/json".toMediaType())
        call { Request.Builder().url("$origin/api/grading-app/scans/${enc(id)}").patch(body) }
    }

    /** The scan's photo → the product's Carbon Studio, FRONT section. */
    suspend fun sendToStudio(scanId: String): JSONObject = withContext(Dispatchers.IO) {
        call { Request.Builder().url("$origin/api/grading-app/scans/${enc(scanId)}/studio").post(ByteArray(0).toRequestBody(null)) }
    }

    /** Fabric / care read off a care label → the WMS (fills gaps only). Returns what the WMS now holds. */
    suspend fun saveLabel(matrixId: String, fabric: String?, care: String?): JSONObject = withContext(Dispatchers.IO) {
        val body = JSONObject().put("matrixId", matrixId).put("fabric", fabric ?: JSONObject.NULL).put("care", care ?: JSONObject.NULL)
            .toString().toRequestBody("application/json".toMediaType())
        call { Request.Builder().url("$origin/api/grading-app/label").post(body) }
    }

    /** An accuracy check (known-size object, corner to corner) → the WMS list, with its photo. Diagnostic only. */
    suspend fun saveAccuracyCheck(check: JSONObject, photo: File?): JSONObject {
        val b = MultipartBody.Builder().setType(MultipartBody.FORM).addFormDataPart("meta", check.toString())
        if (photo != null && photo.exists()) b.addFormDataPart("photo", "check.jpg", photo.asBody("image/jpeg"))
        return sendJson("/api/grading-app/accuracy-checks", b.build(), http)
    }

    /** AI assist: the squared-up photo and the points to place. */
    suspend fun assist(photo: File, profile: String, pxPerCm: Double, keys: List<String>, repeat: Int = 1): JSONObject {
        val meta = JSONObject().put("profile", profile).put("pxPerCm", pxPerCm).put("keys", org.json.JSONArray(keys))
        if (repeat > 1) meta.put("repeat", repeat)
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("meta", meta.toString())
            .addFormDataPart("photo", "photo.jpg", photo.asBody("image/jpeg"))
            .build()
        return sendJson("/api/grading-app/assist", body, slow)
    }

    suspend fun saveScan(meta: JSONObject, photo: File?, crotchPhoto: File? = null): SaveResult {
        val b = MultipartBody.Builder().setType(MultipartBody.FORM).addFormDataPart("meta", meta.toString())
        if (photo != null && photo.exists()) b.addFormDataPart("photo", "photo.jpg", photo.asBody("image/jpeg"))
        if (crotchPhoto != null && crotchPhoto.exists()) b.addFormDataPart("crotchPhoto", "crotch.jpg", crotchPhoto.asBody("image/jpeg"))
        return SaveResult.parse(sendJson("/api/grading-app/scans", b.build(), http))
    }

    suspend fun download(url: String, to: File, onProgress: (Float) -> Unit = {}) = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(if (url.startsWith("http")) url else "$origin$url").header("User-Agent", ua()).build()
        slow.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw ApiError(res.code, "Download failed (${res.code})")
            val total = res.body?.contentLength() ?: -1L
            to.parentFile?.mkdirs()
            res.body!!.byteStream().use { input ->
                to.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    var done = 0L
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        done += n
                        if (total > 0) onProgress(done.toFloat() / total)
                    }
                }
            }
        }
    }

    private suspend fun getJson(path: String): JSONObject = withContext(Dispatchers.IO) {
        call { Request.Builder().url("$origin$path").get() }
    }

    private suspend fun sendJson(path: String, body: RequestBody, client: OkHttpClient): JSONObject = withContext(Dispatchers.IO) {
        call(client) { Request.Builder().url("$origin$path").post(body) }
    }

    private fun call(client: OkHttpClient = http, build: () -> Request.Builder): JSONObject {
        fun run(): Response = client.newCall(
            build().header("Authorization", "Bearer ${vault.token().orEmpty()}")
                .header("Accept", "application/json").header("User-Agent", ua()).build(),
        ).execute()
        var res = run()
        if (res.code == 401 && relogin()) {
            res.close()
            res = run()
        }
        res.use {
            val text = it.body?.string().orEmpty()
            val j = runCatching { JSONObject(text) }.getOrNull()
            if (!it.isSuccessful) {
                throw ApiError(it.code, j?.optString("error")?.takeIf { e -> e.isNotBlank() } ?: "CarbonWMS answered ${it.code}")
            }
            return j ?: throw ApiError(it.code, "CarbonWMS sent something that is not JSON.")
        }
    }

    /** Silent sign-in with the saved login (blocking; called on the IO thread). */
    private fun relogin(): Boolean {
        val email = vault.email() ?: return false
        val pw = vault.password() ?: return false
        return runCatching {
            val body = JSONObject().put("email", email).put("password", pw).toString().toRequestBody("application/json".toMediaType())
            http.newCall(
                Request.Builder().url("$origin/api/auth/login").post(body).header("X-Carbon-Mobile", "1").header("User-Agent", ua()).build(),
            ).execute().use { res ->
                if (!res.isSuccessful) return@use false
                val token = JSONObject(res.body?.string().orEmpty()).optString("token")
                if (token.isBlank()) return@use false
                vault.setToken(token)
                syncWebCookie(token)
                true
            }
        }.getOrDefault(false)
    }

    private fun File.asBody(type: String): RequestBody = asRequestBody(type.toMediaType())

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
    private fun ua() = "CarbonGradingAI/${BuildConfig.VERSION_NAME} (Android ${android.os.Build.VERSION.RELEASE}; ${android.os.Build.MODEL})"
}
