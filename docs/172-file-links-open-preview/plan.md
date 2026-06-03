---
description: Repository file links in chat and docs open the in-app file preview modal (with line jumping) instead of navigating to a broken session URL.
---

# File links open the preview dialog

## Why this exists

The agent constantly references repository files in prose using the
`path/to/file.ts:line` convention (see `CLAUDE.md`). When such a reference is
written as a markdown link — `[label](src/server/foo.ts:12)` — `react-markdown`
renders a plain `<a href="src/server/foo.ts:12">`. The shared link renderer set
`target="_blank"`, so clicking resolved the *relative* href against the current
page (`/sessions/<id>/...`) and 404'd — the "session link that doesn't work"
the user reported.

Per the product principle "inline beats link-out," a repo file link should open
the file *inside* ShipIt — the same `FilePreviewModal` the file tree and message
attachments already use — not navigate the browser away.

## What it does

- **Repo file links open the preview modal.** A markdown link whose href looks
  like a repo-relative path routes the click into
  `useFileStore.getState().openPreview(sessionId, path, { line })` instead of
  navigating. Works on every markdown surface, since they share one renderer:
  chat messages, the docs viewer, PR descriptions/comments, and tooltips.
- **`path:line` jumps to the line.** A `:line` (or `:line:col`, or GitHub-style
  `#L12`) suffix is parsed out and the code preview reveals + briefly highlights
  that line via Monaco.
- **External links are untouched.** `http(s)://`, `mailto:`/`tel:`,
  protocol-relative `//host`, and in-page `#anchors` keep their previous
  new-tab / scroll behaviour.

Only links the agent already wrote as markdown links are affected — bare file
paths typed as plain text are **not** auto-linked (deliberately out of scope to
avoid false positives).

## How it works

1. `parseRepoFileLink(href)` (`src/client/utils/repo-file-link.ts`) classifies a
   link href: returns `{ path, line? }` for repo paths or `null` for
   external/anchor links. A top-level `filename.ext:12` is treated as a
   file+line, not a URL scheme — only `scheme://` and `mailto:`/`tel:` count as
   external, which is what disambiguates the two.
2. `MarkdownLink` (in `message-markdown.tsx`) is the `components.a` override. For
   a parsed repo link it `preventDefault()`s and calls `openPreview` with the
   current `sessionId`; otherwise it renders the prior `target="_blank"` anchor.
3. `file-store.ts` threads an optional `line` through `openPreview` and stores it
   as `previewLine`. `App.tsx` passes it to `FilePreviewModal`, which forwards it
   to the Monaco `CodeEditor` as `revealLine`. The editor calls
   `revealLineInCenter` + a transient decoration (`.shipit-preview-line-highlight`
   in `index.css`). Line jumping applies to code only — markdown is rendered, not
   source.

## Key files

- `src/client/utils/repo-file-link.ts` — `parseRepoFileLink` (+ test).
- `src/client/components/message-markdown.tsx` — `MarkdownLink` and the
  `components.a` override (+ test).
- `src/client/stores/file-store.ts` — `previewLine` state, `openPreview` `line` opt.
- `src/client/App.tsx` — passes `line={previewLine}` to the modal.
- `src/client/components/FilePreviewModal.tsx` — `line` prop → `CodeEditor.revealLine`.
- `src/client/index.css` — `.shipit-preview-line-highlight`.

## Verification

- `npx vitest run src/client/utils/repo-file-link.test.ts src/client/components/message-markdown.test.tsx`
- In the app: have the agent reference a file as a markdown link with a `:line`
  suffix, click it, confirm the preview modal opens at the highlighted line.
- Click an external link in a PR comment, confirm it still opens in a new tab.
