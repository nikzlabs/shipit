# Privacy Policy — ShipIt Android app

_Last updated: 17 June 2026_

The **ShipIt Android app** ("the app") is a thin `WebView` wrapper around a
**self-hosted ShipIt instance** that you choose and control. The app exists only
to display that instance in a full-screen window on your device.

## The short version

- The app developer **collects nothing**. There are no analytics, no ads, no
  trackers, and no third-party SDKs.
- Everything you type or view goes to the **ShipIt server you configured** — not
  to us. That server is operated by you (or whoever you got the URL from), and
  its handling of your data is governed by that operator, not this policy.
- All app-specific data stays **on your device**.

## What the app stores on your device

- **The ShipIt server URL** you enter, saved in Android's
  `EncryptedSharedPreferences` (encrypted at rest on the device).
- **WebView data for the site you configured** — cookies, local storage, and
  cache that the ShipIt web app sets in the normal course of working. This is
  the same data any browser would keep for that site. It never leaves the device
  except as part of your normal requests to your configured server.

None of this is transmitted to the app developer.

## What the app sends, and to whom

The app makes network requests **only to the server URL you configured** (and to
authentication endpoints that server redirects you to, such as your identity
provider). It does not send data to any other destination. The developer of the
app operates **no servers** that the app talks to.

## Permissions

- **Internet** — required to load your configured ShipIt instance.
- **File access via the system file picker** — used only when *you* choose a file
  to attach in a chat. The app does not browse or read your files on its own.

## Data you enter into ShipIt

Prompts, code, files, and other content you submit are sent to and processed by
**your configured ShipIt instance** and the AI provider that instance uses. How
that data is stored and used is determined by the operator of that instance and
that provider — please refer to their policies. This app is only the window.

## Children

The app is a developer tool and is not directed at children under 13.

## Changes to this policy

If this policy changes, the updated version will be published at this same URL
with a new "Last updated" date.

## Contact

Questions about the app itself can be raised as an issue on the project's GitHub
repository: <https://github.com/nikzlabs/shipit>.
