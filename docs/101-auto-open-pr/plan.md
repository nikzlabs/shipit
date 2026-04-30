---
status: planned
---

# 101 — Auto-Open PR in New Tab on Auto-Create

## Summary

When the auto-create-PR flow successfully opens a new PR (see doc 099), automatically open the PR URL in a new browser tab — guarded by a per-user setting (default off). Today the PR URL is rendered as a clickable link in the lifecycle card, but the user has to click it. T3 Code's "one-click" workflow opens the browser directly to the PR page; this doc replicates that behavior, opt-in.

## Motivation

The current flow after a meaningful turn (with auto-create-PR enabled and GitHub authed):

1. Agent finishes turn → post-turn commit → push → `quickCreatePr` → PR opened on GitHub.
2. `pr_lifecycle_update` (phase `open`) is emitted with the PR URL.
3. `PrLifecycleCard` renders a clickable badge linking to the PR.

Step 4 — "the user clicks the badge to look at their PR" — is the part that's friction. For users who *want* the PR auto-created at all, the next thing they always do is open it. We can save the click.

We must NOT do this unconditionally:
- A user who's bouncing between many sessions in different tabs would get a wave of unwanted tabs opening.
- Some users disable popups globally and would just see the popup blocker bark.

So this is a **per-user setting**, default off.

## Design

### Setting

Add `autoOpenPr: boolean` to `CredentialStore` alongside the existing `autoCreatePr`. Same scope (global, not per-session). Same storage path. Default `false`.

```ts
// src/server/orchestrator/credential-store.ts
getAutoOpenPr(): boolean;
setAutoOpenPr(v: boolean): void;
```

Add to the bootstrap response (`api-routes-bootstrap.ts`) so the client knows the current value at load time.

### UI placement

Add a second toggle to the `PrLifecycleCard` overflow menu, immediately below `AutoCreatePrToggle`:

```
┌───────────────────────────────────────────────┐
│ ☑ Auto-create PR after meaningful turns       │
│ ☐ Open PR in new tab when auto-created        │  ← new
└───────────────────────────────────────────────┘
```

Only enabled when `autoCreatePr` is on (otherwise `autoOpenPr` has nothing to act on — gray out and show tooltip "Requires Auto-create PR"). Persist via existing settings endpoint.

### Server message

After `quickCreatePr` succeeds in `claude-execution.ts:281`:

```ts
const result = await quickCreatePr(/* … */);
runner.emitMessage({
  type: "pr_lifecycle_update",
  phase: "open",
  // … existing fields …
});
if (ctx.credentialStore.getAutoOpenPr()) {
  runner.emitMessage({
    type: "open_url",
    url: result.url,
    reason: "pr_auto_created",
  });
}
```

`open_url` is a new server-to-client WS message type:

```ts
// src/server/shared/types/ws-server-messages.ts
export interface WsOpenUrl {
  type: "open_url";
  url: string;
  /** Why we're opening — used for analytics / debouncing. */
  reason: "pr_auto_created";
}
```

We deliberately use `runner.emitMessage` (not `ctx.send`) so it's broadcast to every attached viewer. This is intentional: if the user has the session open in three tabs, all three try to open the URL — but `window.open(url, url)` (using the URL as the window name) reuses the same target window across calls, so the result is one tab, not three. See "Multi-tab handling" below.

### Client handling

In `useMessageHandler.ts`, add a case for `open_url`:

```ts
case "open_url": {
  // Use the URL as the window name so repeated calls reuse the same tab
  // (across multiple ShipIt tabs and across repeated open events).
  const win = window.open(data.url, data.url, "noopener,noreferrer");
  if (!win) {
    // Popup blocked — fall back to a toast with a manual button.
    showToast({
      kind: "info",
      message: "PR ready",
      action: { label: "Open PR", onClick: () => window.open(data.url, "_blank") },
    });
  }
  break;
}
```

### Multi-tab handling

