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
  reportHeight?: boolean;
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
