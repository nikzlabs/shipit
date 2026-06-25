/**
 * RenderedFrame — sandboxed iframe that renders HTML/SVG content for both the
 * file-viewer dialog and the Present tab (docs/219). Lifted from PresentPane's
 * `PresentationContent`.
 *
 * Security (docs/219 Risks): `sandbox="allow-scripts"` with NO `allow-same-origin`
 * + `srcDoc` keeps the frame origin-null — no cookie/storage/parent/DOM/token
 * access, no top-level navigation. Even fully malicious committed HTML cannot
 * steal ShipIt credentials or read the workspace. NEVER add `allow-same-origin`.
 *
 * The one residual capability the sandbox leaves open is outbound network
 * requests (beaconing/exfil of whatever is embedded in the page). We close that
 * with a best-effort frame CSP (`connect-src 'none'; form-action 'none'`)
 * injected into the document — scripts still run (charts work) but can't phone
 * home or submit forms.
 */

/** SVG content arrives raw (Present) or as a base64/url-encoded `data:` URI
 *  (the files API for a dialog-opened `.svg`). Normalize to raw markup so both
 *  the rendered frame and the source view show XML, not a data-URI string. */
export function svgToMarkup(content: string): string {
  if (!content.startsWith("data:")) return content;
  const comma = content.indexOf(",");
  if (comma < 0) return content;
  const meta = content.slice("data:".length, comma);
  const data = content.slice(comma + 1);
  try {
    return /;base64/i.test(meta) ? atob(data) : decodeURIComponent(data);
  } catch {
    return content;
  }
}

const CSP_CONTENT = "connect-src 'none'; form-action 'none'";
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${CSP_CONTENT}">`;

/** Best-effort: place the CSP meta inside <head> (where browsers honor it). */
function injectCsp(html: string): string {
  const head = /<head[^>]*>/i.exec(html);
  if (head?.index !== undefined) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}${CSP_META}${html.slice(at)}`;
  }
  const htmlTag = /<html[^>]*>/i.exec(html);
  if (htmlTag?.index !== undefined) {
    const at = htmlTag.index + htmlTag[0].length;
    return `${html.slice(0, at)}<head>${CSP_META}</head>${html.slice(at)}`;
  }
  // Bare fragment — wrap in a minimal scaffold so the meta lands in <head>.
  return `<!doctype html><html><head>${CSP_META}</head><body>${html}</body></html>`;
}

export function RenderedFrame({
  kind,
  content,
}: {
  kind: "html" | "svg";
  content: string;
}) {
  let srcDoc: string;
  if (kind === "svg") {
    // Wrap raw SVG markup in a minimal HTML host so iframe sandboxing applies
    // even if the SVG contains <script>. Centered with subtle padding so
    // viewBox-relative dimensions don't paint flush to the bezel.
    const markup = svgToMarkup(content);
    srcDoc = `<!doctype html><html><head>${CSP_META}</head><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:white">${markup}</body></html>`;
  } else {
    srcDoc = injectCsp(content);
  }

  return (
    <iframe
      title="Rendered content"
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      className="w-full h-full border-0"
    />
  );
}
