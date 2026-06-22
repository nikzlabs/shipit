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

Extract the *content rendering + review* into a single self-contained `FileContentView` component that both surfaces delegate to. Each surface keeps only its own chrome (the dialog keeps sibling tabs + footer; Present keeps the carousel). Content fetching stays per-surface — `FileContentView` is fetch-agnostic and takes already-loaded `content`.

**What "lazy fetch" is, and why it stays Present-only.** The Present store holds only metadata per artifact (title, MIME, `presentId`) — *not* the bytes. The first time an entry is shown, `PresentPane` fetches its bytes once from `GET /api/sessions/:id/present/:presentId/content` (a disk read proxied to the worker) and caches them back onto the entry; a reload re-fetches because the server retains nothing (`PresentPane.tsx` header comment + the `useEffect` at ~86). The **dialog has no equivalent**: its caller (`App.tsx` via `openPreview`) loads the file and passes `content` in as a prop already-resolved. So "lazy fetch" is just *how the Present surface obtains bytes*; it has nothing to do with rendering, which is exactly why `FileContentView` is fetch-agnostic and both surfaces feed it an already-loaded `content` string. No change here — it's named only to mark the boundary of what is *not* being shared.

**Download already works in both — leave each surface's mechanism alone.** An earlier draft of this plan claimed the dialog had no download; that is wrong. The dialog already injects a **server-backed** Download action — `App.tsx` builds it (`App.tsx:829`) and passes it into `FilePreviewModal` (`App.tsx:1284`); it streams **raw bytes** from `GET /api/sessions/:id/files/download/*` (`api-routes-files.ts:192`). Present has its own **client-side** `Blob` + `<a download>` download (`downloadPresentation` in `PresentPane.tsx`) because Present artifacts are *not* workspace files — there is no server route to stream them, so the cached bytes are turned into a Blob locally. **These two mechanisms are both correct and must stay as-is.** In particular, do **not** route the dialog's download through the artifact `Blob` path: the dialog's `content` prop is *preview* content, which for binary or too-large files is a placeholder string (`files.ts:55,70,77`), so a `Blob` of it would download a wrong/truncated file. The dialog keeps server-backed raw-byte download; Present keeps client Blob download. No shared download util, no new dialog affordance — this part of the reconciliation is already done.

### One internal content model

The dialog keys on `FilePreviewType` (`markdown|code|image|binary`); Present keys on MIME strings. Introduce a single discriminated kind both map into, so the shared component never sees either vocabulary.

- **New** `src/client/utils/file-content-kind.ts`:
  - `type ContentKind = "markdown" | "html" | "svg" | "image" | "code" | "binary"`
  - `kindFromPreviewType(t, filePath)` — splits `.svg`→`svg` and `.html/.htm`→`html` out of the current `image`/`code` buckets (this is the fix that makes HTML/SVG render in the dialog). **Note** `detectFilePreviewType` (`file-preview-type.ts`) currently classes `.svg` as `image` and `.html` as `code`, and the files service returns images (incl. SVG) as a base64 **data URI** (`files.ts:54–66`) while `.html` comes through as raw text — so the dialog's SVG content is a data URI and its HTML is raw markup. The renderer must normalize this (see the SVG note under *Shared FileContentView*).
  - `kindFromMimeType(mime, filePath)` — `text/html→html`, `image/svg+xml→svg`, `text/markdown→markdown`, `image/*→image`, else `code`.
  - `supportsSourceToggle(kind)` → `kind === "html" || kind === "svg"`.
  - `isRepoReviewablePath(filePath)` → true only for a **workspace-relative** path: reject **any** absolute path (leading `/`) and any `..` traversal segment. Present artifacts legitimately live **outside** the git clone — since docs/217 the `present` default for throwaways is `/persist` (the host-backed, non-git persistent scratch mount), and the agent may also present an arbitrary absolute path; see `present-flow.test.ts:238`. The file-review endpoints resolve against the session **workspace**, so only repo-relative paths are addressable; everything under `/persist` (or any other absolute path) is non-reviewable. `supportsKindReview(kind)` → markdown/code/html/svg.
  - Co-located `file-content-kind.test.ts`: `.svg→svg`, `.html→html`, absolute `/persist/x.html` not reviewable, any absolute `/anything` not reviewable, `../escape` not reviewable, `docs/x.html` reviewable, MIME mappings.

### Shared `FileContentView`

