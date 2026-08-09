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

import type { Ref } from "react";
import { AGENT_INTERFACE_SDK_SCRIPT } from "../../../server/shared/agent-interface-sdk/bootstrap.js";

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

/**
 * Serialize a value for embedding in an inline `<script>`. `JSON.stringify`
 * alone is NOT enough: a string containing `</script>` stays a valid JS string
 * literal but still closes the script element as far as the HTML parser is
 * concerned, which is the whole breakout. Escaping `<`, `>` and `&` to their
 * `\uXXXX` forms leaves the value identical to JavaScript and inert to HTML.
 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

/**
 * Scroll a presented HTML artifact to the element an agent-authored pointer
 * named (docs/258 req 9).
 *
 * The artifact is mounted from `srcDoc` with `sandbox="allow-scripts"` and no
 * `allow-same-origin`, so its document URL is `about:srcdoc` on an opaque
 * origin: there is no `location.hash` to set, no fragment the parent can
 * navigate it to, and — since this feature adds no SDK — no channel to send one
 * over. So the fragment is baked in when the frame is built.
 *
 * It cannot fire on receipt: the script is injected into `<head>`, and for a
 * Present artifact the click is what mounts the frame, so the element does not
 * exist yet. Defer to `DOMContentLoaded`, running immediately only when the
 * document has already parsed.
 *
 * A *different* fragment changes the `srcDoc` and so remounts the frame, which
 * is how a second pointer into the same artifact scrolls. An identical repeat
 * click deliberately does **not**: an earlier draft varied the script per click
 * to force that remount, which threw away whatever state the artifact's own
 * scripts held — a disproportionate price for re-running a scroll, and the
 * requirements already accept that a repeat click on an identical pointer does
 * nothing.
 */
function injectScrollToFragment(html: string, fragment: string): string {
  const script = `<script>(function(){var id=${jsonForScript(fragment)};`
    + `function go(){var el=document.getElementById(id);if(el)el.scrollIntoView();}`
    + `if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",go);else go();})()</script>`;
  const head = /<head[^>]*>/i.exec(html);
  if (head?.index !== undefined) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}${script}${html.slice(at)}`;
  }
  return `${script}${html}`;
}

function injectAgentInterface(html: string): string {
  const head = /<head[^>]*>/i.exec(html);
  if (head?.index !== undefined) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}${AGENT_INTERFACE_SDK_SCRIPT}${html.slice(at)}`;
  }
  return `${AGENT_INTERFACE_SDK_SCRIPT}${html}`;
}

export function RenderedFrame({
  kind,
  content,
  enableAgentInterface = false,
  frameRef,
  scrollTo,
}: {
  kind: "html" | "svg";
  content: string;
  enableAgentInterface?: boolean;
  frameRef?: Ref<HTMLIFrameElement>;
  /**
   * docs/258 — an element id an agent-authored pointer addressed. Only honoured
   * for `html`; there is no place inside an SVG to address.
   */
  scrollTo?: string;
}) {
  let srcDoc: string;
  if (kind === "svg") {
    // Wrap raw SVG markup in a minimal HTML host so iframe sandboxing applies
    // even if the SVG contains <script>. Centered with subtle padding so
    // viewBox-relative dimensions don't paint flush to the bezel.
    const markup = svgToMarkup(content);
    srcDoc = `<!doctype html><html><head>${CSP_META}</head><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:white">${markup}</body></html>`;
  } else {
    const secured = injectCsp(content);
    const withSdk = enableAgentInterface ? injectAgentInterface(secured) : secured;
    srcDoc = scrollTo ? injectScrollToFragment(withSdk, scrollTo) : withSdk;
  }

  return (
    <iframe
      title="Rendered content"
      ref={frameRef}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      className="w-full h-full border-0"
    />
  );
}
