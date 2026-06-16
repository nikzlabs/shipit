package com.shipit.wrapper

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.view.Menu
import android.view.MenuItem
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.shipit.wrapper.databinding.ActivityMainBinding

/**
 * Full-bleed [WebView] host. Launches [SettingsActivity] on first run when no
 * URL is configured, otherwise loads the saved URL.
 *
 * Navigation policy: URLs on the configured host load inside the WebView.
 * Cloudflare Access authentication also stays in the WebView because its
 * `CF_Authorization` cookie must be written to the WebView cookie jar; Android
 * does not share Chrome/system-browser cookies back into WebView. Other
 * external links are handed to the system browser via [Intent.ACTION_VIEW].
 */
class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private lateinit var prefs: Prefs

    private var configuredHost: String? = null
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private var inCloudflareAccessFlow = false

    // Voice dictation (docs/144): a WebView getUserMedia() call surfaces as an
    // onPermissionRequest. We can only grant it once the OS-level RECORD_AUDIO
    // permission is held, so we stash the pending request, run the runtime
    // permission prompt, then grant or deny on its result.
    private var pendingPermissionRequest: PermissionRequest? = null

    private val audioPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        val request = pendingPermissionRequest
        pendingPermissionRequest = null
        if (request == null) return@registerForActivityResult
        if (granted) {
            request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
        } else {
            request.deny()
        }
    }

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.GetMultipleContents(),
    ) { uris ->
        fileChooserCallback?.onReceiveValue(uris.toTypedArray())
        fileChooserCallback = null
    }

    private val settingsLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { _ ->
        // After settings closes, re-check the URL. If still missing, exit;
        // otherwise reload the WebView with the (possibly new) URL.
        loadConfiguredUrl()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        setSupportActionBar(binding.toolbar)
        // Toolbar exists for the overflow menu (Open Settings) but is visually
        // minimal — supportActionBar's title is hidden in the layout.
        supportActionBar?.setDisplayShowTitleEnabled(false)

        prefs = Prefs(applicationContext)

        val webView = binding.webView
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            useWideViewPort = true
            loadWithOverviewMode = true
            // Let the page request fullscreen video / etc.
            javaScriptCanOpenWindowsAutomatically = true
            setSupportMultipleWindows(false)
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                val target = request.url
                val targetHost = target.host?.lowercase()
                val ourHost = configuredHost
                if (ourHost != null && isCloudflareAccessNavigation(target, targetHost, ourHost)) {
                    inCloudflareAccessFlow = true
                    return false
                }
                return if (ourHost != null && targetHost == ourHost) {
                    if (!isCloudflareAccessCallback(target)) {
                        inCloudflareAccessFlow = false
                    }
                    // Same host as ShipIt — let the WebView handle it.
                    false
                } else {
                    if (inCloudflareAccessFlow && isHttpNavigation(target)) {
                        // Access policies may hand off to an IdP before
                        // returning to the Cloudflare callback on our host.
                        // Keep that chain in WebView so the final Access
                        // cookie lands where ShipIt will read it.
                        return false
                    }
                    // External URL — punt to the system browser. Keeps the
                    // WebView focused on the ShipIt app shell.
                    runCatching {
                        startActivity(Intent(Intent.ACTION_VIEW, target))
                    }
                    true
                }
            }

            override fun onPageFinished(view: WebView, url: String) {
                CookieManager.getInstance().flush()
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams,
            ): Boolean {
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = filePathCallback
                val mime = fileChooserParams.acceptTypes
                    .firstOrNull { it.isNotBlank() }
                    ?: "*/*"
                return runCatching {
                    fileChooserLauncher.launch(mime)
                    true
                }.getOrElse {
                    fileChooserCallback = null
                    false
                }
            }

            override fun onPermissionRequest(request: PermissionRequest) {
                val wantsAudio = request.resources.any { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }
                if (!wantsAudio) {
                    // We only support mic capture; deny anything else (camera, etc.).
                    request.deny()
                    return
                }
                val granted = ContextCompat.checkSelfPermission(
                    this@MainActivity,
                    Manifest.permission.RECORD_AUDIO,
                ) == PackageManager.PERMISSION_GRANTED
                if (granted) {
                    request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                } else {
                    pendingPermissionRequest = request
                    audioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                }
            }
        }

        // Hardware back = WebView history; fall through to default if at root.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (binding.webView.canGoBack()) {
                    binding.webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        loadConfiguredUrl()
    }

    private fun loadConfiguredUrl() {
        val url = prefs.shipitUrl
        if (url.isNullOrBlank()) {
            settingsLauncher.launch(Intent(this, SettingsActivity::class.java))
            return
        }
        configuredHost = Uri.parse(url).host?.lowercase()
        binding.webView.loadUrl(url)
    }

    private fun isCloudflareAccessNavigation(uri: Uri, host: String?, configuredHost: String): Boolean {
        return isCloudflareAccessHost(host) ||
            (host == configuredHost && isCloudflareAccessCallback(uri))
    }

    private fun isCloudflareAccessHost(host: String?): Boolean {
        if (host == null) return false
        return host == "cloudflareaccess.com" || host.endsWith(".cloudflareaccess.com")
    }

    private fun isCloudflareAccessCallback(uri: Uri): Boolean {
        return uri.path?.startsWith("/cdn-cgi/access/") == true
    }

    private fun isHttpNavigation(uri: Uri): Boolean {
        val scheme = uri.scheme?.lowercase()
        return scheme == "http" || scheme == "https"
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.main, menu)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean = when (item.itemId) {
        R.id.action_settings -> {
            settingsLauncher.launch(Intent(this, SettingsActivity::class.java))
            true
        }
        R.id.action_reload -> {
            binding.webView.reload()
            true
        }
        else -> super.onOptionsItemSelected(item)
    }

    override fun onDestroy() {
        // Detach the WebView before destroy to avoid leaks on configuration
        // change (we don't currently override configChanges, so onDestroy here
        // is a precaution).
        binding.webView.apply {
            stopLoading()
            settings.javaScriptEnabled = false
            removeAllViews()
            destroy()
        }
        super.onDestroy()
    }
}
