# Agent-authored links — checklist

## Parsing

- [x] `shipit-link.ts` — scheme constants, `parseShipitLink`
- [x] Reject-don't-truncate: length caps, one leading `/`, backslash and
      tab/CR/LF rejected before URL resolution
- [x] Service authority read from the raw href (not `URL.hostname`), exact match
- [x] `shipit-render` allowlist; duplicate key rejected; stripped from the
      navigation URL, with the rest of the query preserved byte-for-byte
- [x] `hash` stored without `#`, decoded once

## Rendering

- [x] Opt-in renderer capability in `message-markdown.tsx`, default off, with a
      second **module-level** components map
- [x] Enabled only for assistant messages in `MessageList.tsx`
- [x] `MarkdownLink` branch ordered ahead of the repo-file branch, no real `href`
- [x] Link / badge / button forms (req 1)

## Preview flow

- [x] Navigation intent in `preview-store` — session-scoped, `clickId`,
      `phase`, TTL; kept separate from `previewPaths`
- [x] Resolve before reveal; `revealWorkspaceTab(tab)` helper shared with
      `PresentToolChip`
- [x] `usePreviewLinkIntent` sends `start_service` for a stopped target;
      `starting` waits without re-sending (req 12)
- [x] Intent reselects its own port when its service reaches `running`
- [x] A new slot is created at the destination; a live slot is navigated by
      assigning `src`
- [x] Cancel on session switch; last-click-wins on rapid clicks

## Present flow

- [x] `present-store` — `focusByPath` (closes the gallery), `linkTarget`
- [x] Delivery switches source view to rendered, and waits for content
- [x] Markdown fragment scroll: Present-only container ref, the tested slug
      algorithm, first-match-wins
- [x] HTML fragment: scroll script injected into the `srcDoc`, fragment
      escaped for HTML as well as JSON, scroll on `DOMContentLoaded`

## Docs

- [x] `src/server/shipit-docs/chat-links.md` — including that a Preview page
      reads its own URL and ShipIt adds no API
- [x] `src/server/orchestrator/prompts/live-preview.md` — respecting the
      prompt-cache contract (rendered once at module load)

## Tests

- [x] Parse: both schemes, every rejection case, the render allowlist
- [x] Branch order vs repo-file links; all three rendered forms
- [x] Schemes inert in PR/issue/repo-authored markdown
- [x] Multi-service: A running, pointer to stopped B, B's port becomes selected
- [x] Session-switch cancellation; a service that vanished after the click
- [x] Re-click and rapid-click semantics
- [x] Gallery open, source view, content-fetch failure
- [x] Missing markdown heading
- [x] Injected scroll script: a fragment with quotes, backslashes or a closing
      script tag cannot break out

## Quality

- [x] `lint:dev` + `typecheck` clean
- [ ] Cross-backend review of the implementation
