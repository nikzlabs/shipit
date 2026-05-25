---
status: planned
priority: medium
description: Evaluate replacing marked + dangerouslySetInnerHTML with react-markdown to fix selection loss during streaming and improve docs-viewer rendering.
---

# react-markdown migration

## Why this exists

Two recurring user-visible problems point at the same root cause — we render markdown by turning a string into an HTML string and then injecting it via `dangerouslySetInnerHTML`:

1. **Selection collapses on every streaming token in chat.** Each new chunk re-runs `marked.parse()` and writes a fresh HTML string into the same `<div dangerouslySetInnerHTML>`. The browser replaces the subtree, the Selection Range loses its anchor nodes, and the user's drag-to-select disappears. The current mitigation is a freeze hack in `MessageList` (snapshot the messages array while the user has an active selection, see [[selection-persistence]]). It works but it's a workaround, not a fix.
2. **Docs viewer rendering looks rough.** The docs modal uses raw `marked.parse()` with no custom renderer — so docs code blocks have no syntax highlighting, no copy button, and no consistent styling with chat code blocks; links don't open in new tabs; headings aren't anchored; task lists, tables, and other GFM features inherit only the Tailwind `prose` defaults.

Both problems are structurally tied to the renderer choice. This doc evaluates whether replacing `marked` with `react-markdown` is the right move and, if so, how to stage it.

## Current state

ShipIt renders markdown in five distinct surfaces, all sharing the same pipeline:

| Surface | Renderer | Highlighting | Notes |
|---|---|---|---|
| Chat assistant messages | `MarkdownContent` (`message-markdown.tsx:89`) | highlight.js via `chatMarked` + React `CodeBlock` | Custom link renderer (target=_blank). Streaming. |
| PR description & comments | `MarkdownContent` | Same as chat | Static after fetch. |
| PR lifecycle card body | `MarkdownContent` | Same as chat | Mostly short text. |
| Plan approval modal | `MarkdownContent` | Same as chat | Static. |
| Docs viewer (FilePreviewModal) | `MarkdownSelectionComments` → raw `marked.parse()` | **None** | Splits HTML into top-level blocks for inline comment anchoring. |

Shared infrastructure:
- `marked@17.0.2` — string-to-HTML parser (in `dependencies`, ships to client).
- `highlight.js@11.11.1` — syntax highlighter (in `dependencies`, ships to client).
- `@tailwindcss/typography@0.5.19` — `prose` utility classes.
- All five surfaces wrap output in `<div className="prose dark:prose-invert prose-sm max-w-none" dangerouslySetInnerHTML={{__html}} />`.

Two non-obvious complications:
- **`MarkdownSelectionComments` walks the rendered DOM** to compute character offsets for selection-anchored review comments (`offsetWithin()` at `MarkdownSelectionComments.tsx:105`). It depends on splitting `marked`'s HTML output into top-level blocks via DOMParser (`parseMarkdownToBlocks()` at line 48). Any migration must preserve a way to associate a comment's quoted text with a block-level chunk of rendered content.
- **`MarkdownBlock` already has a memo hack** (line 39) explicitly to dodge a prior selection-collapse bug in the docs viewer — same root cause as the chat freeze. The comment in that file is worth reading; it's the same pattern.

## Proposal

Replace `marked` with `react-markdown` across all five surfaces. Use:

- `react-markdown@10.1.0` — parses markdown into a React element tree (no HTML string, no `dangerouslySetInnerHTML` in our code).
- `remark-gfm@4.0.1` — GFM tables, task lists, autolinks, strikethrough.
- `rehype-highlight@7.0.2` *or* keep our existing React `CodeBlock` via `components.code` override (recommended — preserves the copy button).
- `rehype-slug@6.0.0` (optional) — heading anchors for docs viewer.
- `rehype-autolink-headings@7.1.0` (optional) — clickable anchor links on docs headings.

Per-element styling moves from "post-render CSS via `prose`" to "explicit `components` overrides on each element," giving us pixel-level control consistent with the design system.

## Pros

- **Selection survives streaming natively.** With a React tree, an extra token appended to a paragraph diffs into `nodeValue` updates on existing text nodes; the DOM nodes the Selection Range anchors to aren't replaced. We delete the `MessageList` freeze (~30 lines, see [[selection-persistence]]) and the `MarkdownBlock` memo workaround.
- **Docs viewer styling closes the gap with chat.** Same code-block component, same link rules, same heading sizes, same checkbox rendering — all enforced in one place via `components`. No more "raw `marked` vs `chatMarked`" divergence between docs and chat.
- **Interactive markdown becomes cheap.** Want clickable checkboxes that toggle task list items in docs? Want copy buttons on every code block? Want collapsible headings? These become `components.li` / `components.h2` overrides instead of post-render DOM manipulation.
- **No `dangerouslySetInnerHTML` in our code.** Reduces the XSS attack surface to zero on the rendering side. (Both `marked` and `react-markdown` sanitize by default, but eliminating the `dangerouslySetInnerHTML` call site is a defense-in-depth win.)
- **Cleaner selection-anchored comments.** `react-markdown`'s `components` API lets us attach refs to the wrapper of each top-level block as it renders, removing the DOMParser pre-pass in `parseMarkdownToBlocks()` and the manual `outerHTML` string handling.
- **First-class TypeScript types** for component overrides — `marked`'s custom-renderer API is stringly-typed.

## Cons

- **Bundle size.** Conservative estimate of incremental gzipped client bundle:
  - `marked` (current): ~12 KB gzipped.
  - `react-markdown` + `remark-parse` + `remark-gfm` + `mdast-util-*` + `hast-util-*` + `unified`: **~40–55 KB gzipped**.
  - Net: ~30–40 KB increase. Not catastrophic, but real, and it lands on every page load.
