/**
 * Agent-authored links into the Preview and the Present tab (docs/258).
 *
 * The agent writes an ordinary markdown link whose address is one of two ShipIt
 * schemes, and clicking it opens a place in the user's own app or in a presented
 * artifact:
 *
 * ```markdown
 * [requirement 7](shipit-preview://web/requirements/7?highlight=7)
 * [REQ-7](shipit-present:/persist/requirements.html#req-7)
 * ```
 *
 * **This parser is a gate, not a formatter.** The href is agent-authored and
 * becomes an iframe `src` and, for a presented artifact, data injected into a
 * document ShipIt assembles. So every rule below **rejects** rather than repairs:
 * `sanitizePreviewPath` truncates an overlong value, which is right for a path a
 * page *reported about itself* and wrong for a destination someone authored — a
 * truncated destination is a different destination.
 *
 * Three outcomes, and the difference between the last two is load-bearing:
 *
 * - `null` — not a ShipIt link at all. The caller falls through to its other
 *   link branches (tracker URLs, repo files, plain external links).
 * - `{ kind: "invalid" }` — the scheme matched but the rest did not. Req 10 says
 *   an unopenable pointer stays clickable and explains itself, so this still
 *   renders as a pointer and toasts `reason` on click. Degrading to plain text
 *   would misreport the agent's deliberate pointer as a rendering decision.
 * - a parsed link — openable.
 *
 * The schemes are **not** live everywhere markdown renders: see the opt-in
 * renderer capability in `message-markdown.tsx`. Enabling them for PR comments or
 * issue bodies would let repository-authored text present a button that starts a
 * Compose service.
 */

/** `shipit-preview://<service>/<path>` — the authority is a Compose service name. */
export const PREVIEW_LINK_SCHEME = "shipit-preview:";
/** `shipit-present:<file path>#<fragment>` — the path identifies a presented artifact. */
export const PRESENT_LINK_SCHEME = "shipit-present:";

/**
 * The reserved query parameter by which the agent picks the rendered form
 * (req 1). The `shipit-` prefix is what makes "strip ShipIt's own parameters
 * before the page sees them" a rule rather than a special case.
 */
export const RENDER_PARAM = "shipit-render";

/** How a pointer renders in chat (req 1). Presentation only — all three click alike. */
export type ShipitLinkRender = "link" | "badge" | "button";

const RENDER_FORMS: readonly ShipitLinkRender[] = ["link", "badge", "button"];

/**
 * Cap on the whole href. Long enough that no real destination is clipped, short
 * enough that a pathological pointer never reaches an iframe `src`.
 */
const MAX_HREF_LENGTH = 2048;
/** Compose service names are short identifiers; this is far above any real one. */
const MAX_SERVICE_LENGTH = 63;
/** Cap on a Present artifact's file path. */
const MAX_FILE_PATH_LENGTH = 1024;
/** Cap on a fragment — an element id or a heading slug. */
const MAX_FRAGMENT_LENGTH = 256;

/**
 * Docker Compose service names. Deliberately excludes `@` and `:`, so a pointer
 * can carry neither credentials nor a port in the authority — req 8 says a port
 * is never part of the address, so one appearing there is a malformed pointer,
 * not a port to honour.
 */
const SERVICE_NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Characters that make a URL parse differently from how it reads. WHATWG parsing
 * folds `\` into `/` and strips tab/CR/LF *anywhere* in the input, so
 * `/\evil.example/x` resolves to a foreign host while passing a naive "starts
 * with a single slash" test. Rejected before any URL resolution rather than
 * after — the same trap `sanitizePreviewPath` documents.
 */
const UNSAFE_URL_CHARS_RE = /[\\\t\n\r]/;

/** A pointer whose scheme matched but which cannot be opened (req 10). */
export interface InvalidShipitLink {
  kind: "invalid";
  /** Why, phrased for a toast — always names the thing that was wrong. */
  reason: string;
  render: ShipitLinkRender;
}

/** A resolved Preview destination (req 2, req 8). */
export interface PreviewShipitLink {
  kind: "preview";
  /** The Compose service name, verbatim from the href. Matched exactly. */
  service: string;
  /**
   * Absolute path with query string and fragment, ready to append to the
   * preview origin. Starts with exactly one `/`. `shipit-render` is already
   * stripped, so a page never sees ShipIt's presentation knob in
   * `location.search` (req 11 — the page reads its own URL).
   */
  target: string;
  render: ShipitLinkRender;
}

/** A resolved Present destination (req 3, req 9). */
export interface PresentShipitLink {
  kind: "present";
  /** Percent-decoded, with a leading `./` removed. Compared to `Presentation.filePath`. */
  filePath: string;
  /** Without its leading `#`, percent-decoded once. Absent addresses the artifact as a whole (req 5). */
  fragment?: string;
  render: ShipitLinkRender;
}

