---
issue: https://linear.app/shipit-ai/issue/SHI-124
description: Repository file references — explicit markdown links and bare paths in prose (e.g. issue bodies) — open the in-app file preview modal with line jumping, instead of navigating to a broken session URL.
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
- **Bare paths in prose are auto-linked too.** A plain-text reference like
  `docs/155-foo/plan.md` or `src/server/git.ts:42` — common in tracker issue
  bodies and comments ("Design doc: docs/…/plan.md") — is turned into the same
  in-app preview link without the author having to write markdown link syntax.
  This applies on every markdown surface (chat, docs, PR bodies, issue
  descriptions + comments).

- **Paths inside inline-code spans are linked too.** A backtick-wrapped path —
  `` `docs/172-foo/plan.md` ``, the *most common* way paths appear in prose — is
  linkified just like a bare one. The link's child is wrapped back in an
  `inlineCode` node, so it stays monospace, just clickable. Excluding inline code
  (the original behaviour) made the feature look broken on the dominant case, so
  it was reversed. **Fenced** code blocks stay verbatim — a fenced block is
  literal code/output, not a reference.

A bare path is only linked when it has at least one `dir/` segment and a
letter-led file extension, so everyday prose (`and/or`, `TCP/IP`, `1.2.3`, a
root-level `package.json` with no directory) is left alone, and fenced code
blocks and existing links are never touched.

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
4. `remarkLinkifyPaths` (`src/client/utils/linkify-paths.ts`) is a remark plugin
   added to the shared `remarkPlugins` chain in `message-markdown.tsx`, **after**
   `remark-gfm`. It walks the mdast, and for each plain `text` node splits out
   substrings matching the repo-path regex into `link` nodes whose `url` is the
   raw path. It never descends into existing `link` nodes (so GFM-autolinked URLs
   and explicit markdown links are untouched). It processes both `text` and
   `inlineCode` nodes (a matched `inlineCode` keeps its monospace by wrapping the
   link child in `inlineCode`); fenced `code` blocks are a different leaf node it
   never matches, so they stay verbatim. Those synthesized links then flow through the
   exact same `MarkdownLink` → `parseRepoFileLink` → `openPreview` path as
   step 2, so no click-handling code changed. No new dependency — the walk is a
   ~30-line manual recursion rather than `unist-util-visit`.

## Key files

- `src/client/utils/repo-file-link.ts` — `parseRepoFileLink` (+ test).
- `src/client/utils/linkify-paths.ts` — `remarkLinkifyPaths`, the bare-path
  auto-link remark plugin (+ test).
- `src/client/components/message-markdown.tsx` — `MarkdownLink`, the
  `components.a` override, and the `remarkPlugins` chain (+ test).
- `src/client/stores/file-store.ts` — `previewLine` state, `openPreview` `line` opt.
- `src/client/App.tsx` — passes `line={previewLine}` to the modal.
- `src/client/components/FilePreviewModal.tsx` — `line` prop → `CodeEditor.revealLine`.
- `src/client/index.css` — `.shipit-preview-line-highlight`.

## Verification

- `npx vitest run src/client/utils/repo-file-link.test.ts src/client/utils/linkify-paths.test.ts src/client/components/message-markdown.test.tsx`
- In the app: have the agent reference a file as a markdown link with a `:line`
  suffix, click it, confirm the preview modal opens at the highlighted line.
- Open a tracker issue whose body mentions a bare path like
  `docs/172-file-links-open-preview/plan.md`; confirm the path renders as a link
  and clicking it opens the in-app preview.
- Click an external link in a PR comment, confirm it still opens in a new tab.