- **Migration touches every markdown surface and their tests.** Five components plus `MessageList.test.tsx` and `MarkdownSelectionComments.test.tsx`. The chat surface is straightforward; the docs viewer is the hard one because of selection-anchored comments.
- **Streaming parse cost is per-token, same as today.** Both `marked` and `react-markdown` parse the entire message text on each chunk. No regression, but no win either — the freeze hack went away because reconciliation handles updates well, not because parsing got faster.
- **`react-markdown` ecosystem is unified/remark/rehype.** The plugin model is unfamiliar to anyone who hasn't worked with it. Easy to learn but adds a concept count compared to "marked + a custom renderer object."
- **`prose` styling no longer "just works."** We're trading `prose-sm` defaults for explicit overrides. That's a feature (control) but also a cost (we write the styles). For surfaces that look fine today (PR description, plan approval), this is busywork.
- **Selection-comment anchoring needs rework.** Today's flow is: `marked.parse() → string → DOMParser → iterate children → outerHTML per block → dangerouslySetInnerHTML per block → ref the wrapper → walk text nodes`. With `react-markdown` we'd need to either (a) intercept block-level mdast nodes via a remark plugin and split the tree, or (b) attach refs to each block via `components` overrides and walk the live DOM. (b) is simpler.

## Alternatives considered

**Alternative A — Stay with `marked`, fix issues piecewise.**
- Drop the chat freeze hack and accept selection collapse during streaming. *Bad: this is the original bug.*
- Replace `MessageList` freeze with manual selection save/restore (capture anchor/focus offsets, restore after render). *Possible but brittle; the saved offsets become invalid if segment boundaries shift, e.g. when a fenced code block opens mid-stream.*
- Apply `chatMarked` (with custom link + code renderers) to the docs viewer. *Easy win for docs styling — doesn't require migration. Worth doing regardless.*
- Add Tailwind `prose` overrides for docs headings, tables, task lists. *Easy, no migration cost.*

**Alternative B — Migrate only the docs viewer.**
- Removes the styling complaint, leaves chat selection unchanged. *Mixed bundle: ships both renderers. Not recommended.*

**Alternative C — Migrate only chat.**
- Fixes selection loss, removes the freeze hack, leaves docs viewer styling broken. *Smaller blast radius. Useful as Phase 1 of the full migration.*

**Alternative D — Different renderer entirely (`markdown-to-jsx`, `@uiw/react-md-editor`, etc.).**
- `markdown-to-jsx` is smaller (~6 KB gzipped) and also produces a React tree. Worth considering as a lighter-weight alternative to `react-markdown` if bundle size is the dominant concern. Trade-off: smaller plugin ecosystem, less battle-tested with GFM edge cases.

## Recommendation

**Migrate, in three phases. Phase 1 is a low-risk, high-value start.**

1. **Phase 1 — Chat.** Migrate `MarkdownContent` and `MarkdownTooltip` to `react-markdown` + `remark-gfm`. Keep our existing React `CodeBlock` via `components.code` override (so we don't lose the copy button). Custom link rule becomes `components.a`. Delete the `MessageList` freeze hack and its tests; add a streaming-selection-survives test. Validate bundle size impact in CI.
2. **Phase 2 — Docs viewer.** Migrate `MarkdownSelectionComments`. Replace `parseMarkdownToBlocks` (DOMParser → outerHTML) with `components` overrides that ref each block-level wrapper. Walk-text-nodes-for-offset stays the same. Apply heading anchor plugins. Adopt the chat code-block component for consistency.
3. **Phase 3 — Remaining surfaces.** PR description, PR lifecycle card, plan approval. Mechanical now that `MarkdownContent` is `react-markdown`-based — they already consume it.

If Phase 1's bundle-size impact lands above ~40 KB gzipped, reconsider with `markdown-to-jsx` before committing to phases 2 and 3.

## Open questions

- **Should the docs viewer support interactive task list checkboxes?** With `react-markdown`, this is a small `components.input` override. Would mean editing the underlying `.md` file on toggle (or just visual state). Likely a follow-up doc, not part of this migration.
- **Heading anchor URLs.** Should anchors update the URL hash (deep linking to a section of a plan)? Implementation is cheap with `rehype-slug` + `rehype-autolink-headings`; UX impact warrants a quick design check.
- **Server-side rendering.** Today `MarkdownSelectionComments` has an SSR fallback (line 51). Is that still needed? If not, we can simplify. Doesn't block the migration either way.
- **Do we want to keep `highlight.js` or switch to `shiki`?** Orthogonal to this migration but related — `shiki` produces better-looking highlights and is becoming the React/Vite standard. Defer to a separate doc.

## Key files

- `src/client/components/message-markdown.tsx` — `MarkdownContent`, `MarkdownTooltip`, `CodeBlock`, `chatMarked`. Primary migration target.
- `src/client/components/MarkdownSelectionComments.tsx` — docs viewer renderer with comment anchoring. Second-phase target.
- `src/client/components/MessageList.tsx` — contains the freeze hack ([[selection-persistence]]) that this migration would remove.
- `src/client/components/FilePreviewModal.tsx` — entry point that mounts `MarkdownSelectionComments`.
- `src/client/components/pr-detail/PrDescriptionSection.tsx`, `pr-detail/PrConversationSection.tsx`, `PrLifecycleCard.tsx`, `PlanApproval.tsx` — third-phase consumers.
- `package.json` — adds `react-markdown`, `remark-gfm`, optionally `rehype-slug` / `rehype-autolink-headings`; possibly removes `marked` once all surfaces migrate.
