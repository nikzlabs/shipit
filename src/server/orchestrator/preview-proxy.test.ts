/**
 * Unit tests for `buildUpstreamHeaders` — the forwarded-header logic that lets
 * the preview proxy hand the upstream a loopback `Host` while still telling
 * frameworks (Gradio, etc.) the browser-facing host so they compute a public
 * root URL the browser can actually reach.
 *
 * Regression guard for the "Gradio preview calls localhost:7860 and fails with
 * ERR_CONNECTION_REFUSED" bug.
 */

import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { AGENT_INTERFACE_SDK_MARKER } from "../shared/agent-interface-sdk/bootstrap.js";
import { allowPreviewBootstrapInCsp, buildUpstreamHeaders, injectPreviewBootstrap } from "./preview-proxy.js";

describe("buildUpstreamHeaders", () => {
  it("rewrites Host to loopback for the upstream", () => {
    const out = buildUpstreamHeaders(
      { host: "abc--7860.localhost:3001" },
      7860,
    );
    expect(out.host).toBe("localhost:7860");
  });

  it("preserves the browser-facing host in X-Forwarded-Host", () => {
    const out = buildUpstreamHeaders(
      { host: "abc--7860.localhost:3001" },
      7860,
    );
    // Gradio derives its public root URL from this; without it the frontend
    // would call localhost:7860 (the user's machine in a browser session).
    expect(out["x-forwarded-host"]).toBe("abc--7860.localhost:3001");
  });

  it("defaults X-Forwarded-Proto to http when none is present", () => {
    const out = buildUpstreamHeaders({ host: "abc--7860.localhost:3001" }, 7860);
    expect(out["x-forwarded-proto"]).toBe("http");
  });

  it("does not downgrade an upstream-provided https proto", () => {
    const out = buildUpstreamHeaders(
      {
        host: "localhost:3001",
        "x-forwarded-host": "preview.shipit.example.com",
        "x-forwarded-proto": "https",
      },
      7860,
    );
    // An ingress that terminated TLS already set these — they must win so
    // Gradio emits https:// URLs and the browser doesn't hit mixed content.
    expect(out["x-forwarded-proto"]).toBe("https");
    expect(out["x-forwarded-host"]).toBe("preview.shipit.example.com");
    expect(out.host).toBe("localhost:7860");
  });

  it("omits X-Forwarded-Host when there is no host to forward", () => {
    const out = buildUpstreamHeaders({}, 7860);
    expect(out["x-forwarded-host"]).toBeUndefined();
    expect(out.host).toBe("localhost:7860");
  });

  it("leaves other headers untouched", () => {
    const out = buildUpstreamHeaders(
      { host: "abc--7860.localhost:3001", "user-agent": "test", cookie: "a=b" },
      7860,
    );
    expect(out["user-agent"]).toBe("test");
    expect(out.cookie).toBe("a=b");
  });
});

describe("injectPreviewBootstrap", () => {
  it("injects the shared SDK immediately after head", () => {
    const html = injectPreviewBootstrap("<!doctype html><html><head><title>App</title></head></html>");
    expect(html).toContain(`<head><script>`);
    expect(html).toContain(AGENT_INTERFACE_SDK_MARKER);
    expect(html.indexOf(AGENT_INTERFACE_SDK_MARKER)).toBeLessThan(html.indexOf("<title>"));
  });

  it("prepends scripts when HTML has no head", () => {
    expect(injectPreviewBootstrap("<main>App</main>")).toMatch(/^<script>/);
  });

  it("does not inject a second SDK into an already-instrumented document", () => {
    const once = injectPreviewBootstrap("<html><head></head></html>");
    const twice = injectPreviewBootstrap(once);
    expect(twice.split(AGENT_INTERFACE_SDK_MARKER)).toHaveLength(2);
  });
});

/**
 * The injected HMR/toolbar script is a hand-written string, so we execute the
 * real one in a sandbox rather than pattern-matching its source. Path reporting
 * is the part worth proving: a load-time read alone goes stale the moment a
 * client-side router moves, and the History wrapper that fixes that sits on the
 * hot path of every SPA navigation in every preview.
 */
