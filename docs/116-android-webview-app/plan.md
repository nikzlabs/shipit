---
description: Minimal Android WebView wrapper for self-hosted ShipIt with a runtime-configurable host URL, distributed as a sideload APK via GitHub Releases.
---

# 116 — Android WebView wrapper (configurable host)

## Summary

A minimal Android app that wraps a self-hosted ShipIt instance in a full-bleed `WebView`. The host URL is **configured by the user at runtime**, not baked into the APK, so a single APK works for every self-hoster. Distributed as a signed APK via GitHub Releases (sideload) and optionally Play Store later.

The whole point is to hide Chrome's address bar — ShipIt is a chat-shaped IDE, and on phones the URL bar plus the gesture bar at the bottom eat enough vertical space to make the chat input cramped. A standalone app shell solves that without any per-user customization beyond "type your URL once."

## Motivation

- Self-hosters want ShipIt full-screen on mobile without a custom build per domain.
- A TWA (`docs/116`'s earlier sketch, now superseded — see "Why not TWA" below) hardcodes one origin via `assetlinks.json` at build time. That's wrong for a multi-user distribution.
- iOS users can already get most of this benefit via Safari "Add to Home Screen" using the `manifest.webmanifest` we already ship; this doc covers the Android side, where the equivalent (PWA install) is gated behind harder-to-discover Chrome menus and feels worse than a real app icon.

## Why not TWA

TWAs are Chrome's "verified PWA" mode: full-screen, real Chrome under the hood, OAuth Just Works. But:

- Each TWA is bound to **one origin** via `/.well-known/assetlinks.json` on that origin, signed against a specific APK fingerprint. Build-time only.
- Adding more origins means adding more entries to the APK's `twa-manifest.json` *and* hosting `assetlinks.json` on each — neither of which the end user can do.
- Therefore: TWA is appropriate for a single-instance deploy (one organization, one domain), but not for "any user installs the app and points it at their own ShipIt."

Pivoting to a plain `WebView` activity solves the multi-host problem at the cost of two new concerns: (a) OAuth providers refuse to render inside `WebView`, so OAuth must be punted to **Custom Tabs**, and (b) the developer is responsible for things Chrome handles automatically (cookies, file picker, back button).

## Design

### App shape

Three activities, ~300–500 lines of Kotlin total:

1. **`SettingsActivity`** — first-run + reachable later. Single `EditText` for the ShipIt URL, "Save" button. Validates the URL is `https://` (allow `http://` only in debug builds), persists to `EncryptedSharedPreferences`, finishes back to `MainActivity`.

2. **`MainActivity`** — the WebView host. On `onCreate`, reads the saved URL. If absent, launches `SettingsActivity` and finishes. Otherwise loads the URL into a full-bleed `WebView`. Configures: JS, DOM storage, third-party cookies (needed for the websocket session), `WebChromeClient.onShowFileChooser` for attachment uploads, hardware back button = `webview.goBack()` with fallback to default. Toolbar overflow has "Open Settings" → re-launch `SettingsActivity`.

3. **`OAuthRedirectActivity`** — invisible activity bound via intent filter to a deep-link callback URL (e.g. `shipit://oauth-callback`). When ShipIt's OAuth flow returns, Android routes the redirect here and we forward the URL back into the WebView via an `Intent` to `MainActivity`.

### OAuth flow

```
WebView loads chat → user clicks "Login with GitHub"
  → shouldOverrideUrlLoading sees github.com/login/oauth → opens Custom Tabs
  → Custom Tabs (real Chrome, real cookies, real SSO) does the login
  → Provider redirects to https://<user-host>/api/auth/github/callback?code=…
  → We don't intercept that — the user's ShipIt server does, and redirects to /
  → User taps the persistent "Back to app" button in Custom Tabs (or Custom Tabs auto-closes
    on the deep link if we register one)
  → MainActivity resumes, WebView is on / and is now logged in (cookie set on the host)
```

The simplest version doesn't even need the deep-link intercept: GitHub/Anthropic OAuth callbacks land back on the user's ShipIt origin, ShipIt sets its session cookie, the user manually returns to the app via the system back gesture, and the WebView (which kept its state) reflects the logged-in session on next request. Deep-link interception is a polish improvement, not a blocker for v1.

### Settings persistence

`EncryptedSharedPreferences` (AndroidX Security). Single key: `shipit_url`. We don't persist credentials — those live in the host's cookies inside the WebView's data store, which Android already encrypts at rest.

### Build environment — no local toolchain

The user explicitly does not want a local Android toolchain. Build is a **manually-triggered GitHub Actions workflow** (`workflow_dispatch`, *not* on push):

```yaml
on:
  workflow_dispatch:
    inputs:
      release:
        description: "Build a signed release APK (vs. unsigned debug)"
        type: boolean
        default: false
```

- Debug build: `./gradlew assembleDebug` → uploads `app-debug.apk` as a workflow artifact.
- Release build (when `release: true`): `./gradlew assembleRelease` using a keystore restored from the `ANDROID_KEYSTORE_BASE64` + `ANDROID_KEYSTORE_PASSWORD` + `ANDROID_KEY_ALIAS` + `ANDROID_KEY_PASSWORD` repo secrets. Uploads to GitHub Releases.

Manual trigger is correct here: every push doesn't need an Android build; releases happen on the operator's cadence.

### Repo layout

The Android project lives in `android/` at the repo root, alongside the existing Node/React project. It's its own Gradle build — Node tooling ignores it via `.gitignore` patterns; the Android workflow scopes to `android/**`.

```
android/
  build.gradle.kts
  settings.gradle.kts
  gradle.properties
  gradle/wrapper/         (committed gradle-wrapper.jar + properties)
  gradlew, gradlew.bat
  app/
    build.gradle.kts
    src/main/
      AndroidManifest.xml
      java/com/shipit/wrapper/
        MainActivity.kt
        SettingsActivity.kt
        OAuthRedirectActivity.kt
        WebAppInterface.kt        (small JS bridge if needed for OAuth deep link)
        Prefs.kt                  (EncryptedSharedPreferences wrapper)
      res/
        layout/
          activity_main.xml       (just a WebView)
          activity_settings.xml   (URL field + save button)
        values/
          strings.xml, themes.xml, colors.xml
        mipmap-*/                 (launcher icons — generated from existing favicon.svg)
        xml/
          network_security_config.xml  (for debug-only http allowance)
    proguard-rules.pro
  README.md                       (keystore setup, signing flow)

.github/workflows/android.yml     (workflow_dispatch, debug + signed release)
```

### Cleanup of the previous TWA scaffolding

Last turn added `src/client/public/.well-known/assetlinks.json` and an explicit `/.well-known/assetlinks.json` Fastify route in `src/server/orchestrator/index.ts`. Both are TWA-only and should be removed when this doc lands. The `manifest.webmanifest` and PWA-related meta tags in `index.html` stay — they're useful for iOS Safari "Add to Home Screen" and don't conflict with the WebView wrapper.

## Distribution

- **GitHub Releases (primary).** Tag a release in the repo, run the workflow with `release: true`, the signed APK is attached. Self-hosters download and sideload (one-time "install from unknown sources" prompt).
- **Play Store (later, optional).** Same APK can be uploaded as an AAB to a Play Console listing if the operator wants the "real app store" install experience. Out of scope for v1.

## Risks / open questions

- **WebSocket through WebView.** ShipIt's per-session WS (`/ws/sessions/{id}`) and global SSE (`/api/events`) work in WebViews, but we should test on a real device — some Android OEM browsers/WebViews have aggressive battery-saver behaviors that drop long-lived connections. Reconnect logic in the existing client (`useWebSocket` exponential backoff) should handle it; flag if not.
- **File chooser for chat attachments.** Needs `WebChromeClient.onShowFileChooser` plumbed to a `registerForActivityResult(ActivityResultContracts.GetMultipleContents())`. Standard pattern, ~30 lines.
- **Keyboard pushing the chat input.** ShipIt's input is bottom-anchored; soft keyboard behavior depends on `windowSoftInputMode`. Start with `adjustResize` and iterate from real-device testing.
- **CSRF / cookie scope.** ShipIt uses cookies on the same origin as the WebView is loading, so first-party. Should be fine. Third-party cookies needed only if OAuth callback flows through a third-party origin (it doesn't — the OAuth provider redirects to the user's own ShipIt host).
- **OAuth providers blocking WebView.** The whole point of punting to Custom Tabs. As long as we never load `accounts.google.com` / `github.com/login` *inside* the WebView, providers stay happy. The `shouldOverrideUrlLoading` check is the enforcement point.
- **Signing key custody.** The release keystore lives in repo secrets. Lose it → can't ship updates that the user's existing install will accept. Document the backup procedure in `android/README.md`.

## Out of scope (for this doc)

- iOS app (PWA via "Add to Home Screen" covers it for now).
- Push notifications.
- Native settings beyond the URL (theme, font size, etc. — let the web UI handle them).
- Embedded Android emulator preview surface (covered in the larger "ShipIt builds Android apps" gap analysis, separate doc).

## Key files (planned)

- `android/app/src/main/java/com/shipit/wrapper/MainActivity.kt` — WebView host.
- `android/app/src/main/java/com/shipit/wrapper/SettingsActivity.kt` — URL config UI.
- `android/app/src/main/java/com/shipit/wrapper/Prefs.kt` — encrypted prefs wrapper.
- `android/app/src/main/AndroidManifest.xml` — activities, intent filters, permissions (`INTERNET`).
- `.github/workflows/android.yml` — `workflow_dispatch`-triggered Gradle build.
- `android/README.md` — keystore generation, GitHub secret setup, sideload instructions.
