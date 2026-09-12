/**
 * Repo file-link detection for markdown surfaces (chat, docs, PR bodies).
 *
 * The agent routinely references repository files in prose using the
 * `path/to/file.ts:line` convention (see CLAUDE.md). When such a reference is
 * written as a markdown link `[label](src/foo.ts:12)`, react-markdown renders a
 * plain `<a href="src/foo.ts:12">`. With `target="_blank"` that href resolves
 * against the current page (`/sessions/<id>/...`) and 404s — the "session link
 * that doesn't work". Instead we detect these relative paths and route the
 * click into the in-app file preview modal.
 *
 * Genuine external links (`https://`, `mailto:`, protocol-relative `//host`)
 * and in-page anchors (`#section`) are left untouched so they keep opening in a
 * new tab / scrolling as before.
 */

export interface RepoFileLink {

  path: string;

  line?: number;
}

const SCHEME_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\//i;

const MAILTO_TEL = /^(?:mailto|tel):/i;

const LINE_SUFFIX = /:(\d+)(?::\d+)?$/;

const HASH_LINE = /^L?(\d+)$/;

export function parseRepoFileLink(href: string | undefined | null): RepoFileLink | null {
  if (!href) return null;

  if (href.startsWith("#")) return null;
  if (href.startsWith("//")) return null;
  if (SCHEME_AUTHORITY.test(href)) return null;
  if (MAILTO_TEL.test(href)) return null;

  let path = href;
  let line: number | undefined;

  const hashIdx = path.indexOf("#");
  if (hashIdx !== -1) {
    const frag = path.slice(hashIdx + 1);
    const m = HASH_LINE.exec(frag);
    if (m) line = Number.parseInt(m[1], 10);
    path = path.slice(0, hashIdx);
  }

  // Trailing :line (and optional :col). Note `filename.ext:12` is intentionally

  const lineMatch = LINE_SUFFIX.exec(path);
  if (lineMatch) {
    line ??= Number.parseInt(lineMatch[1], 10);
    path = path.slice(0, lineMatch.index);
  }

  path = path.replace(/^\.\//, "");

  if (!path) return null;

  return line === undefined ? { path } : { path, line };
}