interface PostedMessage { source?: string; type?: string; path?: string }

function runInjectedScript(initial = { pathname: "/", search: "", hash: "" }) {
  const posted: PostedMessage[] = [];
  const listeners = new Map<string, ((e?: unknown) => void)[]>();
  const pushed: unknown[][] = [];
  const history = {
    pushState: (...args: unknown[]) => { pushed.push(args); return "original-return"; },
    replaceState: (...args: unknown[]) => { pushed.push(args); },
  };
  const location = { ...initial, port: "3001", hostname: "preview.localhost" };
  const window = {
    WebSocket: function FakeWebSocket() {},
    parent: { postMessage: (m: PostedMessage) => posted.push(m) },
    addEventListener: (type: string, fn: (e?: unknown) => void) => {
      const existing = listeners.get(type) ?? [];
      listeners.set(type, [...existing, fn]);
    },
  };
  const html = injectPreviewBootstrap("<html><head></head></html>");
  const body = html.slice(html.indexOf("<script>") + "<script>".length, html.indexOf("</script>"));
  vm.runInContext(body, vm.createContext({
    window, history, location, URL, WebSocket: window.WebSocket,
  }));
  return { posted, listeners, history, location, pushed };
}

describe("injected preview script — path reporting", () => {
  it("reports the current path to the parent on load", () => {
    const { posted } = runInjectedScript({ pathname: "/orders/8842", search: "?tab=open", hash: "" });
    expect(posted).toContainEqual({ source: "shipit-preview", type: "path", path: "/orders/8842?tab=open" });
  });

  it("never includes the host or port in the reported value", () => {
    const { posted } = runInjectedScript();
    const paths = posted.filter((m) => m.type === "path").map((m) => m.path);
    expect(paths).toEqual(["/"]);
    for (const p of paths) expect(p).not.toContain("preview.localhost");
  });

  it("re-reports when a client-side router pushes a new route", () => {
    const { posted, history, location } = runInjectedScript();
    location.pathname = "/settings/secrets";
    history.pushState({}, "", "/settings/secrets");
    expect(posted.filter((m) => m.type === "path").map((m) => m.path))
      .toEqual(["/", "/settings/secrets"]);
  });

  it("re-reports on replaceState and on popstate", () => {
    const { posted, history, listeners, location } = runInjectedScript();
    location.pathname = "/a";
    history.replaceState({}, "", "/a");
    location.pathname = "/b";
    for (const fn of listeners.get("popstate") ?? []) fn();
    expect(posted.filter((m) => m.type === "path").map((m) => m.path)).toEqual(["/", "/a", "/b"]);
  });

  it("re-reports on hashchange, so hash routers stay live", () => {
    const { posted, listeners, location } = runInjectedScript();
    location.hash = "#/orders";
    for (const fn of listeners.get("hashchange") ?? []) fn();
    expect(posted.filter((m) => m.type === "path").map((m) => m.path)).toEqual(["/", "/#/orders"]);
  });

  it("calls through to the original History methods and preserves their return", () => {
    // The wrapper sits on every SPA navigation — swallowing the call or its
    // return value would break routing in every preview.
    const { history, pushed } = runInjectedScript();
    const returned = history.pushState({ a: 1 }, "", "/x");
    expect(pushed).toEqual([[{ a: 1 }, "", "/x"]]);
    expect(returned).toBe("original-return");
  });
});

describe("allowPreviewBootstrapInCsp", () => {
  it("replaces script-src none with exact injected-script hashes", () => {
    const result = allowPreviewBootstrapInCsp("default-src 'self'; script-src 'none'; connect-src 'self'");
    expect(result).not.toContain("script-src 'none'");
    expect(result.match(/'sha256-[^']+'/g)).toHaveLength(2);
    expect(result).toContain("connect-src 'self'");
  });

  it("adds a script directive when only default-src exists", () => {
    expect(allowPreviewBootstrapInCsp("default-src 'none'")).toMatch(/script-src 'sha256-/);
  });
});
