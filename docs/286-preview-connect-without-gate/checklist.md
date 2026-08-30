# Preview connects without a client-side gate — checklist

- [x] `proxyPreviewRequest` retries the upstream connect (unresolved target and
      connect-class errors) for a bounded window, `GET`/`HEAD` only.
- [x] Retry re-resolves the target on every attempt.
- [x] A retry timer stops when the viewer disconnects (`rawRes` close).
- [x] `buildConnectingPage` serves a self-refreshing 503 HTML page for an
      HTML-accepting `GET`; everything else keeps the 502 JSON.
- [x] The connecting page goes through `injectPreviewBootstrap` so it posts
      `loaded` and cannot trip the auth-blocked detector.
- [x] `reportError` fires once at exhaustion, and not on the connecting-page
      path — a boot is not a fault for auto-fix to chase.
- [x] `/api/preview-health/:sessionId/:port` deleted.
- [x] `usePreviewHealthPoller` renamed to `usePreviewSlot`; poll loop, deadline,
      `pollUrl`/`isContainerMode` params and `pollingRef` removed.
- [x] `pollingRef` removed from `IframePool`.
- [x] `IframeSlot.generation` added, so a slot rebuilt after an ownership
      takeover still mounts a fresh iframe (planning#394).
- [x] "Connecting to dev server..." overlay removed from `PreviewFrame`.
- [x] Proxy tests: retry-then-succeed (verified red without the retry),
      non-retryable method fails fast, connecting page after the window, asset
      still gets JSON, script-literal escaping.
- [x] Client tests updated for synchronous slot creation; poll-era tests
      deleted rather than rewritten.
- [x] `CLAUDE.md` preview-routing paragraph records the retry and the new file
      name.
- [x] `docs/089-persistent-preview-iframes/plan.md` and
      `docs/226-use-polling-hook/plan.md` updated.
- [x] `npm run typecheck`, `npm run lint:dev`, client suite green.
- [x] Server suite green (two unrelated full-run flakes, both pass in
      isolation: `block-branch-ops`, `graduate-session`).
- [x] Independent review via `shipit agent run --role reviewer`, findings
      addressed:
  - [x] Retry window cut to 2.5 s so a held first load cannot outrun the
        client's 5 s auth-detection timer and produce a false "authentication
        required" (req 6).
  - [x] Connect phase bounded (`PREVIEW_CONNECT_TIMEOUT_MS`), so a target that
        drops the SYN can no longer hang the request past the deadline. Guard
        test verified red without it.
  - [x] Pending retry timer cleared on viewer disconnect, not just no-opped.
  - [x] `reportError` restored on the navigation path — `preview_error` paints
        a banner and does not reach auto-fix, so suppressing it lost the
        docs/124 §1.5 signal for nothing.
  - [x] Auth-detection state keyed by `slotKey#generation`, so a rebuilt slot
        cannot inherit the previous owner's loaded/blocked verdict.
  - [x] Local (non-container) preview regression assessed: the branch is
        unreachable, evidence recorded in the plan.
- [x] Connecting page rendered and checked in a browser (spinner, port, copy).
