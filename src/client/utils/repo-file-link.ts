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
  /** Repo-root-relative path with any `./` prefix and line suffix stripped. */
  path: string;
  /** 1-based line number parsed from a `:line` or `#Lline` suffix, if present. */
  line?: number;
}

/** scheme://… — always external (http, https, ftp, ssh, vscode, …). */
const SCHEME_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\//i;
/** mailto:/tel: — schemes without an authority that are still external. */
const MAILTO_TEL = /^(?:mailto|tel):/i;
/** Trailing `:line` or `:line:col` suffix on the path part. */
const LINE_SUFFIX = /:(\d+)(?::\d+)?$/;
/** `#L12` / `#12` fragment used by GitHub-style line anchors. */
const HASH_LINE = /^L?(\d+)$/;

/**
 * Classify a markdown link href. Returns the parsed repo-file reference when
 * the href looks like a relative path into the repository, or `null` when it is
 * an external URL or in-page anchor that should be left alone.
 */
export function parseRepoFileLink(href: string | undefined | null): RepoFileLink | null {
  if (!href) return null;

  // In-page anchors and external links are not repo files.
  if (href.startsWith("#")) return null;
  if (href.startsWith("//")) return null;
  if (SCHEME_AUTHORITY.test(href)) return null;
  if (MAILTO_TEL.test(href)) return null;

  let path = href;
  let line: number | undefined;

  // Fragment line anchor (#L12 / #12). Anything else after `#` is dropped.
  const hashIdx = path.indexOf("#");
  if (hashIdx !== -1) {
    const frag = path.slice(hashIdx + 1);
    const m = HASH_LINE.exec(frag);
    if (m) line = Number.parseInt(m[1], 10);
    path = path.slice(0, hashIdx);
  }

  // Trailing :line (and optional :col). Note `filename.ext:12` is intentionally
  // NOT treated as a URL scheme — only `scheme://` and mailto/tel are external.
  const lineMatch = LINE_SUFFIX.exec(path);
  if (lineMatch) {
    line ??= Number.parseInt(lineMatch[1], 10);
    path = path.slice(0, lineMatch.index);
  }

  // Normalise a leading `./`.
  path = path.replace(/^\.\//, "");

  if (!path) return null;

  return line === undefined ? { path } : { path, line };
}
