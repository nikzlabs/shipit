---
issue: https://linear.app/shipit-ai/issue/SHI-190
title: Unify the file dialog and the Present tab on one shared renderer
description: Extract content rendering + review into a shared FileContentView so the file-viewer dialog and the Present tab behave identically — HTML/SVG render, frontmatter is stripped, and review comments work in both.
---

# Unify the file dialog and the Present tab on one shared renderer

## Context

ShipIt has two ways to view a workspace file, and they have drifted apart:

- **The file-viewer dialog** (`FilePreviewModal.tsx`) — opens when a user clicks a file in the file tree or docs list. Markdown gets frontmatter stripped + a `FrontmatterHeader` + inline review/selection comments; code gets Monaco with line comments. **But HTML and SVG show as raw source** (Monaco), so a committed `mockup.html` / `mockup.svg` cannot be viewed rendered unless the agent explicitly `present`s it.
- **The Present tab** (`PresentPane.tsx`) — a carousel of artifacts pushed by the `present` MCP tool. HTML/SVG render in a sandboxed iframe, but markdown is rendered by a *different* component (`MarkdownContent`) that does **not** strip frontmatter and has **no** review comments.

The two surfaces are conceptually almost the same thing (view a file), yet diverge on HTML rendering, frontmatter handling, and review. The user wants them reconciled: **one shared renderer, identical UX and implementation**, so committed mockups are viewable without the agent presenting them, frontmatter is handled the same way everywhere, and review/selection comments work in **both** surfaces. Both containers stay for now (the dialog may be removed later), so the shared piece must be self-contained.

## Approach

Extract the *content rendering + review* into a single self-contained `FileContentView` component that both surfaces delegate to. Each surface keeps only its own chrome (the dialog keeps sibling tabs + footer; Present keeps the carousel + download + lazy fetch). Content fetching stays per-surface — `FileContentView` is fetch-agnostic and takes already-loaded `content`.

### One internal content model

The dialog keys on `FilePreviewType` (`markdown|code|image|binary`); Present keys on MIME strings. Introduce a single discriminated kind both map into, so the shared component never sees either vocabulary.

- **New** `src/client/utils/file-content-kind.ts`:
  - `type ContentKind = "markdown" | "html" | "svg" | "image" | "code" | "binary"`
  - `kindFromPreviewType(t, filePath)` — splits `.svg`→`svg` and `.html/.htm`→`html` out of the current `image`/`code` buckets (this is the fix that makes HTML/SVG render in the dialog).
  - `kindFromMimeType(mime, filePath)` — `text/html→html`, `image/svg+xml→svg`, `text/markdown→markdown`, `image/*→image`, else `code`.
  - `supportsSourceToggle(kind)` → `kind === "html" || kind === "svg"`.
  - `isRepoReviewablePath(filePath)` → true when the path is workspace-relative (not absolute, not `/tmp`); `supportsKindReview(kind)` → markdown/code/html/svg.
  - Co-located `file-content-kind.test.ts`: `.svg→svg`, `.html→html`, `/tmp/x.html` not reviewable, `docs/x.html` reviewable, MIME mappings.

### Shared `FileContentView`

- **New** `src/client/components/FileContentView/` with:
  - `FileContentView.tsx` — props `{ filePath, content, kind, sessionId, reviewable, viewMode: "rendered"|"source", onViewModeChange?, revealLine?, readOnly? }`; dispatches on `kind` + `viewMode`:
    - `markdown` → `MarkdownReviewView` (frontmatter header + `skipHtml` body + selection comments; read-only when not reviewable).
    - `html` → rendered: sandboxed iframe (`sandbox="allow-scripts"`, `srcDoc`); source: `CodeEditor` (Monaco, html).
    - `svg` → rendered: iframe with the existing white-host wrapper; source: `CodeEditor` (xml).
    - `image` → `<img src={content}>`.
    - `code` → `CodeEditor` (Monaco + line comments + `revealLine`).
    - `binary` → "cannot display" message.
  - `CodeEditor.tsx` — moved verbatim from `FilePreviewModal` (incl. `getLanguageFromPath`, `MonacoCommentWidgets`, `revealLine`; keep its `eslint-disable` comments).
  - `MarkdownReviewView.tsx` — the current `MarkdownViewer` body (wraps `MarkdownSelectionComments`).
  - `RenderedFrame.tsx` — the sandboxed iframe for html + the svg host wrapper, lifted from `PresentPane`'s `PresentationContent`.
  - `FileContentView.test.tsx` — per-kind + toggle render tests.

Both surfaces render `<FileContentView key={...} />` (key on filePath/presentId so Monaco/iframe remount cleanly on switch).

### Source / Rendered toggle

