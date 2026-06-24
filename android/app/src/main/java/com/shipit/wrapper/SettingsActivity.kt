package com.shipit.wrapper

import android.app.Activity
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import com.shipit.wrapper.databinding.ActivitySettingsBinding

/**
 * URL configuration screen. Shown automatically on first launch (when
 * [Prefs.shipitUrl] is null), and reachable later via the overflow menu in
 * [MainActivity].
 *
 * Validates that the input parses as an `http(s)` URL with a host. `http://`
 * is allowed for two cases: debug builds (local LAN testing), and any host on
 * a Tailscale tailnet (`*.ts.net`), where ShipIt is served over plain HTTP
 * because no wildcard TLS cert exists for `*.ts.net` — WireGuard already
 * encrypts the tailnet end-to-end. Every other production host must be HTTPS.
 */
class SettingsActivity : AppCompatActivity() {
    private lateinit var binding: ActivitySettingsBinding
    private lateinit var prefs: Prefs

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivitySettingsBinding.inflate(layoutInflater)
        setContentView(binding.root)

        applyInsets()

        prefs = Prefs(applicationContext)

        binding.urlInput.setText(prefs.shipitUrl ?: "")
        binding.saveButton.setOnClickListener { onSaveClicked() }

        // Show the running build so a tester can confirm exactly which version is
        // installed before reinstalling. versionCode is the unique, increasing
        // build number (epoch seconds; matches the GitHub Actions build).
        binding.versionText.text = getString(
            R.string.settings_version,
            BuildConfig.VERSION_NAME,
            BuildConfig.VERSION_CODE,
        )
    }

    /**
     * targetSdk 35 enforces edge-to-edge, so the form would otherwise sit under
     * the status bar (top) and, with the keyboard open, under the IME (bottom).
     * Pad the scrolling root by the union of the system-bar and IME insets on
     * every side so the URL field, helper text, and Save button stay clear of
     * both the status bar and the keyboard. Combining the two inset types makes
     * the bottom padding the larger of nav-bar / keyboard height automatically.
     */
    private fun applyInsets() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        ViewCompat.setOnApplyWindowInsetsListener(binding.root) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime(),
            )
            view.updatePadding(
                left = bars.left,
                top = bars.top,
                right = bars.right,
                bottom = bars.bottom,
            )
            insets
        }
    }

    private fun onSaveClicked() {
        val raw = binding.urlInput.text?.toString()?.trim().orEmpty()
        val normalized = normalize(raw)
        val error = validate(normalized)
        if (error != null) {
            binding.urlLayout.error = error
            return
        }
        binding.urlLayout.error = null
        prefs.shipitUrl = normalized
        setResult(Activity.RESULT_OK)
        finish()
    }

    private fun normalize(input: String): String {
        if (input.isEmpty()) return input
        // Default to https:// if the user typed just "shipit.example.com".
        val withScheme = if (input.startsWith("http://") || input.startsWith("https://")) {
            input
        } else {
            "https://$input"
        }
        // Strip trailing slashes — the WebView is happy without them and it
        // makes the host comparison in MainActivity cleaner.
        return withScheme.trimEnd('/')
    }

    private fun validate(url: String): String? {
        if (url.isEmpty()) return getString(R.string.settings_error_empty)
        val parsed = runCatching { android.net.Uri.parse(url) }.getOrNull()
            ?: return getString(R.string.settings_error_invalid)
        val scheme = parsed.scheme?.lowercase()
        val host = parsed.host
        if (host.isNullOrBlank()) return getString(R.string.settings_error_invalid)
        val cleartextOk = BuildConfig.DEBUG || isTailnetHost(host)
        if (scheme != "https" && !(cleartextOk && scheme == "http")) {
            return getString(R.string.settings_error_https_required)
        }
        return null
    }

    /**
     * True for MagicDNS hosts on a Tailscale tailnet (`*.ts.net`), which are
     * served over plain HTTP. Kept in sync with the `ts.net` domain rule in
     * `res/xml/network_security_config.xml` — both must allow the same hosts or
     * a URL that passes validation here still fails the platform cleartext
     * check at load time. The bare MagicDNS short name (e.g. `shipit`) and the
     * raw `100.x` tailnet IP are intentionally NOT matched: only the full FQDN
     * lets ShipIt's preview subdomains resolve and matches the network config.
     */
    private fun isTailnetHost(host: String): Boolean {
        val h = host.lowercase()
        return h == "ts.net" || h.endsWith(".ts.net")
    }
}
