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

| Input | What it produces | Where it goes |
|------|------------------|---------------|
| `release: false` (default) | Unsigned debug APK | Workflow artifact `shipit-debug-apk` |
| `release: true` | Signed release APK **and** signed AAB | Artifacts `shipit-release-apk` (sideload / GitHub Release) and `shipit-release-aab` (Play Store upload) |
| `release: true` + `publish: true` | The above, **and** uploads the AAB to Google Play | Google Play **internal** testing track (auto-updates testers) |

The **APK** is for sideloading or attaching to a GitHub Release. The **AAB**
(`app-release.aab`) is for the Play Store. Set `publish: true` to push the AAB
straight to the internal track from CI — no manual Console upload. Both toggles
must be on; `publish` requires the `PLAY_SERVICE_ACCOUNT_JSON` secret (see
"Play Store" below).

### versionCode

Google Play rejects an upload whose `versionCode` is not strictly greater than
the previous one. In CI, `versionCode` is set from the GitHub Actions
`run_number` (via the `ANDROID_VERSION_CODE` env var), so every release build
gets a higher code automatically. Local builds fall back to `1`
(see `app/build.gradle.kts`).

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

## Play Store (internal testing)

For Play-managed auto-updates — on your own device or a small group of named
testers — use the **Internal testing** track. It needs no public listing and
skips the production-track testing requirements.

### One-time setup

1. Create a [Google Play Console](https://play.google.com/console) developer
   account ($25 one-time, plus identity verification).
2. Create the app (`applicationId` is `com.shipit.wrapper`), then enroll in
   **Play App Signing**. Your `release.keystore` becomes the **upload key**;
   Google holds the real app-signing key and re-signs each upload. (An upload
   key can be reset via Play support if lost — unlike a pure sideload key.) The
   same four signing secrets are reused.
3. Provide store metadata: icon (512×512), ≥2 screenshots, descriptions, a
   privacy policy URL, content rating, and the Data Safety form.
4. **Seed the first build manually.** The Play API can only update an app that
   already has at least one uploaded build, so the very first AAB must be
   uploaded by hand: run **Android build** with `release: true`, download the
   `shipit-release-aab` artifact, and upload it to the **Internal testing**
   track in the Console. Add your tester email(s) and accept the opt-in link.
5. **Wire up CI publishing** (so future releases upload automatically):
   - In Google Cloud, create a **service account**, then in Play Console →
     **Users and permissions** invite that service account and grant it access
     to **releases** for this app (Admin → Account details has the linked GCP
     project; the grant can be app-scoped).
   - Create a **JSON key** for the service account and download it.
   - Add it as the GitHub Actions secret **`PLAY_SERVICE_ACCOUNT_JSON`** (paste
     the entire JSON file contents as the value).

### Each release (automated)

Run **Android build** with **`release: true`** *and* **`publish: true`**. CI
builds the signed AAB, stamps a fresh `versionCode`, and uploads it to the
internal track via the `r0adkll/upload-google-play` action. Testers' devices
auto-update from the Play Store — no manual Console step.

> Leave `publish: false` to build the artifacts without touching Play (e.g. to
> grab an APK for sideloading or a GitHub Release).

> Play requires new apps/updates to target a recent API level (API 35 /
> Android 15 as of 2025). This app currently targets API 34 — bump
> `compileSdk`/`targetSdk` before your first submission, and verify the
> full-bleed WebView still handles Android 15's edge-to-edge insets.

## App behavior

- **First launch**: Settings screen prompts for the ShipIt URL. Validated as
  a parseable `https://` URL with a host. Cleartext `http://` is allowed for
  Tailscale hosts (`*.ts.net`) and in debug builds — see "Tailscale" below.
- **Normal launch**: WebView loads the saved URL full-screen.
- **Toolbar overflow**: "Open settings" re-launches the settings screen so the
  URL can be changed. "Reload" reloads the current page.
- **External links**: any URL whose host differs from the configured ShipIt
  host opens in the system browser, except Cloudflare Access authentication.
  Cloudflare Access stays inside the WebView because Android does not share
  Chrome/system-browser cookies back into the WebView cookie jar.
- **File chooser**: chat attachments work via `WebChromeClient.onShowFileChooser`.
- **Back button**: WebView history; falls through to default if at the root.

## Tailscale (HTTP-only) hosts

If you expose ShipIt over a Tailscale tailnet (`deployment/vps/tailscale.sh`),
it is served over plain **HTTP** — there is no wildcard TLS cert for `*.ts.net`,
and WireGuard already encrypts the tailnet end-to-end. The app permits cleartext
HTTP for `*.ts.net` hosts in **release builds too**, so no debug APK is needed.

Two things to get right:

- **Authentication needs nothing extra.** Tailnet membership is the access
  boundary, so there's no login screen — just point the app at your host.
- **Enter the full MagicDNS FQDN**, e.g. `http://shipit.tailnet.ts.net:4123`.
  The bare short name (`shipit`) and the raw `100.x` tailnet IP are rejected on
  purpose: only the FQDN lets ShipIt's preview subdomains
  (`{sessionId}--{port}.shipit.tailnet.ts.net`) resolve.

## Known limitations / v1.1 ideas

- No OAuth deep-link interception: when a browser-based OAuth flow returns, the
  user back-gestures into the app manually. Cloudflare Access is handled
  separately by keeping the auth chain inside the WebView so its cookie reaches
  the app.
- Launcher icon mirrors the web favicon: a red gradient background
  (`ic_launcher_background.xml`) with a white rocket foreground
  (`ic_launcher_foreground.xml`), sharing the favicon's path geometry and
  colors. Refresh both if the favicon design changes.
- No push notifications, no native settings beyond the URL. Both intentional
  for v1.