- **New** `src/client/components/FileContentView/` with:
  - `FileContentView.tsx` — props `{ filePath, content, kind, sessionId, reviewable, viewMode: "rendered"|"source", onViewModeChange?, revealLine?, readOnly?, markdownComments, codeComments }`; dispatches on `kind` + `viewMode`. **Ownership boundary (do not skip):** the modal today derives `markdownComments`/`codeComments` from the active draft (`FilePreviewModal.tsx:489`) and passes them into `MarkdownViewer`/`CodeEditor` (`:590`, `:609`). `useFileReviewControls` must therefore return these typed comment arrays (not just `commentCount`), and the surface passes them into `FileContentView` — otherwise inline comments silently disappear. `FileContentView` stays a pure renderer (no `file-review-store` selectors of its own); the hook owns the store, the renderer owns layout. Dispatch:
    - `markdown` → `MarkdownReviewView` (frontmatter header + `skipHtml` body + selection comments; read-only when not reviewable).
    - `html` → rendered: sandboxed iframe (`sandbox="allow-scripts"`, `srcDoc`); source: `CodeEditor` (Monaco, html).
    - `svg` → rendered: iframe with the existing white-host wrapper; source: `CodeEditor` (xml). **Content-shape caveat (see SVG note below):** Present feeds raw SVG markup, but the dialog's files API returns SVG as a `data:image/svg+xml;base64,…` URI. `RenderedFrame` must accept either — decode a `data:` URI to markup before wrapping — and source mode must show decoded XML, not the data-URI string.
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

- **New** `src/client/hooks/use-file-review-controls.ts` (+ test) — returns `{ commentCount, markdownComments, codeComments, history, canSend, handleSend, showAskReview, handleAskReview }` given `(sessionId, filePath, kind)`; tolerates a no-op/absent `onClose` (Present has no modal to close). **It must reproduce the modal's existing `showAskReview` gating, not just expose the flag** (`FilePreviewModal.tsx:413–449`): the active agent's `supportsReview` capability (Codex hides the affordance entirely), `content !== null`, `onAskAgentReview` present, and the size rule — markdown of any size, or code (and now html/svg-as-source) under the 10 KB cap. The hook reads these from the same stores the modal does (`useUiStore` agent list, `useSessionStore` loading) so both surfaces gate identically. `canSend = commentCount > 0 && onSendComments present`.
- **`FilePreviewModal.tsx`** — replace the content branch (~583–617) with `FileContentView`; add the source toggle to the header; replace inline review state with `useFileReviewControls`. Keep `SendCommentsPayload` exported here (DiffPanel + App import it).
- **`PresentPane.tsx`** — replace `PresentationContent` (~198–263) with `FileContentView`; add source toggle to the carousel header; add a review footer mirroring the modal's, shown when `reviewable && (commentCount>0 || history.length>0)`. `reviewable = isRepoReviewablePath(active.filePath) && supportsKindReview(kind)` so non-workspace artifacts (e.g. `/persist` throwaways) render read-only with no footer. Accept `onSendComments` / `onAskAgentReview` props. **Hook-order**: call `useFileReviewControls` unconditionally before the `if (!active) return`, passing `active?.filePath ?? ""` (mirror the existing pre-early-return `active` computation at lines 50–60).
- **`App.tsx`** — pass the existing `handleFileSendComments` / `handleAskAgentReview` into `<PresentPane>`.

Note: HTML/SVG have no inline comment surface in rendered (iframe) mode — to review them the user flips to **source**, where Monaco line comments work. Consistent, no new mechanism. Server-side this rides the existing review typing: `reviews.ts` treats markdown specially and **everything else as "code"** (`reviews.ts:97`), and line comments require `fileType === "code"` (`reviews.ts:225`) — so HTML/SVG source review maps onto the server's "code" path with **no new server review type**. Call this out so a future reader doesn't add one.

**Present draft cleanup.** The review store's `load()` creates a server-side draft on first reviewable open (`file-review-store.ts:131`); the modal discards an empty draft on close / sibling switch (`FilePreviewModal.tsx:452`). Present has **no close event**, so without handling, opening reviewable artifacts would accumulate empty drafts. The plan: call `discardEmptyDraft` on **carousel navigation and Present-tab blur** (the Present analogues of the modal's close), wired through `useFileReviewControls` so the cleanup logic is shared, not reimplemented.

### Download (no change)

Both surfaces already download (dialog: server-backed raw bytes; Present: client Blob of the cached artifact) — see the Approach note above. **No work here.** Deliberately *not* unified into a shared util, because the two source the bytes differently (workspace file vs. in-memory artifact) and the dialog's server-backed path is the only one that's correct for binary/large files. Listed only to record that it was considered and intentionally left alone.

### Markdown convergence

Both surfaces converge on `MarkdownSelectionComments` (frontmatter header + `skipHtml` + review). **`MarkdownContent` (`message-markdown.tsx`) is left untouched** — it stays for chat/PR/plan/subagent and server-side rendering. Net effect: Present markdown gains frontmatter stripping + review; chat is unaffected.

## Files

**Create**
- `src/client/utils/file-content-kind.ts` (+ `.test.ts`) — single `ContentKind` model, adapters, reviewable gate.
- `src/client/components/FileContentView/{FileContentView,CodeEditor,MarkdownReviewView,RenderedFrame}.tsx` (+ `FileContentView.test.tsx`) — shared renderer.
- `src/client/hooks/use-file-review-controls.ts` (+ test) — shared review draft/send/ask state.

