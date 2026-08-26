package com.shopcarbon.wmspc.settings

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewCompat
import com.google.android.material.materialswitch.MaterialSwitch
import com.shopcarbon.wmspc.BuildConfig
import com.shopcarbon.wmspc.MainActivity
import com.shopcarbon.wmspc.R
import com.shopcarbon.wmspc.auth.SecureStore
import com.shopcarbon.wmspc.util.Diag
import com.shopcarbon.wmspc.util.Prefs

/** Hidden support screen: long-press the app icon → Diagnostics, or the button on the offline page. */
class DiagnosticsActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContentView(R.layout.activity_diagnostics)
        val root = findViewById<android.view.View>(R.id.diag_root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, ins ->
            val b = ins.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            v.setPadding(b.left, b.top, b.right, b.bottom)
            WindowInsetsCompat.CONSUMED
        }

        val info = findViewById<TextView>(R.id.diag_info)
        val originField = findViewById<EditText>(R.id.diag_origin)
        val keepOn = findViewById<MaterialSwitch>(R.id.diag_keep_screen_on)
        val log = findViewById<TextView>(R.id.diag_log)

        originField.setText(Prefs.origin)
        keepOn.isChecked = Prefs.keepScreenOn
        keepOn.setOnCheckedChangeListener { _, checked -> Prefs.keepScreenOn = checked }

        findViewById<Button>(R.id.diag_save_origin).setOnClickListener {
            val v = originField.text.toString().trim().trimEnd('/')
            if (!v.startsWith("http://") && !v.startsWith("https://")) {
                Toast.makeText(this, "Origin must start with http:// or https://", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            Prefs.origin = v
            Diag.log("origin set to ${Prefs.origin}")
            startActivity(
                Intent(this, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    .putExtra(MainActivity.EXTRA_RELOAD, true),
            )
            finish()
        }

        findViewById<Button>(R.id.diag_clear).setOnClickListener {
            CookieManager.getInstance().removeAllCookies(null)
            CookieManager.getInstance().flush()
            WebStorage.getInstance().deleteAllData()
            Diag.log("cookies + site data cleared from Diagnostics")
            Toast.makeText(this, "Cleared — you will need to log in again", Toast.LENGTH_SHORT).show()
            render(info, log)
        }

        findViewById<Button>(R.id.diag_forget_login).setOnClickListener {
            SecureStore(this).clear()
            Diag.log("saved biometric login removed from Diagnostics")
            Toast.makeText(this, "Saved fingerprint login removed", Toast.LENGTH_SHORT).show()
            render(info, log)
        }

        findViewById<Button>(R.id.diag_share).setOnClickListener {
            val text = buildString {
                appendLine(summary())
                appendLine()
                appendLine("--- log ---")
                appendLine(Diag.dump())
                Diag.lastCrash()?.let { appendLine(); appendLine("--- last crash ---"); appendLine(it) }
            }
            startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text), "Share logs"))
        }

        render(info, log)
    }

    private fun render(info: TextView, log: TextView) {
        info.text = summary()
        log.text = Diag.dump()
    }

    private fun summary(): String {
        val wv = WebViewCompat.getCurrentWebViewPackage(this)
        val cookie = CookieManager.getInstance().getCookie(Prefs.origin)
        val hasSession = cookie?.contains("wms_session=") == true
        return buildString {
            appendLine("CarbonWMS-PC ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE}) ${BuildConfig.APPLICATION_ID}")
            appendLine("Device: ${Build.MANUFACTURER} ${Build.MODEL} · Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
            appendLine("WebView: ${wv?.packageName ?: "?"} ${wv?.versionName ?: "?"} (min Chrome ${BuildConfig.MIN_WEBVIEW_MAJOR})")
            appendLine("Server: ${Prefs.origin}")
            appendLine("Session cookie: ${if (hasSession) "present" else "none (login required)"}")
            appendLine("Network: ${network()}")
            appendLine("Keep screen on: ${Prefs.keepScreenOn}")
            appendLine("Saved fingerprint login: ${SecureStore(this@DiagnosticsActivity).email() ?: "none"}")
            append("Install id: ${Prefs.installId}")
        }
    }

    private fun network(): String {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return "offline"
        return when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "Wi-Fi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "Ethernet"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "Cellular"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "VPN"
            else -> "other"
        }
    }
}
