/**
 * `remarkLinkifyIssues` — turn bare Linear issue keys in prose into in-app
 * badges.
 *
 * The agent (and humans) routinely mention Linear issues inline as a bare key —
 * "tracked in SHI-43", "blocked on SHI-79". A full Linear *URL* is already
 * intercepted by `parseTrackerIssueLink` → opens the in-app Issues viewer; a
 * bare key stayed plain text because no absolute URL is derivable from it
 * without the workspace slug. But the in-app viewer doesn't need a URL — the
 * key alone is the tracker-native lookup id (`Tracker.getIssue(key)`). So this
 * plugin closes the gap the same way `remarkLinkifyPaths` does for file paths:
 * it walks the mdast, finds key-shaped tokens, and wraps each in a `link` node
 * with a sentinel `shipit-issue:KEY` url. From there the `a` → `MarkdownLink`
 * pipeline renders an `IssueBadge` (not an anchor) that opens the issue inline.
 *
 * Design notes:
 * - **The team-key gate lives at render, not here.** A bare `[A-Z]+-\d+` token
 *   collides with everyday strings (`UTF-8`, `GPT-4`, `COVID-19`), so matching
 *   alone can't decide what's an issue. This plugin is deliberately liberal; the
 *   badge renderer only paints a badge when the token's team prefix matches the
 *   *connected* Linear workspace's bound team key, and otherwise renders the raw
 *   text. Keeping the gate at render is what lets the parse stay pure + memoized
 *   on `text` while the connected-tracker state lives in a store.
 * - **Uppercase only.** Real Linear keys are uppercase; restricting to uppercase
 *   drops a whole class of lowercase prose false positives before the gate.
 * - **Runs after `remark-gfm` and `remarkLinkifyPaths`.** We never descend into
 *   existing `link` nodes, so a `SHI-43` inside a `linear.app/.../issue/SHI-43`
 *   URL (already an autolinked `link`) is left alone — that URL is handled by
 *   the tracker-URL branch instead.
 * - **Text *and inline code*.** A key is wrapped whether it sits in prose or in
 *   a backtick span, mirroring the path plugin. Fenced `code` blocks stay
 *   verbatim (they're leaf nodes we never match).
 */

import type { InlineCode, Link, Root, RootContent, Text } from "mdast";

/** Sentinel href scheme carrying the bare Linear key through to `MarkdownLink`. */
export const ISSUE_LINK_SCHEME = "shipit-issue:";

/**
 * A Linear-key-shaped token: an uppercase team prefix, a dash, and digits. The
 * surrounding `[\w-]` guards keep it from biting mid-token (inside a longer
 * identifier like `X-SHI-43-Y` or a word). The team-key gate at render time is
 * what actually decides this is an issue vs. noise like `GPT-4`.
 */
const ISSUE_KEY_RE = /(?<![\w-])[A-Z][A-Z0-9]*-\d+(?![\w-])/g;

/** Keep the leaf type of the node a match came from so an inline-code key stays monospace. */
function leaf(value: string, code: boolean): Text | InlineCode {
  return code ? { type: "inlineCode", value } : { type: "text", value };
}

/**
 * Split one node's string value into alternating leaf / `link` nodes on each
 * issue-key match. Returns `null` when nothing matched so callers leave the
 * original node untouched.
 */
function linkifyValue(value: string, code: boolean): (Text | InlineCode | Link)[] | null {
  ISSUE_KEY_RE.lastIndex = 0;
  const out: (Text | InlineCode | Link)[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = ISSUE_KEY_RE.exec(value)) !== null) {
    const raw = match[0];
    const start = match.index;
    if (start > lastIndex) {
      out.push(leaf(value.slice(lastIndex, start), code));
    }
    out.push({
      type: "link",
      url: `${ISSUE_LINK_SCHEME}${raw}`,
      title: null,
      children: [leaf(raw, code)],
    });
    lastIndex = start + raw.length;
  }

  if (out.length === 0) return null;
  if (lastIndex < value.length) {
    out.push(leaf(value.slice(lastIndex), code));
  }
  return out;
}

/**
 * In-place walk: replace key-bearing `text` and `inlineCode` nodes, never
 * descend into existing links. Fenced `code` blocks are leaf nodes we don't
 * match here, so they stay verbatim.
 */
function transform(node: { children: RootContent[] }): void {
  const { children } = node;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.type === "link") continue;
    if (child.type === "text" || child.type === "inlineCode") {
      const replaced = linkifyValue(child.value, child.type === "inlineCode");
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
export function remarkLinkifyIssues() {
  return (tree: Root): void => {
    transform(tree);
  };
}
