package com.shipit.wrapper

import android.app.Activity
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import com.shipit.wrapper.databinding.ActivitySettingsBinding

/**
 * URL configuration screen. Shown automatically on first launch (when
 * [Prefs.shipitUrl] is null), and reachable later via the overflow menu in
 * [MainActivity].
 *
 * Validates that the input parses as an `http(s)` URL with a host. Allows
 * `http://` only in debug builds — production must be HTTPS so cookies and
 * websocket traffic are encrypted.
 */
class SettingsActivity : AppCompatActivity() {
    private lateinit var binding: ActivitySettingsBinding
    private lateinit var prefs: Prefs

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivitySettingsBinding.inflate(layoutInflater)
        setContentView(binding.root)

        prefs = Prefs(applicationContext)

        binding.urlInput.setText(prefs.shipitUrl ?: "")
        binding.saveButton.setOnClickListener { onSaveClicked() }
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
        if (scheme != "https" && !(BuildConfig.DEBUG && scheme == "http")) {
            return getString(R.string.settings_error_https_required)
        }
        return null
    }
}
