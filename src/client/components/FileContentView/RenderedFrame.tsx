// Keep the iframe origin opaque: never add `allow-same-origin` to its sandbox.

import type { Ref } from "react";
import { AGENT_INTERFACE_SDK_SCRIPT } from "../../../server/shared/agent-interface-sdk/bootstrap.js";

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
  return `<!doctype html><html><head>${CSP_META}</head><body>${html}</body></html>`;
}

// JSON escaping alone does not stop an HTML parser from closing the script tag.
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

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

const HEIGHT_REPORT_SCRIPT =
  "<script>(function(){var s='shipit-preview';var last=-1;"
  // `scrollHeight` includes the assigned viewport and prevents shrinking.
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

/**
 * Forward a click on a ShipIt-scheme link out to the embedder (docs/258 req 14).
 *
 * The artifact is mounted from `srcDoc` on an opaque origin, so a
 * `shipit-preview://` href is a scheme the frame itself can do nothing with: the
 * click is swallowed and the pointer the agent wrote into its own artifact is
 * dead. The frame therefore reports the href and lets the parent resolve it,
 * which is the same code path a pointer in chat takes.
 *
 * `preventDefault` runs for **every** button, including the auxiliary ones: a
 * middle-click on a custom-protocol href is what hands it to the OS protocol
 * handler, the same reason a chat pointer carries no real `href`. Only a primary
 * click opens, so a middle-click does nothing — ShipIt has no second tab to open
 * one in, and a ⌘-click is a primary click that opens here like any other.
 *
 * Capture phase, because a page that calls `stopPropagation` on its own links
 * would otherwise keep the click from ever reaching this listener.
 *
 * The anchor is found through `composedPath()`, not by walking `parentNode` from
 * `event.target`: inside a web component the target is retargeted to the host,
 * so a walk finds no anchor and the link in an open shadow root stays dead. The
 * href is trimmed for the same reason — the HTML URL parser strips surrounding
 * whitespace, so ` shipit-preview://…` is a pointer the browser would resolve,
 * and forwarding it untrimmed would address a place with a space in its name.
 */
export const LINK_CLICK_SCRIPT =
  "<script>(function(){var s='shipit-preview';"
  + "function anchor(e){var p=e.composedPath?e.composedPath():null,i,n;"
  + "if(p){for(i=0;i<p.length;i++){n=p[i];"
  + "if(n&&n.nodeType===1&&String(n.tagName).toLowerCase()==='a')return n;}return null;}"
  + "n=e.target;while(n&&n.nodeType===1&&String(n.tagName).toLowerCase()!=='a')n=n.parentNode;"
  + "return n&&n.nodeType===1?n:null;}"
  + "function on(e){var el=anchor(e);if(!el)return;"
  + "var href=(el.getAttribute('href')||'').trim();"
  + "if(!/^shipit-(preview|present):/i.test(href))return;"
  + "e.preventDefault();"
  + "if(e.type==='click'&&!e.button)parent.postMessage({source:s,type:'link_click',href:href},'*');}"
  + "document.addEventListener('click',on,true);"
  + "document.addEventListener('auxclick',on,true);})()</script>";

function injectLinkClicks(html: string): string {
  const head = /<head[^>]*>/i.exec(html);
  if (head?.index !== undefined) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}${LINK_CLICK_SCRIPT}${html.slice(at)}`;
  }
  return `${LINK_CLICK_SCRIPT}${html}`;
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
  shipitLinks = false,
  frameRef,
  scrollTo,
}: {
  kind: "html" | "svg";
  content: string;
  enableAgentInterface?: boolean;
  reportHeight?: boolean;
  /**
   * Report clicks on `shipit-preview://` / `shipit-present:` links out to the
   * embedder (req 14). Off by default and on only for a **presented** artifact:
   * a repo file rendered in the file-preview dialog is content ShipIt did not
   * author, and a pointer click can start a Compose service (req 12).
   */
  shipitLinks?: boolean;
  frameRef?: Ref<HTMLIFrameElement>;
  scrollTo?: string;
}) {
  let srcDoc: string;
  if (kind === "svg") {
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
    const withLinks = shipitLinks ? injectLinkClicks(withSdk) : withSdk;
    const withHeight = reportHeight ? injectHeightReport(withLinks) : withLinks;
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
