/**
 * `remarkLinkifyPaths` — auto-link bare repository file references in prose.
 *
 * The agent (and humans) routinely mention repo files inline without markdown
 * link syntax — "Design doc: docs/155-foo/plan.md", "see src/server/git.ts:42".
 * `parseRepoFileLink` already turns an *explicit* `[label](src/foo.ts:42)` link
 * into an in-app file-preview click, but a bare path in prose stayed plain text.
 * This remark plugin closes that gap: it walks the mdast, finds text that looks
 * like a `dir/.../name.ext` path, and wraps each match in a `link` node whose
 * `url` is the raw path. From there the normal `a` → `MarkdownLink` →
 * `parseRepoFileLink` pipeline handles the click identically to an explicit link.
 *
 * Design notes:
 * - **No new dependency.** We do a small manual recursive walk instead of pulling
 *   in `unist-util-visit` (transitive-only here), keeping the strict dependency
 *   policy untouched.
 * - **Runs after `remark-gfm`.** GFM's autolink-literal turns bare URLs into
 *   `link` nodes first; we never descend into existing `link` nodes, so a URL
 *   tail like `example.com/x/y.md` is left alone.
 * - **Text nodes only.** Inline code and fenced code are `inlineCode` / `code`
 *   nodes (no `children`, not `text`), so paths inside backticks are never
 *   linkified — matching the convention that code spans are verbatim.
 * - **Requires a slash + extension.** Demanding at least one `dir/` segment and a
 *   letter-led extension keeps everyday prose ("and/or", "TCP/IP", "1.2.3", a
 *   bare `README`) from being mistaken for a path. A root-level file with no
 *   directory (`package.json`) is intentionally not linked.
 */

import type { Link, Root, RootContent, Text } from "mdast";

/**
 * Matches a relative repo path: an optional `./`, one or more `segment/` parts,
 * a final `name.ext` (extension is letter-led, 1–10 chars — rejects `1.2.3`),
 * and an optional `:line[:col]` or `#L12` / `#12` suffix. The leading lookbehind
 * prevents matching mid-token (inside an email, a longer path, or a word).
 */
const PATH_RE =
  /(?<![\w@./-])(?:\.\/)?(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,9}(?::\d+(?::\d+)?)?(?:#L?\d+)?/g;

/**
 * Split one text node's value into alternating `text` / `link` nodes on each
 * path match. Returns `null` when nothing matched, so callers can leave the
 * original node untouched (and avoid needless array churn).
 */
function linkifyValue(value: string): (Text | Link)[] | null {
  PATH_RE.lastIndex = 0;
  const out: (Text | Link)[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = PATH_RE.exec(value)) !== null) {
    const raw = match[0];
    const start = match.index;
    if (start > lastIndex) {
      out.push({ type: "text", value: value.slice(lastIndex, start) });
    }
    out.push({
      type: "link",
      url: raw,
      title: null,
      children: [{ type: "text", value: raw }],
    });
    lastIndex = start + raw.length;
  }

  if (out.length === 0) return null;
  if (lastIndex < value.length) {
    out.push({ type: "text", value: value.slice(lastIndex) });
  }
  return out;
}

/** In-place walk: replace path-bearing text nodes, never descend into links. */
function transform(node: { children: RootContent[] }): void {
  const { children } = node;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    // Leave existing links (incl. GFM-autolinked URLs) entirely alone.
    if (child.type === "link") continue;
    if (child.type === "text") {
      const replaced = linkifyValue(child.value);
      if (replaced) {
        children.splice(i, 1, ...replaced);
        i += replaced.length - 1;
      }
      continue;
    }
    if ("children" in child && Array.isArray(child.children)) {
      transform(child);
    }
  }
}

/** Remark plugin entry point. */
export function remarkLinkifyPaths() {
  return (tree: Root): void => {
    transform(tree);
  };
}
