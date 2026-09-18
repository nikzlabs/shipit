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

export const PREVIEW_LINK_SCHEME = "shipit-preview:";

export const PRESENT_LINK_SCHEME = "shipit-present:";

export const RENDER_PARAM = "shipit-render";

export type ShipitLinkRender = "link" | "badge" | "button";

const RENDER_FORMS: readonly ShipitLinkRender[] = ["link", "badge", "button"];

/**
 * Cap on the whole href. Long enough that no real destination is clipped, short
 * enough that a pathological pointer never reaches an iframe `src`.
 */
const MAX_HREF_LENGTH = 2048;

const MAX_SERVICE_LENGTH = 63;

const MAX_FILE_PATH_LENGTH = 1024;

const MAX_FRAGMENT_LENGTH = 256;

/**
 * Docker Compose service names. Deliberately excludes `@` and `:`, so a pointer
 * can carry neither credentials nor a port in the authority — req 8 says a port
 * is never part of the address, so one appearing there is a malformed pointer,
 * not a port to honour.
 */
const SERVICE_NAME_RE = /^[A-Za-z0-9._-]+$/;

const UNSAFE_URL_CHARS_RE = /[\\\t\n\r]/;

/** A pointer whose scheme matched but which cannot be opened (req 10). */
export interface InvalidShipitLink {
  kind: "invalid";

  reason: string;
  render: ShipitLinkRender;
}

export interface PreviewShipitLink {
  kind: "preview";

  service: string;
  /**
   * Absolute path with query string and fragment, ready to append to the
   * preview origin. Starts with exactly one `/`. `shipit-render` is already
   * stripped from both, so a page never sees ShipIt's presentation knob in
   * `location.search` or `location.hash` (req 11 — the page reads its own URL).
   */
  target: string;
  render: ShipitLinkRender;
}

export interface PresentShipitLink {
  kind: "present";

