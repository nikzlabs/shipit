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

Android refuses to install an APK whose `versionCode` is not strictly greater
than the one already on the device (`INSTALL_FAILED_VERSION_DOWNGRADE`), and
Google Play rejects an upload that isn't strictly greater than the previous one.
Both CI and local builds derive `versionCode` from **epoch seconds** (CI sets
`ANDROID_VERSION_CODE` to `date +%s`; local builds fall back to the same
computation in `app/build.gradle.kts`). Using one wall-clock scale everywhere
means the newer build always outranks the older one regardless of where it was
built — a CI APK installs over a locally-built one and vice versa, with no manual
bumping. (Earlier the CI path used `run_number`, a small integer that a local
build's ~1.75-billion epoch code would always outrank, blocking CI installs.)

Note this is the *internal* `versionCode` only. The user-visible version string
in Android's app-info screen is `versionName`, which is read from the root
`package.json` `version` field at build time (see `app/build.gradle.kts`) — so it
tracks the project version automatically and changes when you bump the release.
Debug builds carry a `-debug` suffix.

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
3. Provide store metadata (see `play/README.md`):
   - **App icon** — `play/icon-512.png` (committed).
   - **Feature graphic** — `play/feature-graphic-1024x500.png` (committed).
   - **Privacy policy URL** — the policy lives at `android/PRIVACY.md`; paste its
     GitHub URL into the Console (see "Privacy policy" below).
   - **≥2 phone screenshots** — capture from a device/emulator (not committed).
   - Descriptions, content rating, and the Data Safety form.
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

The app targets **API 35 (Android 15)**, the minimum Google Play accepts for
new submissions — so it is submission-ready. See "Edge-to-edge / window insets"
below for the behavioral change that came with that bump.

## Edge-to-edge / window insets

Targeting API 35 opts the app into Android 15's **enforced edge-to-edge**: the
activity is laid out behind the status bar (top) and the nav/gesture bar
(bottom), and the old `android:statusBarColor` / `android:navigationBarColor`
theme attributes are **ignored** (they were removed from `Theme.ShipIt`). The
system bars are transparent; the dark `windowBackground` shows through them, so
the app still looks full-bleed.

Inset handling is **split top vs. bottom** — the two are owned by different
layers, and applying both to the bottom double-counts it:

- **`MainActivity`** pads the WebView's container by **only the top** system-bar
  inset (`WindowInsetsCompat.Type.systemBars()`), keeping chat content clear of
  the status bar. The web UI does not honor `env(safe-area-inset-top)`, so the
  top is native.
- **The bottom (nav/gesture bar) inset is owned by the web side.** `index.html`
  declares `viewport-fit=cover` and bottom-anchored web surfaces pad themselves by
  `env(safe-area-inset-bottom)`; `MainActivity` injects `viewport-fit=cover` as a
  belt-and-braces fallback. The native container's bottom inset stays at **0** —
  `env(safe-area-inset-bottom)` is a window/display property that returns the
  nav-bar height no matter where the WebView sits in the window, so padding the
  container up natively *as well* lifted the WebView by the nav-bar height while
  the web side padded itself by the same amount, leaving a theme-colored gap above
  the nav bar (the "white gap at the bottom" report).
  - Which web surfaces pad themselves: the bottom **`MobileTabBar`** caps the
    normal flex-column layout, so all *in-flow* content (chat, the workspace
    panel, the docs/Present panel, the session drawer) sits above it and is
    automatically clear of the nav bar. The surfaces that *escape* that column —
    `fixed inset-0` / portalled overlays — must reserve the inset themselves:
    the shared fullscreen **`DialogContent`** (file/doc review, all-sessions,
    settings, every modal) plus the standalone overlays
    (`MobileRecordingOverlay`, `OnboardingWizard`, `QuickCaptureOverlay`). A new
    fullscreen overlay that reaches the viewport bottom needs the same
    `env(safe-area-inset-bottom)` padding or its bottom controls hide under the
    nav bar.
- **`SettingsActivity`** pads its scrolling root by the union of the system-bar
  **and IME** insets (`systemBars() or ime()`), so the URL field and Save button
  stay clear of both the status bar and the on-screen keyboard.

Edge-to-edge is opted into explicitly via
`WindowCompat.setDecorFitsSystemWindows(window, false)`, so the behavior is the
same on the older OS versions `minSdk 26` still supports, not only Android 15.

> Inset/layout correctness can only be confirmed on a device or emulator — there
> is no Android toolchain in the dev container. Run the **Android build**
> workflow, install the debug APK, and check the WebView top/bottom and the
> Settings form with the keyboard open.

### Privacy policy (hosted from this repo)

Play requires a publicly reachable privacy policy URL. Rather than standing up a
site, the policy is committed at [`PRIVACY.md`](PRIVACY.md) and served straight
from GitHub — paste this URL into the Console's **Privacy policy** field:

```
https://github.com/nikzlabs/shipit/blob/main/android/PRIVACY.md
```

GitHub renders the Markdown as a normal web page, which Play's reviewer can
fetch. **This only works while the repo is public** — Play's crawler is
unauthenticated, so a private repo's blob URL (and free GitHub Pages) won't be
reachable.

Want a cleaner, chrome-free URL? Enable **GitHub Pages** (Settings → Pages →
Source: `main`) and link to the rendered page instead
(`https://nikzlabs.github.io/shipit/android/PRIVACY`). The blob URL above works
with zero setup, so it's the recommended starting point.

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
