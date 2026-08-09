# Agent-authored links — checklist

- [ ] `shipit-link.ts` — scheme constants, `parseShipitLink`, path safety
- [ ] `open-shipit-link.ts` — click action for both surfaces + unavailable toasts
- [ ] `message-markdown.tsx` — `urlTransform` passthrough + `MarkdownLink` branch
- [ ] `preview-store` — `pendingNavigation` handoff
- [ ] `present-store` — `focusByPath` + `pendingLink`
- [ ] `PreviewFrame` — navigate live slot, deliver link on handshake
- [ ] `PresentPane` — deliver link to the artifact frame
- [ ] `preview-proxy.ts` — `navigate` command in the injected script
- [ ] SDK `bootstrap.ts` — `window.shipit.links` + fragment scroll
- [ ] Agent-facing docs (`chat-links.md`, SDK doc, system prompt)
- [ ] Tests: parse, click action, store additions, markdown render, SDK
- [ ] `lint:dev` + `typecheck` clean
- [ ] Cross-backend review (Codex)
