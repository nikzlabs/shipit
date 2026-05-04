# ShipIt Android wrapper

A minimal `WebView`-based Android app that wraps a self-hosted ShipIt instance
in a full-bleed window. The host URL is configured by the user at runtime
(stored in `EncryptedSharedPreferences`), so the same APK works for any
ShipIt deployment.

See [`docs/116-android-webview-app/plan.md`](../docs/116-android-webview-app/plan.md)
for the design rationale.

## Building

Builds happen in GitHub Actions via the `Android build` workflow
(`.github/workflows/android.yml`) — **manually triggered only**, never on
push or PR. From the GitHub UI: **Actions → Android build → Run workflow**.

| Mode | What it produces | Where it goes |
|------|------------------|---------------|
| `release: false` (default) | Unsigned debug APK | Workflow artifact `shipit-debug-apk` |
| `release: true` | Signed release APK | Workflow artifact `shipit-release-apk` (attach to a GitHub Release manually) |

### Local builds (optional)

If you want to build outside CI:

```bash
# One-time setup: install JDK 17 and Gradle 8.7
cd android
gradle :app:assembleDebug
```

The debug APK lands at `app/build/outputs/apk/debug/app-debug.apk`. Install
on a connected device with `adb install -r <path>`.

## Signing — one-time keystore setup

Release builds need a signing key. Generate it once, base64-encode it, and
store it in this repo's GitHub Actions secrets.

```bash
# 1. Generate the keystore (24-character random password, 10-year validity).
keytool -genkey -v \
  -keystore release.keystore \
  -alias shipit \
  -keyalg RSA -keysize 2048 \
  -validity 10000 \
  -storetype PKCS12

# 2. Base64-encode it for GitHub.
base64 -i release.keystore | pbcopy   # macOS
# or: base64 release.keystore | xclip  # Linux
```

Add four GitHub Actions secrets (Settings → Secrets and variables → Actions):

| Secret name | Value |
|-------------|-------|
| `ANDROID_KEYSTORE_BASE64` | The base64 you just copied |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password you set during `keytool` |
| `ANDROID_KEY_ALIAS` | `shipit` (or whatever `-alias` you used) |
| `ANDROID_KEY_PASSWORD` | Key password (often the same as keystore password) |

**Back up the keystore file itself.** If you lose it, you cannot publish
updates that existing installs will accept — Android verifies that an APK
update is signed with the same key as the previous install. Treat
`release.keystore` like a production credential.

## Distribution

1. Run **Android build** with `release: true`.
2. Download the `shipit-release-apk` artifact.
3. Create a GitHub Release (`vX.Y.Z` tag) and attach the APK.
4. Self-hosters download the APK from your Releases page and sideload it on
   their phone (Settings → Apps → "Install unknown apps" → Chrome/Files).

Optional: upload the same APK as an AAB to Play Console for the regular
"app store install" experience. Out of scope for v1.

## App behavior

- **First launch**: Settings screen prompts for the ShipIt URL. Validated as
  a parseable `https://` URL with a host. Cleartext `http://` is allowed only
  in debug builds.
- **Normal launch**: WebView loads the saved URL full-screen.
- **Toolbar overflow**: "Open settings" re-launches the settings screen so the
  URL can be changed. "Reload" reloads the current page.
- **External links**: any URL whose host differs from the configured ShipIt
  host opens in the system browser (so e.g. "View on GitHub" leaves the app
  cleanly, and OAuth providers don't try to render inside the WebView).
- **File chooser**: chat attachments work via `WebChromeClient.onShowFileChooser`.
- **Back button**: WebView history; falls through to default if at the root.

## Known limitations / v1.1 ideas

- No OAuth deep-link interception: when the OAuth flow returns, the user
  back-gestures into the app manually. Adding a custom-tabs intercept would
  smooth this out.
- Launcher icon foreground is a flat-color simplification of the favicon.
  Replace with a designed asset before Play Store publish.
- No push notifications, no native settings beyond the URL. Both intentional
  for v1.
