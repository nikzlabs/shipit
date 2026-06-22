# Checklist

- [ ] `file-content-kind.ts` — `ContentKind` model + `kindFromPreviewType` / `kindFromMimeType` / `supportsSourceToggle` / `isRepoReviewablePath` / `supportsKindReview` (+ test)
- [ ] `FileContentView/` — `FileContentView`, `CodeEditor` (moved verbatim), `MarkdownReviewView`, `RenderedFrame` (+ test)
- [ ] `use-file-review-controls.ts` — shared draft/history/send/ask hook (+ test)
- [ ] `file-download.ts` — lift download helpers out of `PresentPane`; `triggerDownload({ name, content, mimeType })` (+ test)
- [ ] `FilePreviewModal.tsx` — delegate to `FileContentView`, add source toggle + Download action, use the hook; keep `SendCommentsPayload` exported
- [ ] `PresentPane.tsx` — delegate to `FileContentView`, add source toggle + review footer, accept review props, unconditional hook call; import download helpers from `file-download.ts`
- [ ] `App.tsx` — pass `handleFileSendComments` / `handleAskAgentReview` into `<PresentPane>`
- [ ] `FilePreviewModal.test.tsx` — update assertions tied to the old branch structure
- [ ] Verify: typecheck, lint:dev, co-located unit tests, browser check (HTML/SVG render + toggle, markdown frontmatter + review, Present `/tmp` read-only)
