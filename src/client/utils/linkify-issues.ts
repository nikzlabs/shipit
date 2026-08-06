/**
 * `remarkLinkifyIssues` — turn bare issue references in prose into in-app badges.
 *
 * The agent (and humans) routinely mention issues inline as a bare reference —
 * "tracked in TRACKER-43", "blocked on roadmap#SHI-79", "see planning#57". A full
 * issue *URL* is already intercepted by `parseTrackerIssueLink` → opens the
 * in-app Issues viewer; a bare reference stayed plain text because no absolute
 * URL is derivable from it. But the in-app viewer doesn't need a URL — the
 * reference alone resolves to a destination + a tracker-native lookup id. So this
 * plugin closes the gap the same way `remarkLinkifyPaths` does for file paths:
 * it walks the mdast, finds reference-shaped tokens, and wraps each in a `link`
 * node with a sentinel `shipit-issue:TOKEN` url. From there the `a` →
 * `MarkdownLink` pipeline renders an `IssueBadge` (not an anchor) that opens the
 * issue inline.
 *
 * Design notes:
 * - **The gate lives at render, not here.** A reference-shaped token collides
 *   with everyday strings (`UTF-8`, `GPT-4`, `COVID-19`, `PR#3`), so matching
 *   alone can't decide what's an issue. This plugin is deliberately liberal; the
 *   badge renderer resolves the token against the repository's *declared*
 *   trackers (docs/248 req 11) and renders the raw text for anything undeclared
 *   or ambiguous. Keeping the gate at render is what lets the parse stay pure +
 *   memoized on `text` while the declared-tracker state lives in a store.
 * - **That split matters MORE since the name form landed** (docs/248 req 10, and
 *   SHI-323 which added it here). `<name>#<id>` is a far more collision-prone
 *   shape than an uppercase key — `PR#3`, `issue#5`, `channel#2` all match — so
 *   the render-time resolver is the only thing standing between ordinary prose
 *   and a badge. A token that doesn't resolve must degrade to *exactly* its
 *   original text.
 * - **Whole token, not half of one.** The name form is matched first, so
 *   `roadmap#SHI-319` produces one `shipit-issue:roadmap#SHI-319` link covering
 *   the whole reference. Matching only the bare-key tail would badge `SHI-319`
 *   and leave `roadmap#` outside the pill as stray text (the SHI-323 defect).
 * - **Uppercase only for the bare-key form.** Real Linear keys are uppercase;
 *   restricting to uppercase drops a whole class of lowercase prose false
 *   positives before the gate. The name form has no such luxury — `planning#57`
 *   is all-lowercase by construction — which is why its gate is the resolver.
 * - **Runs after `remark-gfm` and `remarkLinkifyPaths`.** We never descend into
 *   existing `link` nodes, so a `TRACKER-43` inside a
 *   `linear.app/.../issue/TRACKER-43` URL (already an autolinked `link`) is left
 *   alone — that URL is handled by
 *   the tracker-URL branch instead.
 * - **Text *and inline code*.** A reference is wrapped whether it sits in prose
 *   or in a backtick span, mirroring the path plugin. Fenced `code` blocks stay
 *   verbatim (they're leaf nodes we never match).
 */

import type { InlineCode, Link, Root, RootContent, Text } from "mdast";

/** Sentinel href scheme carrying the reference token through to `MarkdownLink`. */
export const ISSUE_LINK_SCHEME = "shipit-issue:";

/**
 * A reference-shaped token, in the two forms that appear in prose (docs/248
 * req 10). The alternation is ordered, and the order is load-bearing:
 *
 * 1. **Name form** — `roadmap#SHI-304`, `planning#57`. The name and id shapes
 *    mirror `NAMED_REF_RE` in `shared/issue-ref.ts`, which is what ultimately
 *    parses the token; keeping them in step means anything we badge is something
 *    the resolver can read. The lookbehind additionally rejects a leading `/` so
 *    a GitHub short form (`owner/repo#42`) isn't half-matched as `repo#42`.
 * 2. **Bare key** — `SHI-304`. Unchanged from before the name form existed,
 *    including its lookbehind, which deliberately permits a leading `#` so
 *    `issue #SHI-3` still badges.
 *
 * Matching the name form first is what makes a badge cover the whole reference
 * rather than its trailing key. Neither branch decides anything: the resolver at
 * render time does (see the module docstring).
 */
const ISSUE_TOKEN_RE =
  /(?<![\w#/-])[A-Za-z0-9][A-Za-z0-9._-]*#(?:[A-Za-z][A-Za-z0-9]*-\d+|\d+)(?![\w-])|(?<![\w-])[A-Z][A-Z0-9]*-\d+(?![\w-])/g;

/** Keep the leaf type of the node a match came from so an inline-code key stays monospace. */
function leaf(value: string, code: boolean): Text | InlineCode {
  return code ? { type: "inlineCode", value } : { type: "text", value };
}

/**
 * Split one node's string value into alternating leaf / `link` nodes on each
 * reference match. Returns `null` when nothing matched so callers leave the
 * original node untouched.
 */
function linkifyValue(value: string, code: boolean): (Text | InlineCode | Link)[] | null {
  ISSUE_TOKEN_RE.lastIndex = 0;
  const out: (Text | InlineCode | Link)[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = ISSUE_TOKEN_RE.exec(value)) !== null) {
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
 * In-place walk: replace reference-bearing `text` and `inlineCode` nodes, never
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