export type ShipitLink = PreviewShipitLink | PresentShipitLink | InvalidShipitLink;

/**
 * Whether an href uses one of the ShipIt link schemes — the cheap test used by
 * the scheme-enabled `urlTransform`, which must pass these through rather than
 * let react-markdown's sanitiser strip an unknown scheme to `""`.
 *
 * Scheme matching is case-insensitive because URL schemes are, and an agent
 * writing `Shipit-Present:` means the same thing. Everything *after* the scheme
 * is treated as case-sensitive — see `parseShipitLink`.
 */
export function isShipitLinkHref(href: string | undefined): boolean {
  if (!href) return false;
  const lower = href.toLowerCase();
  return lower.startsWith(PREVIEW_LINK_SCHEME) || lower.startsWith(PRESENT_LINK_SCHEME);
}

/** Percent-decode one component, or `null` when the encoding is malformed. */
function decodeOnce(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** Decode a query key/value the way form encoding works (`+` is a space). */
function decodeQueryPart(raw: string): string | null {
  return decodeOnce(raw.replace(/\+/g, " "));
}

interface QuerySplit {
  /** The query string without its `?`, with every `shipit-render` segment removed. */
  rest: string;
  render: ShipitLinkRender;
}

/**
 * Pull `shipit-render` out of a raw query string and hand back what remains.
 *
 * Done **textually**, not through `URLSearchParams`, so the page receives the
 * author's query byte-for-byte: round-tripping through `URLSearchParams` would
 * re-encode it (`%7E` → `~`, space → `+`) and quietly hand the page a different
 * string than the agent wrote.
 *
 * A repeated `shipit-render` is a malformed pointer rather than last-wins:
 * ordinary query keys belong to the page and last-wins matches how
 * `URLSearchParams` iterates, but this one is ShipIt's own and ambiguity there
 * is a bug in whoever authored the link.
 */
function extractRenderParam(query: string): QuerySplit | { error: string } {
  if (query === "") return { rest: "", render: "link" };
  const kept: string[] = [];
  const found: string[] = [];
  for (const segment of query.split("&")) {
    const eq = segment.indexOf("=");
    const rawKey = eq < 0 ? segment : segment.slice(0, eq);
    // An undecodable key can't be ours; leave it for the page verbatim.
    if (decodeQueryPart(rawKey) !== RENDER_PARAM) {
      kept.push(segment);
      continue;
    }
    found.push(eq < 0 ? "" : segment.slice(eq + 1));
  }
  if (found.length > 1) return { error: `the address repeats ${RENDER_PARAM}` };
  if (found.length === 0) return { rest: kept.join("&"), render: "link" };

  const value = decodeQueryPart(found[0]);
  if (value === null || !RENDER_FORMS.includes(value as ShipitLinkRender)) {
    return { error: `${RENDER_PARAM} must be one of ${RENDER_FORMS.join(", ")}` };
  }
  return { rest: kept.join("&"), render: value as ShipitLinkRender };
}

/**
 * Split a raw URL remainder into its path, query and fragment parts, splitting
 * on the FIRST `?` and the FIRST `#` the way a URL parser does. A file path
 * containing either character therefore cannot be addressed — accepted, and
 * stated in the agent-facing docs.
 */
function splitParts(raw: string): { path: string; query: string; fragment: string } {
  const hashAt = raw.indexOf("#");
  const beforeHash = hashAt < 0 ? raw : raw.slice(0, hashAt);
  const fragment = hashAt < 0 ? "" : raw.slice(hashAt + 1);
  const queryAt = beforeHash.indexOf("?");
  return {
    path: queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt),
    query: queryAt < 0 ? "" : beforeHash.slice(queryAt + 1),
    fragment,
  };
}

function invalid(reason: string, render: ShipitLinkRender = "link"): InvalidShipitLink {
  return { kind: "invalid", reason, render };
}

