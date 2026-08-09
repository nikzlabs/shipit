# Agent-authored links — checklist

## Parsing

- [ ] `shipit-link.ts` — scheme constants, `parseShipitLink`
- [ ] Reject-don't-truncate: length caps, one leading `/`, backslash and
      tab/CR/LF rejected before URL resolution
- [ ] Service authority read from the raw href (not `URL.hostname`), exact match
- [ ] `shipit-render` allowlist; duplicate key rejected; stripped from both the
      payload and the navigation URL
- [ ] Last-wins repeated query keys; `hash` stored without `#`, decoded once

## Rendering

- [ ] Opt-in renderer capability in `message-markdown.tsx`, default off, with a
      second pair of **module-level** components/`urlTransform` constants
- [ ] Enabled only for assistant messages in `MessageList.tsx`
- [ ] `MarkdownLink` branch ordered ahead of the repo-file branch, no real `href`
- [ ] Link / badge / button forms (req 1)

## Preview flow

- [ ] Navigation intent in `preview-store` — session-scoped, `clickId`,
      `phase`; kept separate from `previewPaths`
- [ ] Resolve before reveal; `revealWorkspaceTab(tab)` helper shared with
      `PresentToolChip`
- [ ] `App.tsx` sends `start_service` for a stopped target; `starting` waits
      without re-sending (req 12)
- [ ] Intent reselects its own port when its service reaches `running`
- [ ] Navigate the live slot by assigning `src`; deliver the link on the next
      handshake
- [ ] Cancel on session switch; last-click-wins on rapid clicks

## Present flow

- [ ] `present-store` — `focusByPath` (closes the gallery), `pendingLink`
- [ ] Delivery switches source view to rendered, and waits for content + frame
- [ ] Markdown fragment scroll: Present-only container ref, the tested slug
      algorithm, first-match-wins
- [ ] HTML fragment: scroll script injected into the `srcDoc`, fragment
      JSON-encoded, scroll on `DOMContentLoaded`

## Docs

- [ ] `src/server/shipit-docs/chat-links.md` — including that a Preview page
      reads its own URL and ShipIt adds no API
- [ ] `src/server/orchestrator/prompts/live-preview.md` — respecting the
      prompt-cache contract (render once at module load)

## Tests

- [ ] Parse: both schemes, every rejection case, the render allowlist
- [ ] Branch order vs repo-file links; all three rendered forms
- [ ] Schemes inert in PR/issue/repo-authored markdown
- [ ] Multi-service: A running, pointer to stopped B, B becomes active at the path
- [ ] Session-switch cancellation; stale `service_list`/`service_status`
- [ ] Re-click and rapid-click semantics
- [ ] Gallery open, source view, content-fetch failure
- [ ] Missing markdown heading and missing HTML fragment
- [ ] Injected scroll script: fragment with quotes/backslashes cannot break out

## Quality

- [ ] `lint:dev` + `typecheck` clean
- [ ] Cross-backend review of the implementation
