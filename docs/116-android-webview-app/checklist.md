# Checklist — Android WebView wrapper (configurable host)

## Cleanup of TWA scaffolding from previous turn
- [x] Delete `src/client/public/.well-known/assetlinks.json`.
- [x] Remove the explicit `/.well-known/assetlinks.json` route from `src/server/orchestrator/index.ts`.
- [x] Confirm `src/client/public/manifest.webmanifest` and the `index.html` PWA meta tags stay — verified `dist/client/manifest.webmanifest` ships and `.well-known` is absent.

## Android project scaffolding
- [x] `android/settings.gradle.kts`, `android/build.gradle.kts`, `android/gradle.properties`.
- [ ] ~~Gradle wrapper committed.~~ **Skipped intentionally** — not committing `gradle-wrapper.jar` (binary blob). The CI workflow installs Gradle 8.7 via `gradle/actions/setup-gradle@v3` and invokes `gradle` directly. Local builds also use system `gradle`. README documents this.
- [x] `android/app/build.gradle.kts` — AGP 8.5.2, Kotlin 1.9.24, `compileSdk = 34`, `minSdk = 26`, `targetSdk = 34`, view binding on, signing config that reads from env vars (CI provides them; locally falls back to debug signing so `assembleRelease` doesn't error).
- [x] `android/app/proguard-rules.pro` (default + JS-bridge keep rules).

## App code
- [x] `Prefs.kt` — `EncryptedSharedPreferences` with single `shipit_url` key.
- [x] `SettingsActivity.kt` — single-field URL form, validates `https://` (allows `http://` only when `BuildConfig.DEBUG`), normalizes (defaults missing scheme to `https://`, strips trailing slashes), saves via `Prefs`, finishes.
- [x] `MainActivity.kt` — full-bleed `WebView`; if `Prefs.shipitUrl` is empty, launches `SettingsActivity`; otherwise loads the URL. Wires `WebViewClient.shouldOverrideUrlLoading` to send same-host URLs to the WebView and external URLs to the system browser. Wires `WebChromeClient.onShowFileChooser` for attachments via `ActivityResultContracts.GetMultipleContents`. Hardware back via `OnBackPressedDispatcher`. Toolbar overflow → "Open settings" + "Reload".
- [ ] ~~`OAuthRedirectActivity.kt`.~~ **Skipped for v1.** OAuth callbacks already land on the user's ShipIt origin via the WebView; user back-gestures into the app to continue. Documented as v1.1 polish in `plan.md` and in `android/README.md` under "Known limitations."

## Resources
- [x] `AndroidManifest.xml` — `INTERNET` + `ACCESS_NETWORK_STATE` permissions, `MainActivity` as `LAUNCHER`, `SettingsActivity` exported=false, network security config + backup rules referenced.
- [x] `res/layout/activity_main.xml` — CoordinatorLayout + AppBar + WebView, ShipIt-dark background.
- [x] `res/layout/activity_settings.xml` — TextInputLayout + MaterialButton, ShipIt-dark theme.
- [x] `res/menu/main.xml` — overflow menu with Reload + Open settings.
- [x] `res/values/strings.xml`, `colors.xml` (mirrors web UI palette `#030712` + accent), `themes.xml` (DayNight.NoActionBar with system bars themed).
- [x] `res/xml/network_security_config.xml` — base disallows cleartext; debug-overrides allow it for local dev.
- [x] `res/xml/backup_rules.xml`, `data_extraction_rules.xml` — exclude the encrypted prefs from cloud backup / device transfer.
- [x] Adaptive launcher icons via `mipmap-anydpi-v26/ic_launcher.xml` + `ic_launcher_round.xml`, with foreground vector drawable at `drawable/ic_launcher_foreground.xml`. **No PNG bitmaps** — `minSdk = 26` lets us ship XML-only icons. Foreground is a flat-color "rocket" silhouette inspired by the favicon; documented for replacement before Play Store publish.

## GitHub Actions workflow
- [x] `.github/workflows/android.yml` with `on: workflow_dispatch` only — **no** `on: push` or `on: pull_request`.
- [x] Inputs: `release: boolean` (default `false`).
- [x] Steps: checkout → setup-java 17 → setup-android → setup-gradle (8.7) → `gradle assembleDebug` *or* `gradle assembleRelease`.
- [x] Release path: keystore restored from `ANDROID_KEYSTORE_BASE64` secret to a file, `ANDROID_KEYSTORE_PATH` env var passed to Gradle, signed APK uploaded as `shipit-release-apk` artifact. Keystore file deleted in `always()` cleanup step.
- [x] Debug path: uploads `app-debug.apk` as `shipit-debug-apk` artifact.

## Documentation
- [x] `android/README.md` — keystore generation (`keytool` invocation), base64-into-secret flow, the four required GitHub secret names, manual workflow trigger, sideload instructions, app-behavior summary, known limitations.
- [x] `CLAUDE.md` — added `android/` entry under "Project structure" pointing at the README + the design doc.
- [x] `.gitignore` — added `android/.gradle/`, `android/build/`, `android/app/build/`, `android/local.properties`, `android/.idea/`, `android/captures/`, `android/.cxx/`, `*.keystore`, `*.jks`.

## Quality gates
- [x] `npm run lint` — clean.
- [x] `npm run typecheck` — clean.
- [x] `npm run test:dev` — 4 files, 94 tests, all green.
- [x] `npm run build` — Vite build succeeds; `dist/client/manifest.webmanifest` ships, `.well-known/` correctly absent.
- [ ] **Manual: trigger the workflow with `release: false`, confirm the debug APK is produced.** *(Operator step — can't run from this container.)*
- [ ] **Manual: sideload the debug APK on a real Android device, verify the end-to-end flow** (settings → URL persists → WebView loads → login → message → file attach). *(Operator step.)*

## Wrap-up
- [x] `status: in-progress` set in `docs/116-android-webview-app/plan.md`.
- [ ] Flip to `status: done` after the two manual operator steps above succeed.
- [ ] Update `plan.md` with anything learned during the manual smoke test (OEM WebView quirks, keyboard issues, OAuth provider edge cases).