The named-window trick (`window.open(url, url)`) means:
- First tab fires: opens a new window named `https://github.com/.../pull/42`.
- Second tab fires the same event: `window.open` finds the existing window with that name, focuses it, no new tab created.

This is the cheapest possible dedupe and works across all browsers.

### Popup blocker

Modern browsers only allow `window.open` from a direct user gesture. We're calling it from a WebSocket message handler, NOT a click. Most browsers will **block this** by default. Options:

1. **Ship and accept the blocker** — show the fallback toast. Most users will whitelist the ShipIt origin once and forget.
2. **Use `window.location.href = url`** in the *current* tab — terrible, kicks the user out of ShipIt.
3. **Render a "PR Ready" notification with a one-click button** — defeats the point (still requires a click).

Recommendation: ship option 1. Document the behavior in the toggle's tooltip: "Requires allowing popups from ShipIt." Detect the block (`win === null`) and show a clear toast so the user understands what happened the first time. Most users will whitelist after one occurrence.

This is a real T3 Code distinction worth calling out: T3 Code is an **Electron desktop app**, so it can call `shell.openExternal()` and bypass the browser popup blocker entirely. ShipIt is a web app and can't. We accept this tradeoff rather than ship Electron.

## Settings storage scope

Global, on `CredentialStore` (matching `autoCreatePr`). Per-session and per-repo overrides are out of scope.

## Tests

### Server (`src/server/orchestrator/integration_tests/pr-auto-open.test.ts`)

1. **Setting off** — `autoCreatePr=true`, `autoOpenPr=false`, FakeClaude makes a change → expect `pr_lifecycle_update phase=open` event, NO `open_url` event.
2. **Setting on** — same as above with `autoOpenPr=true` → expect `open_url` event with the same `url` as the lifecycle card, `reason="pr_auto_created"`.
3. **PR creation fails** — `quickCreatePr` throws → expect lifecycle card emits `phase=error`, NO `open_url` event.
4. **autoCreatePr off** — `autoCreatePr=false`, `autoOpenPr=true` → no PR is created, so no `open_url` event. (Tests the "requires autoCreatePr" gate at runtime, even if the UI grays out the toggle.)

### Client (`src/client/hooks/useMessageHandler.test.ts`)

- Mock `window.open` to return a truthy stub → `open_url` event triggers `window.open(url, url, "noopener,noreferrer")`.
- Mock `window.open` to return `null` (popup blocked) → toast with "Open PR" action fires. Clicking the action opens the PR.
- `PrLifecycleCard.test.tsx` — `autoOpenPr` toggle is disabled when `autoCreatePr` is off, with an explanatory tooltip.

## Key files

| File | Change |
|---|---|
| `src/server/orchestrator/credential-store.ts` | Add `getAutoOpenPr` / `setAutoOpenPr` |
| `src/server/orchestrator/api-routes-bootstrap.ts` | Include `autoOpenPr` in bootstrap response |
| `src/server/orchestrator/services/settings.ts` | Add to settings update path |
| `src/server/shared/types/ws-server-messages.ts` | Add `WsOpenUrl` |
| `src/server/orchestrator/ws-handlers/claude-execution.ts` | Emit `open_url` after successful `quickCreatePr` if setting on |
| `src/server/orchestrator/integration_tests/pr-auto-open.test.ts` | New |
| `src/client/components/PrLifecycleCard.tsx` | Second toggle (`AutoOpenPrToggle`) in overflow menu |
| `src/client/hooks/useMessageHandler.ts` | Handle `open_url` |
| `src/client/stores/settings-store.ts` | Track `autoOpenPr` |

## Future extensions (out of scope)

- **Open in same tab via tab pinning** — if ShipIt ever supports a "PR drawer" that embeds GitHub via iframe, that would obviate this entirely. GitHub's `X-Frame-Options: DENY` makes that impossible today.
- **Open the local diff dialog instead** — already accessible via the lifecycle card's diff button. Different feature.
- **Notify-only mode** — surface a desktop notification instead of opening a tab. Could be added as a third option to the toggle (`Off / Notify / Open`).
