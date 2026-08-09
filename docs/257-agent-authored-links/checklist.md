# Agent-authored links — checklist

Implementation has not started. Requirements are settled (no open questions);
the Codex review of the docs is outstanding.

- [ ] `shipit-link.ts` — scheme constants, `parseShipitLink`, `shipit-render`
      strip, path safety
- [ ] `open-shipit-link.ts` — click action for both surfaces + unavailable toasts (req 10)
- [ ] `message-markdown.tsx` — `urlTransform` passthrough + `MarkdownLink` branch
- [ ] Link / badge / button renderers (req 1)
- [ ] `preview-store` — navigation intent (path, payload, service)
- [ ] `App.tsx` — send `start_service` for an intent naming a stopped service (req 12)
- [ ] `present-store` — `focusByPath` + `pendingLink`
- [ ] `PreviewFrame` — navigate live slot, deliver link on handshake
- [ ] `PresentPane` — deliver link to the artifact frame
- [ ] `preview-proxy.ts` — `navigate` command in the injected script
- [ ] SDK `bootstrap.ts` — `window.shipit.links` + fragment scroll (req 9, req 11)
- [ ] Agent-facing docs (`chat-links.md`, SDK doc, system prompt)
- [ ] Tests: parse, click action, store additions, markdown render, SDK
- [ ] `lint:dev` + `typecheck` clean
- [ ] Cross-backend review (Codex) of the implementation
