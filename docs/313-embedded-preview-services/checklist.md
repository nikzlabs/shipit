# Embedding a Compose service by name — checklist

- [x] `requirements.md` written from the requester's brief, with the two open
      questions answered and receipted
- [x] Injected embed resolver (`shared/preview-embed/bootstrap.ts`): parse,
      resolve against the declared map, rewrite `src` in the live DOM
- [x] The map rides as a script **attribute**, so the hashed body stays constant
      under `allowPreviewBootstrapInCsp`
- [x] Proxy injects it with the session's declared service→port map
- [x] `IntersectionObserver` per embed, one start request per service per document
- [x] `PreviewFrame` accepts `embed_start_service` only from the active,
      visible slot's own window at that slot's origin
- [x] `App` sends `start_service` only for a declared service that is not
      already running or starting, with a cooldown
- [x] Resolver tests: rewriting, dynamic insertion, exact name match, origin
      escape, backslash, render-parameter strip, non-iframe elements
- [x] Serialization test under the production tsx transform
- [x] Guard test: the SDK inside an embedded frame reports `embedded: false` and
      sends nothing (req 7)
- [x] Guard test: a container preview mounts with no `sandbox` to inherit (req 6)
- [x] Independent review, and its findings folded in: first-label host grammar,
      `//` network-path refusal, `shipit-render` stripped on both sides of the
      `#`, the iframe test moved inside `rewrite`, one pending observer per
      element re-checked on fire, session-scoped cooldown recorded only on a
      successful send, prototype-safe name sets, open shadow roots
- [x] `chat-links.md` — the `src` form, the stopped-service behaviour, and what
      a framed document must do when its address moves (req 8)
- [x] `agent-interface-sdk.md` — the SDK is not available to an embedded frame
- [x] `preview.md` and `wiki/previews.md` cross-references