Default `viewMode = "rendered"` for html/svg. The toggle lives in **each surface's existing header** (a small segmented control shown when `supportsSourceToggle(kind)`), holding `viewMode` in local `useState` and passing it down — keeps `FileContentView` a pure renderer with no second header.

### Review comments in both surfaces

Review state is already keyed `${sessionId}::${filePath}` in `file-review-store` and is generic over filePath. Lift the dialog's draft/history/send/ask logic into a reusable hook so Present can use it too.

- **New** `src/client/hooks/use-file-review-controls.ts` (+ test) — returns `{ commentCount, history, canSend, handleSend, showAskReview, handleAskReview }` given `(sessionId, filePath, kind)`; tolerates a no-op/absent `onClose` (Present has no modal to close).
- **`FilePreviewModal.tsx`** — replace the content branch (~583–617) with `FileContentView`; add the source toggle to the header; replace inline review state with `useFileReviewControls`. Keep `SendCommentsPayload` exported here (DiffPanel + App import it).
- **`PresentPane.tsx`** — replace `PresentationContent` (~198–263) with `FileContentView`; add source toggle to the carousel header; add a review footer mirroring the modal's, shown when `reviewable && (commentCount>0 || history.length>0)`. `reviewable = isRepoReviewablePath(active.filePath) && supportsKindReview(kind)` so `/tmp` artifacts render read-only with no footer. Accept `onSendComments` / `onAskAgentReview` props. **Hook-order**: call `useFileReviewControls` unconditionally before the `if (!active) return`, passing `active?.filePath ?? ""` (mirror the existing pre-early-return `active` computation at lines 50–60).
- **`App.tsx`** — pass the existing `handleFileSendComments` / `handleAskAgentReview` into `<PresentPane>`.

Note: HTML/SVG have no inline comment surface in rendered (iframe) mode — to review them the user flips to **source**, where Monaco line comments work. Consistent, no new mechanism.

### Markdown convergence

Both surfaces converge on `MarkdownSelectionComments` (frontmatter header + `skipHtml` + review). **`MarkdownContent` (`message-markdown.tsx`) is left untouched** — it stays for chat/PR/plan/subagent and server-side rendering. Net effect: Present markdown gains frontmatter stripping + review; chat is unaffected.

## Files

**Create**
- `src/client/utils/file-content-kind.ts` (+ `.test.ts`) — single `ContentKind` model, adapters, reviewable gate.
- `src/client/components/FileContentView/{FileContentView,CodeEditor,MarkdownReviewView,RenderedFrame}.tsx` (+ `FileContentView.test.tsx`) — shared renderer.
- `src/client/hooks/use-file-review-controls.ts` (+ test) — shared review draft/send/ask state.

**Modify**
- `src/client/components/FilePreviewModal.tsx` — delegate to `FileContentView`, add source toggle, use the hook.
- `src/client/components/PresentPane.tsx` — delegate to `FileContentView`, add source toggle + review footer, accept review props.
- `src/client/App.tsx` — pass review handlers to `PresentPane`.
- `src/client/components/FilePreviewModal.test.tsx` — update assertions tied to the old branch structure if needed.

## Risks

- **Sandbox.** Committed HTML now renders the same way `/tmp` artifacts do: `sandbox="allow-scripts"` (no `allow-same-origin`) + `srcDoc` keeps the frame origin-null — no cookie/storage/parent access. Do not add `allow-same-origin`.
- **`/tmp` artifacts** aren't addressable by the file-review endpoints — gated out by `isRepoReviewablePath`; render read-only.
- **Monaco in the carousel** — mounts only in source/code mode; keep the per-entry `key` so it disposes/recreates on navigation and viewMode toggle (matches the modal lifecycle).
- **Present markdown visual shift** — frontmatter is now stripped into a header; intended, flag for visual review.
- **`SendCommentsPayload` import graph** — keep it exported from `FilePreviewModal` (or move to a shared types module and re-export) so `DiffPanel.tsx` / `App.tsx` imports don't break.

## Verification

- `npm run typecheck` — adapter wiring + prop changes.
- `npm run lint:dev` — moved Monaco/`useEffect` code keeps its `eslint-disable` comments.
- Co-located unit tests only (NOT full `npm test` — it OOMs the container):
  `npx vitest run src/client/utils/file-content-kind.test.ts src/client/components/FileContentView src/client/hooks/use-file-review-controls.test.ts src/client/components/FilePreviewModal.test.tsx src/client/components/PresentPane.test.tsx`
- Browser verify: open `.html` + `.svg` from the tree → renders by default, Source toggle shows Monaco; open a markdown doc → frontmatter header + add a selection comment + Send. In Present: push a workspace-relative HTML artifact → toggle source, add a line comment, Send; push a `/tmp` artifact → confirm read-only, no review footer.