  filePath: string;

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

function decodeOnce(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function decodeQueryPart(raw: string): string | null {
  return decodeOnce(raw.replace(/\+/g, " "));
}

interface QuerySplit {

  rest: string;

  found: boolean;
  render: ShipitLinkRender;
}

function extractRenderParam(query: string): QuerySplit | { error: string } {
  if (query === "") return { rest: "", found: false, render: "link" };
  const kept: string[] = [];
  const found: string[] = [];
  for (const segment of query.split("&")) {
    const eq = segment.indexOf("=");
    const rawKey = eq < 0 ? segment : segment.slice(0, eq);

    if (decodeQueryPart(rawKey) !== RENDER_PARAM) {
      kept.push(segment);
      continue;
    }
    found.push(eq < 0 ? "" : segment.slice(eq + 1));
  }
  if (found.length > 1) return { error: `the address repeats ${RENDER_PARAM}` };
  if (found.length === 0) return { rest: kept.join("&"), found: false, render: "link" };

  const value = decodeQueryPart(found[0]);
  if (value === null || !RENDER_FORMS.includes(value as ShipitLinkRender)) {
    return { error: `${RENDER_PARAM} must be one of ${RENDER_FORMS.join(", ")}` };
  }
  return { rest: kept.join("&"), found: true, render: value as ShipitLinkRender };
}

interface RenderSplit {

  query: string;

  fragment: string;
  render: ShipitLinkRender;
}

/**
 * Resolve the render form from **either** query position, and hand back what
 * remains of each for the page.
 *
 * `shipit-render` is ShipIt's own name, so it is honoured — and stripped —
 * wherever it appears in the address, not only in the query string a URL parser
 * would call the query. Agents write it *after* the fragment often enough
 * (`…/reqs.html#req-7?shipit-render=button`) that reading only the canonical
 * position failed twice over, silently: the requested form was lost, and the
 * fragment kept the parameter — so a Present pointer scrolled to a heading that
 * cannot exist, and a Preview pointer handed the page ShipIt's own knob inside
 * `location.hash`, which req 11 forbids in the query and means equally there.
 *
 * This is extraction, not repair. The parser stays a gate: a fragment's own `?`
 * is left alone, because `#/items?focus=7` is a hash router's URL and belongs to
 * the page byte-for-byte. Only the `?` that existed solely to introduce
 * `shipit-render` goes with it.
 *
 * The parameter in **both** positions is the same malformed pointer a repeat
 * within one query is, for the same reason: which one the author meant is
 * unknowable, and picking either would honour a form nobody asked for.
 */
function resolveRender(query: string, fragment: string): RenderSplit | { error: string } {
  const fromQuery = extractRenderParam(query);
  if ("error" in fromQuery) return fromQuery;

  const queryAt = fragment.indexOf("?");
  if (queryAt < 0) {
    return { query: fromQuery.rest, fragment, render: fromQuery.render };
  }

  const fromFragment = extractRenderParam(fragment.slice(queryAt + 1));
  if ("error" in fromFragment) return fromFragment;
  if (fromQuery.found && fromFragment.found) {
    return { error: `the address repeats ${RENDER_PARAM}` };
  }

  if (!fromFragment.found) {
    return { query: fromQuery.rest, fragment, render: fromQuery.render };
  }

  const head = fragment.slice(0, queryAt);
  return {
    query: fromQuery.rest,
    fragment: fromFragment.rest === "" ? head : `${head}?${fromFragment.rest}`,
    render: fromFragment.render,
  };
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

function parsePreview(rest: string): ShipitLink {
  if (!rest.startsWith("//")) {
    return invalid("a preview address needs a service name, as shipit-preview://<service>/<path>");
  }
  const afterAuthority = rest.slice(2);

  const end = afterAuthority.search(/[/?#]/);
  const service = end < 0 ? afterAuthority : afterAuthority.slice(0, end);
  const remainder = end < 0 ? "" : afterAuthority.slice(end);
  const { path, query, fragment } = splitParts(remainder);

  const split = resolveRender(query, fragment);
  if ("error" in split) return invalid(split.error);
  const { render } = split;

  if (service === "") return invalid("the address names no service", render);
  if (service.length > MAX_SERVICE_LENGTH) return invalid("the service name is too long", render);
  if (!SERVICE_NAME_RE.test(service)) {

    // a service name and never a port, so either is a malformed pointer.
    return invalid(`"${service}" is not a valid service name`, render);
  }

  const normalizedPath = path === "" ? "/" : path;
  if (!normalizedPath.startsWith("/") || normalizedPath.startsWith("//")) {
    return invalid("a preview path must begin with a single /", render);
  }

  const target =
    normalizedPath +
    (split.query === "" ? "" : `?${split.query}`) +
    (split.fragment === "" ? "" : `#${split.fragment}`);

  return { kind: "preview", service, target, render };
}

function parsePresent(rest: string): ShipitLink {
  const { path, query, fragment: rawFragment } = splitParts(rest);

  const split = resolveRender(query, rawFragment);
  if ("error" in split) return invalid(split.error);
  const { render, fragment } = split;

  if (path === "") return invalid("the address names no file", render);
  if (path.length > MAX_FILE_PATH_LENGTH) return invalid("the file path is too long", render);

  const decodedPath = decodeOnce(path);
  if (decodedPath === null) return invalid("the file path is not valid", render);

  const filePath = decodedPath.startsWith("./") ? decodedPath.slice(2) : decodedPath;
  if (filePath === "") return invalid("the address names no file", render);

  if (fragment === "") return { kind: "present", filePath, render };

  if (fragment.length > MAX_FRAGMENT_LENGTH) return invalid("the fragment is too long", render);
  const decodedFragment = decodeOnce(fragment);
  if (decodedFragment === null) return invalid("the fragment is not valid", render);

  return { kind: "present", filePath, fragment: decodedFragment, render };
}

export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
}
