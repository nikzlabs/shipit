package com.shipit.wrapper

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
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
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
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

        applyEdgeToEdgeInsets()

        // The old toolbar is gone (it only hosted an overflow menu). Its two
        // actions now live as chrome-free affordances over the full-bleed
        // WebView: a translucent settings cog at top-center for Settings, and
        // long-press the cog for reload.
        binding.settingsButton.setOnClickListener {
            settingsLauncher.launch(Intent(this, SettingsActivity::class.java))
        }
        // Long-press the cog = reload. Pull-to-refresh was removed because it
        // fought ShipIt's internal scroll containers and stole chat scroll
        // gestures (see docs/116 plan.md:40).
        binding.settingsButton.setOnLongClickListener {
            binding.webView.reload()
            true
        }

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
                // Best-effort: ask the remote page to extend its layout under the
                // system bars by forcing `viewport-fit=cover`, so any CSS
                // `env(safe-area-inset-*)` it uses resolves to real values. We
                // can't edit the remote ShipIt HTML, so this is injected here.
                // This is NOT the path we rely on — `applyEdgeToEdgeInsets()`
                // already pads the WebView container by the system-bar insets, so
                // content is never clipped even if the page ignores safe-area
                // insets entirely. The injection is belt-and-suspenders for a page
                // that does honor them (it then sees insets of ~0 since the
                // container is already inset).
                view.evaluateJavascript(VIEWPORT_FIT_COVER_JS, null)
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

    /**
     * targetSdk 35 (Android 15) enforces edge-to-edge: the activity is laid out
     * behind the status bar (top) and the nav/gesture bar (bottom), and the old
     * `android:statusBarColor`/`navigationBarColor` theme knobs are ignored.
     *
     * Because the WebView loads a *remote* ShipIt instance we don't control, we
     * can't count on the web side honoring `env(safe-area-inset-*)`. The reliable
     * fix is native: pad the WebView's container by the top + bottom system-bar
     * insets so chat content (top) and the bottom-anchored input (bottom) are
     * never hidden under the bars. The themed dark background fills the padded
     * strips, so it still looks full-bleed. We opt into edge-to-edge explicitly
     * via [WindowCompat.setDecorFitsSystemWindows] so the behavior is identical
     * on the older OS versions our minSdk 26 still supports, not just Android 15.
     *
     * Left/right insets are intentionally left at 0 — horizontally the WebView
     * stays edge-to-edge (nothing obscures it there in portrait).
     */
    private fun applyEdgeToEdgeInsets() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        ViewCompat.setOnApplyWindowInsetsListener(binding.root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.updatePadding(top = bars.top, bottom = bars.bottom)
            insets
        }
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

    companion object {
        // Ensures the remote page's <meta name="viewport"> carries
        // `viewport-fit=cover` so CSS env(safe-area-inset-*) can resolve. Adds a
        // viewport meta if the page has none. See onPageFinished for why this is
        // best-effort and not the primary inset fix.
        private const val VIEWPORT_FIT_COVER_JS = """
            (function () {
              var m = document.querySelector('meta[name=viewport]');
              if (!m) {
                m = document.createElement('meta');
                m.name = 'viewport';
                m.content = 'width=device-width, initial-scale=1, viewport-fit=cover';
                document.head.appendChild(m);
              } else if (m.content.indexOf('viewport-fit') === -1) {
                m.content = m.content + ', viewport-fit=cover';
              }
            })();
        """
    }
}