/**
 * Parse an agent-authored ShipIt link. Returns `null` when the href uses neither
 * scheme, so callers can fall through to their other link branches.
 *
 * The **service authority is read from the raw href, never `URL.hostname`** —
 * that lowercases and canonicalises, which would quietly conflict with "exact
 * declared service name" for any Compose service whose name has uppercase in it.
 */
export function parseShipitLink(href: string | undefined): ShipitLink | null {
  if (!isShipitLinkHref(href) || href === undefined) return null;

  if (href.length > MAX_HREF_LENGTH) return invalid("the address is too long");
  if (UNSAFE_URL_CHARS_RE.test(href)) return invalid("the address is not valid");

  const lower = href.toLowerCase();
  return lower.startsWith(PREVIEW_LINK_SCHEME)
    ? parsePreview(href.slice(PREVIEW_LINK_SCHEME.length))
    : parsePresent(href.slice(PRESENT_LINK_SCHEME.length));
}

/** Parse everything after `shipit-preview:` — expected to be `//<service>/<path>`. */
function parsePreview(rest: string): ShipitLink {
  if (!rest.startsWith("//")) {
    return invalid("a preview address needs a service name, as shipit-preview://<service>/<path>");
  }
  const afterAuthority = rest.slice(2);

  // The authority runs to the first path/query/fragment delimiter. Read from
  // the raw string so the service name keeps its original case.
  const end = afterAuthority.search(/[/?#]/);
  const service = end < 0 ? afterAuthority : afterAuthority.slice(0, end);
  const remainder = end < 0 ? "" : afterAuthority.slice(end);
  const { path, query, fragment } = splitParts(remainder);

  // The render form is read FIRST, so that everything below can report its
  // failure in the form the agent asked for. A pointer that can't be opened
  // still renders (req 10), and it should render as the badge or button the
  // author wrote — not silently demote itself to an inline link.
  const split = extractRenderParam(query);
  if ("error" in split) return invalid(split.error);
  const { render } = split;

  if (service === "") return invalid("the address names no service", render);
  if (service.length > MAX_SERVICE_LENGTH) return invalid("the service name is too long", render);
  if (!SERVICE_NAME_RE.test(service)) {
    // `user@host` and `host:3000` both land here: req 8 says the address carries
    // a service name and never a port, so either is a malformed pointer.
    return invalid(`"${service}" is not a valid service name`, render);
  }

  // A pointer with no path addresses the app as a whole, which req 5 permits.
  const normalizedPath = path === "" ? "/" : path;
  if (!normalizedPath.startsWith("/") || normalizedPath.startsWith("//")) {
    return invalid("a preview path must begin with a single /", render);
  }

  const target =
    normalizedPath +
    (split.rest === "" ? "" : `?${split.rest}`) +
    (fragment === "" ? "" : `#${fragment}`);

  return { kind: "preview", service, target, render };
}

/** Parse everything after `shipit-present:` — a presented artifact's file path. */
function parsePresent(rest: string): ShipitLink {
  const { path, query, fragment } = splitParts(rest);

  const split = extractRenderParam(query);
  if ("error" in split) return invalid(split.error);
  const { render } = split;

  if (path === "") return invalid("the address names no file", render);
  if (path.length > MAX_FILE_PATH_LENGTH) return invalid("the file path is too long", render);

  const decodedPath = decodeOnce(path);
  if (decodedPath === null) return invalid("the file path is not valid", render);
  // `./x.md` and `x.md` name the same artifact; the Present store holds one form.
  const filePath = decodedPath.startsWith("./") ? decodedPath.slice(2) : decodedPath;
  if (filePath === "") return invalid("the address names no file", render);

  if (fragment === "") return { kind: "present", filePath, render };

  if (fragment.length > MAX_FRAGMENT_LENGTH) return invalid("the fragment is too long", render);
  const decodedFragment = decodeOnce(fragment);
  if (decodedFragment === null) return invalid("the fragment is not valid", render);

  return { kind: "present", filePath, fragment: decodedFragment, render };
}

/**
 * Slug a heading the way a Present markdown fragment addresses it.
 *
 * **This is a contract, not an implementation detail** — the agent has to author
 * fragments that match it, so it is documented agent-facing and tested here.
 * Take the heading's rendered text (so inline code and emphasis contribute their
 * text), lowercase, strip anything that is not alphanumeric / space / hyphen,
 * collapse whitespace runs to single hyphens, trim leading and trailing hyphens.
 *
 * No de-duplication suffixes: **duplicate headings resolve to the first match**.
 * Stated in the docs rather than left to be discovered.
 */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
}
