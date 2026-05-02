# Checklist — Android WebView wrapper (configurable host)

## Cleanup of TWA scaffolding from previous turn
- [ ] Delete `src/client/public/.well-known/assetlinks.json`.
- [ ] Remove the explicit `/.well-known/assetlinks.json` route from `src/server/orchestrator/index.ts` (added in the same change that added the manifest).
- [ ] Confirm `src/client/public/manifest.webmanifest` and the `index.html` PWA meta tags stay — they're useful for iOS "Add to Home Screen" and don't conflict.

## Android project scaffolding
- [ ] `android/settings.gradle.kts`, `android/build.gradle.kts`, `android/gradle.properties`.
- [ ] Gradle wrapper committed: `android/gradlew`, `android/gradlew.bat`, `android/gradle/wrapper/gradle-wrapper.jar`, `android/gradle/wrapper/gradle-wrapper.properties`. (Pin a Gradle version known to work with AGP 8.x and JDK 17.)
- [ ] `android/app/build.gradle.kts` — application module, AGP 8.x, Kotlin, `compileSdk = 34`, `minSdk = 24`, `targetSdk = 34`, AndroidX, view binding on.
- [ ] `android/app/proguard-rules.pro` (default + WebView keep rules).

## App code
- [ ] `Prefs.kt` — wraps `EncryptedSharedPreferences` with one key (`shipit_url`).
- [ ] `SettingsActivity.kt` — single-field URL form, validates `https://` (allow `http://` only when `BuildConfig.DEBUG`), saves via `Prefs`, finishes.
- [ ] `MainActivity.kt` — full-bleed `WebView`; if `Prefs.shipitUrl` is empty, launch `SettingsActivity` and finish; otherwise `loadUrl`. Wire `WebViewClient.shouldOverrideUrlLoading` to send OAuth provider URLs to Custom Tabs. Wire `WebChromeClient.onShowFileChooser` for attachments. Hardware back = `webView.goBack()` w/ fallback. Toolbar overflow → re-open `SettingsActivity`.
- [ ] `OAuthRedirectActivity.kt` — empty Activity registered on the deep-link scheme, forwards to `MainActivity` with the redirect URL. (Optional polish — v1 can ship without it; document this in the file's top comment.)

## Resources
- [ ] `AndroidManifest.xml` — `INTERNET` permission, three activities, `MAIN`/`LAUNCHER` on Settings if no URL else MainActivity (use a launcher activity that picks). Intent filter on `OAuthRedirectActivity` for the deep-link scheme.
- [ ] `res/layout/activity_main.xml` — single fullscreen `WebView`.
- [ ] `res/layout/activity_settings.xml` — `EditText` + `Button` + helper text.
- [ ] `res/values/strings.xml`, `colors.xml`, `themes.xml` — match ShipIt dark theme (`#030712` background).
- [ ] `res/xml/network_security_config.xml` — clear-text traffic permitted only in debug.
- [ ] `res/mipmap-*/ic_launcher*.png` — launcher icons. Generate from `src/client/public/favicon.svg` (Android Studio Image Asset wizard equivalent — can be done in CI with a small ImageMagick step or pre-generated and committed).

## GitHub Actions workflow
- [ ] `.github/workflows/android.yml` with `on: workflow_dispatch` only — **no** `on: push` or `on: pull_request` triggers.
- [ ] Inputs: `release: boolean` (default `false`).
- [ ] Steps: checkout → setup-java 17 → setup-android → cache `~/.gradle/caches` → `cd android && ./gradlew assembleDebug` (or `assembleRelease` if `release == true`).
- [ ] Release path: restore keystore from `ANDROID_KEYSTORE_BASE64` secret, sign, upload signed APK to a draft GitHub Release for the run's tag (or as a workflow artifact if no tag).
- [ ] Debug path: upload `app-debug.apk` as a workflow artifact.

## Documentation
- [ ] `android/README.md` — keystore generation (`keytool -genkey -v -keystore release.keystore -alias shipit -keyalg RSA -keysize 2048 -validity 10000`), how to base64 it into the GitHub secret, how to trigger the workflow manually, how to sideload the APK on a phone.
- [ ] `CLAUDE.md` — add one-line entry under "Project structure" pointing at `android/`. Mention this is a separate Gradle build that Node tooling ignores.
- [ ] `.gitignore` — add `android/.gradle/`, `android/app/build/`, `android/build/`, `android/local.properties`, `android/.idea/`, `*.keystore` (so we never accidentally commit a keystore).

## Quality gates
- [ ] `npm run lint` — clean (no JS code changed beyond the cleanup).
- [ ] `npm run typecheck` — clean.
- [ ] `npm run test:dev` — clean (the route deletion may affect a test; check).
- [ ] Trigger the workflow manually with `release: false`, confirm the debug APK is produced.
- [ ] Sideload the debug APK on a real Android device, verify: settings screen appears on first launch → URL persists → MainActivity loads ShipIt → can log in with GitHub via Custom Tabs → can send a message → can attach a file.

## Wrap-up
- [ ] Set `status: in-progress` when implementation starts; `done` when all items above are checked.
- [ ] Update `plan.md` with anything learned during build (e.g., specific OEM WebView quirks, keyboard issues, OAuth provider edge cases).