**Modify**
- `src/client/components/FilePreviewModal.tsx` — delegate to `FileContentView`, add source toggle, use the hook. Keep its existing server-backed Download action untouched.
- `src/client/components/PresentPane.tsx` — delegate to `FileContentView`, add source toggle + review footer, accept review props. Keep its existing client-Blob download untouched.
- `src/client/App.tsx` — pass review handlers to `PresentPane`.
- `src/client/components/FilePreviewModal.test.tsx` — update assertions tied to the old branch structure if needed.

## Risks

- **Sandbox / expanded script surface.** This change lets *arbitrary committed repo HTML* execute scripts in the user's browser, where before only agent-presented artifacts did. The threat model, and why the residual risk is acceptable:

  - **Two trust layers already bound this.** (1) **Repo approval** — a user must approve a repository before the agent runs against it, a one-time repo-level trust gate. (2) **The origin-null sandbox** — `sandbox="allow-scripts"` (no `allow-same-origin`) + `srcDoc` keeps the frame origin-null: no cookies, no storage, no parent-frame/DOM/token access, no top-level navigation (`PresentPane.tsx:16`). The sandbox is the load-bearing mitigation — even fully malicious HTML **cannot steal ShipIt credentials or read the workspace**.
  - **What repo approval covers, and what it doesn't.** Framed by *who authored the HTML*: for the dominant **solo-dev-on-own-repo** case it effectively closes the risk (attacker and viewer are the same person — you can't attack yourself). It does **not** close the **multi-author / fork-PR-checkout / vendored-HTML** case (you approved the repo, not a later contributor's commit — a classic time-of-check vs time-of-use gap), nor the **agent-authored** case (a prompt-injected agent can be induced to *write* an HTML file into the approved repo — exactly where it writes). Approval is coarse and one-shot.
  - **Residual capability after both layers.** Narrow: outbound network requests (beacon out whatever is embedded in the page, or use the user's browser/IP as a vantage point) and in-frame phishing UI. No credential or workspace exfil.
  - **Decision.** Given repo approval + the origin-null sandbox, and that this only *widens* an exposure already shipped for the Present tab (it is not a new class), the residual risk is **low enough to ship default-rendered**. A per-render "this file runs scripts — render?" confirmation is **rejected**: it fights the "view it like any other file" goal for marginal safety, since the sandbox already blocks the high-severity outcomes.
  - **Recommended hardening (defense-in-depth, optional).** The only gap the sandbox leaves open is the *outbound request*. Close it with a **CSP on the frame** — `connect-src 'none'; form-action 'none'` (and tighten `img-src`/`script-src` as far as content tolerates) — not a confirmation gate. That neutralizes beaconing/exfil while keeping rendering frictionless. Hard invariant either way: **never add `allow-same-origin`.**
- **SVG content shape (dialog vs Present).** Dialog SVG is a base64 `data:` URI; Present SVG is raw markup. If `RenderedFrame` / source mode don't normalize, the dialog renders a data-URI string and source shows the URI instead of XML. Covered above; calling it out as a concrete regression to test.
- **Per-kind layout.** The modal content wrapper is `overflow-y-auto p-6` (`FilePreviewModal.tsx:584`), right for markdown but wrong for iframe/Monaco, which need full-height, unpadded containers. `FileContentView` must own per-kind scroll/padding so HTML/SVG/code don't inherit markdown's padding.
- **Non-workspace artifacts** (`/persist` present throwaways since docs/217, or any absolute path) aren't addressable by the file-review endpoints, which resolve against `/workspace` — gated out by `isRepoReviewablePath`; render read-only.
- **Monaco in the carousel** — mounts only in source/code mode; keep the per-entry `key` so it disposes/recreates on navigation and viewMode toggle (matches the modal lifecycle).
- **Present markdown visual shift** — frontmatter is now stripped into a header; intended, flag for visual review.
- **`SendCommentsPayload` import graph** — keep it exported from `FilePreviewModal` (or move to a shared types module and re-export) so `DiffPanel.tsx` / `App.tsx` imports don't break.

## Verification

- `npm run typecheck` — adapter wiring + prop changes.
- `npm run lint:dev` — moved Monaco/`useEffect` code keeps its `eslint-disable` comments.
- Co-located unit tests only (NOT full `npm test` — it OOMs the container):
  `npx vitest run src/client/utils/file-content-kind.test.ts src/client/components/FileContentView src/client/hooks/use-file-review-controls.test.ts src/client/components/FilePreviewModal.test.tsx src/client/components/PresentPane.test.tsx`
- Browser verify: open `.html` + `.svg` from the tree → renders by default, Source toggle shows Monaco; open a markdown doc → frontmatter header + add a selection comment + Send. In Present: push a workspace-relative HTML artifact → toggle source, add a line comment, Send; push a `/persist` (non-workspace) artifact → confirm read-only, no review footer. Download: confirm the dialog's existing server-backed download and Present's Blob download both still work (esp. a binary/too-large file in the dialog downloads correct raw bytes, not the placeholder preview string).
