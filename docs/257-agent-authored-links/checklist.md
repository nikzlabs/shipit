# Agent-authored links — checklist

- [ ] `shipit-link.ts` — scheme constants, `parseShipitLink`, `shipit-render`
      allowlist + strip, reject-don't-truncate validation
- [ ] `open-shipit-link.ts` — reveal the panel, resolve, navigate/focus; toast on
      every unopenable pointer (req 10)
- [ ] `message-markdown.tsx` — `urlTransform` passthrough + a `MarkdownLink`
      branch ordered ahead of the repo-file branch, with no real `href`
- [ ] Link / badge / button renderers (req 1)
- [ ] `preview-store` — navigation intent (service, path, payload)
- [ ] `App.tsx` — `start_service` for an intent whose service is stopped;
      `starting` waits without re-sending; `error` and a refused `send()` toast (req 12)
- [ ] `present-store` — `focusByPath` + `pendingLink`
- [ ] `PreviewFrame` — navigate the live slot by assigning `src`, deliver the
      link on the next handshake
- [ ] `PresentPane` — deliver the link to the artifact frame
- [ ] SDK `bootstrap.ts` — `window.shipit.links` with replay, fragment scroll
      deferred to `DOMContentLoaded` (req 9, req 11)
- [ ] Agent-facing docs (`chat-links.md`, SDK doc, system prompt)
- [ ] Tests: parse + rejection cases, click action, store additions, branch
      order vs repo-file links, markdown render of all three forms, SDK link
      replay, early and late fragment delivery
- [ ] `lint:dev` + `typecheck` clean
- [ ] Cross-backend review of the implementation
