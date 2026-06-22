# Checklist

- [ ] `file-content-kind.ts` — `ContentKind` model + `kindFromPreviewType` / `kindFromMimeType` / `supportsSourceToggle` / `isRepoReviewablePath` / `supportsKindReview` (+ test)
- [ ] `FileContentView/` — `FileContentView` (pure renderer, owns per-kind scroll/padding, takes comment arrays as props), `CodeEditor` (moved verbatim), `MarkdownReviewView`, `RenderedFrame` (normalizes `data:` URI vs raw markup for SVG) (+ test incl. SVG data-URI handling)
- [ ] `RenderedFrame` CSP hardening (recommended) — frame CSP `connect-src 'none'; form-action 'none'` to block outbound requests from rendered repo HTML; never add `allow-same-origin`
- [ ] `use-file-review-controls.ts` — shared draft/history/send/ask hook, incl. ask-review gating inputs (agent capability, running, content-loaded, size cap) + typed render-comment arrays (+ test)
- [ ] `FilePreviewModal.tsx` — delegate to `FileContentView`, add source toggle, use the hook; keep `SendCommentsPayload` exported; leave its existing server-backed Download action untouched
- [ ] `PresentPane.tsx` — delegate to `FileContentView`, add source toggle + review footer, accept review props, unconditional hook call; leave its existing Blob download untouched; discard empty draft on carousel nav + tab blur
- [ ] `App.tsx` — pass `handleFileSendComments` / `handleAskAgentReview` into `<PresentPane>`
- [ ] `FilePreviewModal.test.tsx` — update assertions tied to the old branch structure
- [ ] Verify: typecheck, lint:dev, co-located unit tests, browser check (HTML/SVG render + toggle incl. an SVG file from the tree, markdown frontmatter + review, Present `/persist` artifact read-only, dialog download of a binary/large file = raw bytes)
