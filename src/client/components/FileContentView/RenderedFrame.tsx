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

/**
 * docs/280 — report the document's own height to the embedder.
 *
 * A Present-tab artifact fills the pane, so its frame height is decided by the
 * layout and nothing has to be measured. An INLINE card has no such box: it sits
 * in the chat flow, and a fixed height would either crop a two-line SVG's
 * neighbour into a scrollbar or leave a thumbnail floating in empty space. The
 * frame is sandboxed onto an opaque origin, so the parent cannot read
 * `scrollHeight` itself — the document has to volunteer it.
 *
 * Deliberately NOT part of the Agent Interface SDK: the SDK is also injected
 * into every proxied service preview, where a permanent `ResizeObserver` on the
 * user's own app would be a cost paid by pages that never need it. This script
 * is injected only by the surface that measures.
 */
const HEIGHT_REPORT_SCRIPT =
  "<script>(function(){var s='shipit-preview';var last=-1;"
  // The BODY's box, not `documentElement.scrollHeight`. `scrollHeight` is
  // max(content, viewport), and the viewport here is the frame the embedder
  // already sized — so a short artifact would report back whatever height it
  // was given and could never shrink to fit. Measured: a one-line artifact in a
  // 220px frame reported 220. The body's border box plus its margins is the
  // content height, independent of the frame.
  + "function measure(){var b=document.body;if(!b)return document.documentElement.scrollHeight;"
  + "var cs=getComputedStyle(b);"
  + "return b.getBoundingClientRect().height+(parseFloat(cs.marginTop)||0)+(parseFloat(cs.marginBottom)||0);}"
  + "function post(){var h=Math.ceil(measure());if(h===last)return;last=h;"
  + "parent.postMessage({source:s,type:'content_height',height:h},'*');}"
  + "if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',post);else post();"
  + "window.addEventListener('load',post);"
  + "if(window.ResizeObserver){var ro=new ResizeObserver(post);ro.observe(document.documentElement);"
  + "if(document.body)ro.observe(document.body);"
  + "else document.addEventListener('DOMContentLoaded',function(){ro.observe(document.body);});}"
  + "})()</script>";

function injectHeightReport(html: string): string {
  const head = /<head[^>]*>/i.exec(html);
  if (head?.index !== undefined) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}${HEIGHT_REPORT_SCRIPT}${html.slice(at)}`;
  }
  return `${HEIGHT_REPORT_SCRIPT}${html}`;
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
  reportHeight = false,
  frameRef,
  scrollTo,
}: {
  kind: "html" | "svg";
  content: string;
  enableAgentInterface?: boolean;
  /**
   * docs/280 — inject the height reporter, so an embedder that has to SIZE the
   * frame (the inline chat card) can learn the document's natural height. The
   * Present tab and the file dialog give the frame a box and leave this off.
   */
  reportHeight?: boolean;
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
    //
    // A height-reporting host does NOT stretch to the viewport: `height:100vh`
    // would make `scrollHeight` echo back whatever height the embedder last set,
    // so the measurement could never shrink and the SVG's own size would never
    // be discovered.
    const markup = svgToMarkup(content);
    const bodyStyle = reportHeight
      ? "margin:0;padding:8px;background:white"
      : "margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:white";
    const svgFit = reportHeight
      ? "<style>svg{max-width:100%;height:auto;display:block;margin:0 auto}</style>"
      : "";
    srcDoc = `<!doctype html><html><head>${CSP_META}${svgFit}${reportHeight ? HEIGHT_REPORT_SCRIPT : ""}</head><body style="${bodyStyle}">${markup}</body></html>`;
  } else {
    const secured = injectCsp(content);
    const withSdk = enableAgentInterface ? injectAgentInterface(secured) : secured;
    const withHeight = reportHeight ? injectHeightReport(withSdk) : withSdk;
    srcDoc = scrollTo ? injectScrollToFragment(withHeight, scrollTo) : withHeight;
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
