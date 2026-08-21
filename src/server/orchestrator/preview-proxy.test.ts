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

  it("keeps the hand-written script ASCII, since we don't control the charset", () => {
    // We splice bytes into whatever the app serves, and a page with no declared
    // charset renders our UTF-8 characters as mojibake (seen in Chromium, with
    // an em dash in a console message).
    //
    // Scoped to the first injected script — ours. The SDK script beside it is
    // `installShipItPageSdk.toString()`, whose exact bytes depend on the
    // transform (vitest keeps the function's comments, production's esbuild
    // strips them), so asserting over it would test the transform, not us.
    const injected = injectPreviewBootstrap("<html><head></head></html>");
    const ourScript = injected.slice(0, injected.indexOf("</script>"));
    const nonAscii = Array.from(ourScript).filter((c) => c.charCodeAt(0) > 127);
    expect(nonAscii).toEqual([]);
  });
});

/**
 * The injected HMR/toolbar script is a hand-written string, so we execute the
 * real one in a sandbox rather than pattern-matching its source. Path reporting
 * is the part worth proving: a load-time read alone goes stale the moment a
 * client-side router moves, and the History wrapper that fixes that sits on the
 * hot path of every SPA navigation in every preview.
 */
interface PostedMessage { source?: string; type?: string; path?: string; canGoBack?: boolean }

/** Minimal stand-in for the Navigation API's back()/forward() result. */
function navResult(rejection?: string) {
  const p = rejection ? Promise.reject(new Error(rejection)) : Promise.resolve();
  // Attach a no-op catch to the source promise so an *unhandled* rejection in
  // the test itself can't be confused with the script failing to swallow one.
  return { committed: p.catch(() => { throw new Error(rejection); }), finished: p.catch(() => { throw new Error(rejection); }) };
}

function runInjectedScript(
  initial = { pathname: "/", search: "", hash: "" },
  navigation?: {
    canGoBack: boolean;
    canGoForward: boolean;
    back: () => unknown;
    forward: () => unknown;
    navigate: (url: string) => unknown;
    addEventListener: (type: string, fn: (e?: unknown) => void) => void;
    entries?: () => { key: string }[];
    currentEntry?: { index: number; key: string };
    traverseTo?: (key: string) => unknown;
  },
) {
  const posted: PostedMessage[] = [];
  const listeners = new Map<string, ((e?: unknown) => void)[]>();
  const pushed: unknown[][] = [];
  const traversed: string[] = [];
  const warnings: string[] = [];
  // Modelled the way a browser has it — the traversing methods and `length`
  // live on `History.prototype`, not on the instance — because the script
  // patches the prototype, and an instance-only fake would let a patch that
  // misses `History.prototype.back.call(history)` look like it works.
  // `length` starts at the JOINT length a frame really sees (Chromium: one own
  // entry, `length` 9), which is what makes it useless as a guard unpatched.
  const historyProto = {
    pushState: (...args: unknown[]) => { pushed.push(args); return "original-return"; },
    replaceState: (...args: unknown[]) => { pushed.push(args); },
    back: () => { traversed.push("history.back"); },
    forward: () => { traversed.push("history.forward"); },
    go: (d?: unknown) => { traversed.push(`history.go:${String(d)}`); },
    length: 9,
  };
  const history: typeof historyProto & { state: unknown } = Object.create(historyProto);
  history.state = null;
  const assigned: string[] = [];
  const location = {
    ...initial,
    port: "3001",
    hostname: "preview.localhost",
    href: `https://preview.localhost:3001${initial.pathname}${initial.search}${initial.hash}`,
    reload: () => { traversed.push("reload"); },
    assign: (u: string) => { assigned.push(u); },
  };
  const parent = { postMessage: (m: PostedMessage) => posted.push(m) };
  const dispatched: unknown[] = [];
  const window = {
    WebSocket: function FakeWebSocket() {},
    navigation,
    parent,
    History: { prototype: historyProto },
    addEventListener: (type: string, fn: (e?: unknown) => void) => {
      const existing = listeners.get(type) ?? [];
      listeners.set(type, [...existing, fn]);
    },
    dispatchEvent: (e: unknown) => { dispatched.push(e); return true; },
  };
  /** Stand-ins for the constructors the script uses to announce a rewrite. */
  class FakeHashChangeEvent {
    type: string;
    oldURL: unknown;
    newURL: unknown;
    constructor(type: string, init: { oldURL?: unknown; newURL?: unknown } = {}) {
      this.type = type;
      this.oldURL = init.oldURL;
      this.newURL = init.newURL;
    }
  }
  class FakePopStateEvent {
    type: string;
    state: unknown;
    constructor(type: string, init: { state?: unknown } = {}) {
      this.type = type;
      this.state = init.state;
    }
  }
  const html = injectPreviewBootstrap("<html><head></head></html>");
  const body = html.slice(html.indexOf("<script>") + "<script>".length, html.indexOf("</script>"));
  vm.runInContext(body, vm.createContext({
    window, history, location, URL, WebSocket: window.WebSocket, Promise,
    HashChangeEvent: FakeHashChangeEvent, PopStateEvent: FakePopStateEvent,
    console: { warn: (...args: unknown[]) => { warnings.push(args.join(" ")); } },
  }));
  // Commands arrive from the embedding window, which is what the script checks.
  const toolbar = (type: string, extra: Record<string, unknown> = {}, source: unknown = parent) => {
    for (const fn of listeners.get("message") ?? []) {
      fn({ data: { source: "shipit-toolbar", type, ...extra }, source });
    }
  };
  return { posted, listeners, history, historyProto, location, pushed, traversed, toolbar, assigned, dispatched, warnings };
}

/**
 * A Navigation API stub that records which traversals were attempted.
 *
 * `entries` / `currentIndex` opt into the frame-scoped entry list that a
 * multi-step `history.go(delta)` traverses through; omitting them models an
 * engine that has back()/forward() but no traverseTo, which must refuse.
 */
function fakeNavigation(
  opts: {
    canGoBack?: boolean;
    canGoForward?: boolean;
    rejectWith?: string;
    entries?: string[];
    currentIndex?: number;
  } = {},
) {
  const calls: string[] = [];
  const navListeners = new Map<string, ((e?: unknown) => void)[]>();
  const entryList = opts.entries?.map((key) => ({ key }));
  return {
    calls,
    navListeners,
    nav: {
      canGoBack: opts.canGoBack ?? true,
      canGoForward: opts.canGoForward ?? true,
      back: () => { calls.push("back"); return navResult(opts.rejectWith); },
      forward: () => { calls.push("forward"); return navResult(opts.rejectWith); },
      navigate: (url: string) => { calls.push(`navigate:${url}`); return navResult(opts.rejectWith); },
      addEventListener: (type: string, fn: (e?: unknown) => void) => {
        navListeners.set(type, [...(navListeners.get(type) ?? []), fn]);
      },
      ...(entryList
        ? {
            entries: () => entryList,
            currentEntry: {
              index: opts.currentIndex ?? entryList.length - 1,
              key: entryList[opts.currentIndex ?? entryList.length - 1].key,
            },
            traverseTo: (key: string) => { calls.push(`traverseTo:${key}`); return navResult(opts.rejectWith); },
          }
        : {}),
    },
  };
}

describe("injected preview script — path reporting", () => {
  it("reports the current path to the parent on load", () => {
    const { posted } = runInjectedScript({ pathname: "/orders/8842", search: "?tab=open", hash: "" });
    expect(posted).toContainEqual({ source: "shipit-preview", type: "path", path: "/orders/8842?tab=open", canGoBack: false });
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

describe("injected preview script — toolbar history navigation", () => {
  // `history.back()` in a frame traverses the JOINT session history, so a
  // preview with no entry of its own walks the ShipIt tab back instead — the
  // user gets kicked out of their session by the preview's Back button.
  // Everything here exists to keep the traversal inside the frame.
  it("does not traverse at all when the preview has no history of its own", () => {
    const { calls, nav } = fakeNavigation({ canGoBack: false });
    const { toolbar, traversed } = runInjectedScript(undefined, nav);

    toolbar("back");

    expect(calls).toEqual([]);
    // Crucially not a fallback to `history.back()` — that is the leak.
    expect(traversed).toEqual([]);
  });

  it("goes back through the Navigation API, which is scoped to this frame", () => {
    const { calls, nav } = fakeNavigation({ canGoBack: true });
    const { toolbar, traversed } = runInjectedScript(undefined, nav);

    toolbar("back");

    expect(calls).toEqual(["back"]);
    expect(traversed).toEqual([]);
  });

  it("applies the same guard to forward", () => {
    const blocked = fakeNavigation({ canGoForward: false });
    runInjectedScript(undefined, blocked.nav).toolbar("forward");
    expect(blocked.calls).toEqual([]);

    const allowed = fakeNavigation({ canGoForward: true });
    runInjectedScript(undefined, allowed.nav).toolbar("forward");
    expect(allowed.calls).toEqual(["forward"]);
  });

  it("swallows a rejection when the entry list moves between check and call", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const { nav } = fakeNavigation({ canGoBack: true, rejectWith: "InvalidStateError" });
      runInjectedScript(undefined, nav).toolbar("back");
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    // An unhandled rejection here would surface in the previewed app's console.
    expect(rejections).toEqual([]);
  });

  it("refuses to traverse at all where the Navigation API is missing", () => {
    // There is no legacy way to ask whether *this frame* can go back, so
    // `history.back()` here would be the original bug: it would walk the
    // top-level ShipIt page back.
    const { toolbar, traversed } = runInjectedScript(undefined, undefined);
    toolbar("back");
    toolbar("forward");
    expect(traversed).toEqual([]);
  });

  it("reports canGoBack false without the Navigation API, so the button is disabled", () => {
    // Refusing to traverse silently would leave a live-looking, inert button.
    const { posted } = runInjectedScript(undefined, undefined);
    expect(posted.find((m) => m.type === "path")?.canGoBack).toBe(false);
  });

  it("reload is unaffected by the traversal guard", () => {
    const { nav } = fakeNavigation({ canGoBack: false });
    const { toolbar, traversed } = runInjectedScript(undefined, nav);
    toolbar("reload");
    expect(traversed).toEqual(["reload"]);
  });

  it("reports canGoBack alongside the path so the toolbar can disable Back", () => {
    const { nav } = fakeNavigation({ canGoBack: false });
    const { posted } = runInjectedScript(undefined, nav);
    expect(posted).toContainEqual({ source: "shipit-preview", type: "path", path: "/", canGoBack: false });
  });

  it("re-reports canGoBack after a client-side navigation creates an entry", () => {
    const { nav } = fakeNavigation({ canGoBack: false });
    const { posted, history } = runInjectedScript(undefined, nav);
    nav.canGoBack = true;
    history.pushState({}, "", "/next");
    expect(posted.filter((m) => m.type === "path").map((m) => m.canGoBack)).toEqual([false, true]);
  });

  it("re-reports when the app drives the Navigation API instead of History", () => {
    // A router in navigation-API mode calls `navigation.navigate()`, which
    // never touches the History methods we wrapped — without this listener
    // both the path display and canGoBack would silently freeze.
    const { nav, navListeners } = fakeNavigation({ canGoBack: false });
    const { posted, location } = runInjectedScript(undefined, nav);

    location.pathname = "/orders/8842";
    nav.canGoBack = true;
    for (const fn of navListeners.get("currententrychange") ?? []) fn();

    expect(posted.filter((m) => m.type === "path")).toEqual([
      { source: "shipit-preview", type: "path", path: "/", canGoBack: false },
      { source: "shipit-preview", type: "path", path: "/orders/8842", canGoBack: true },
    ]);
  });
});

describe("injected preview script — the previewed page's own traversal", () => {
  // The reported bug: a Back control *inside* the previewed app called
  // `history.back()`, which traverses the JOINT session history — so with no
  // entry of its own the frame walked the ShipIt tab back and switched the
  // user's active session. The toolbar guard does nothing here: this call
  // comes from the app, not from a `shipit-toolbar` message.
  it("keeps the page's own history.back() inside the frame", () => {
    const { calls, nav } = fakeNavigation({ canGoBack: true });
    const { history, traversed } = runInjectedScript(undefined, nav);

    history.back();

    expect(calls).toEqual(["back"]);
    // The native method — the one that walks the top-level page — never runs.
    expect(traversed).toEqual([]);
  });

  it("does nothing when the page goes back with no entry of its own", () => {
    const { calls, nav } = fakeNavigation({ canGoBack: false });
    const { history, traversed } = runInjectedScript(undefined, nav);

    history.back();

    expect(calls).toEqual([]);
    expect(traversed).toEqual([]);
  });

  it("applies the same containment to history.forward()", () => {
    const blocked = fakeNavigation({ canGoForward: false });
    const blockedRun = runInjectedScript(undefined, blocked.nav);
    blockedRun.history.forward();
    expect(blocked.calls).toEqual([]);
    expect(blockedRun.traversed).toEqual([]);

    const allowed = fakeNavigation({ canGoForward: true });
    const allowedRun = runInjectedScript(undefined, allowed.nav);
    allowedRun.history.forward();
    expect(allowed.calls).toEqual(["forward"]);
    expect(allowedRun.traversed).toEqual([]);
  });

  it("routes history.go(-1) / go(1) through the same frame-scoped guard", () => {
    const { calls, nav } = fakeNavigation({ canGoBack: true, canGoForward: true });
    const { history, traversed } = runInjectedScript(undefined, nav);

    history.go(-1);
    history.go(1);
    history.go("-1");

    expect(calls).toEqual(["back", "forward", "back"]);
    expect(traversed).toEqual([]);
  });

  it("traverses a multi-step go(delta) through the frame's own entry list", () => {
    const { calls, nav } = fakeNavigation({ entries: ["a", "b", "c"], currentIndex: 2 });
    const { history, traversed } = runInjectedScript(undefined, nav);

    history.go(-2);

    expect(calls).toEqual(["traverseTo:a"]);
    expect(traversed).toEqual([]);
  });

  it("refuses a go(delta) that would step outside the frame's entry list", () => {
    // Exactly the leak, in its multi-step form: the entries the delta would
    // reach past belong to the ShipIt tab, not to this frame.
    const { calls, nav } = fakeNavigation({ entries: ["a", "b"], currentIndex: 1 });
    const { history, traversed } = runInjectedScript(undefined, nav);

    history.go(-5);
    history.go(3);

    expect(calls).toEqual([]);
    expect(traversed).toEqual([]);
  });

  it("refuses a multi-step go(delta) where traverseTo is unavailable", () => {
    const { calls, nav } = fakeNavigation({ canGoBack: true });
    const { history, traversed } = runInjectedScript(undefined, nav);

    history.go(-2);

    expect(calls).toEqual([]);
    expect(traversed).toEqual([]);
  });

  it("treats go(0) and a missing delta as the reload the platform performs", () => {
    // A reload never leaves the frame, so it is not guarded — and swallowing it
    // would break an app that reloads itself this way.
    const { nav } = fakeNavigation({ canGoBack: false });
    const { history, traversed } = runInjectedScript(undefined, nav);

    history.go(0);
    history.go();

    expect(traversed).toEqual(["reload", "reload"]);
  });

  it("refuses the page's traversal entirely without the Navigation API", () => {
    // Same no-fallback policy as the toolbar: there is no legacy way to ask
    // whether *this frame* can go back, so the native call stays unreachable.
    const { history, traversed } = runInjectedScript(undefined, undefined);

    history.back();
    history.forward();
    history.go(-1);
    history.go(-3);

    expect(traversed).toEqual([]);
  });

  it("patches the prototype, so a prototype-level call cannot reach the native one", () => {
    // An own property on `history` would leave this as a live route back to
    // the joint traversal — the very call the leak needs.
    const { calls, nav } = fakeNavigation({ canGoBack: true });
    const { historyProto, history, traversed } = runInjectedScript(undefined, nav);

    historyProto.back.call(history);

    expect(calls).toEqual(["back"]);
    expect(traversed).toEqual([]);
  });

  it("converts the delta the way the native long conversion does", () => {
    // `go(4294967295)` is `go(-1)` natively (Web IDL `long` wraps at 2^32);
    // treating it as a huge positive delta would silently do nothing.
    const { calls, nav } = fakeNavigation({ canGoBack: true, canGoForward: true });
    const { history } = runInjectedScript(undefined, nav);

    history.go(4294967295);
    history.go(-1.7);
    history.go("1");

    expect(calls).toEqual(["back", "back", "forward"]);
  });

  it("reports the frame's own entry count as history.length", () => {
    // Unpatched this is the JOINT length (9 in the fake), so the
    // `history.length > 1` guard an app puts in front of its back button says
    // "yes" at the preview's first page and walks into a refusal.
    const bare = runInjectedScript(undefined, undefined);
    expect(bare.history.length).toBe(9);

    const { nav } = fakeNavigation({ entries: ["a"], currentIndex: 0 });
    const { history } = runInjectedScript(undefined, nav);
    expect(history.length).toBe(1);

    const deeper = fakeNavigation({ entries: ["a", "b", "c"], currentIndex: 2 });
    expect(runInjectedScript(undefined, deeper.nav).history.length).toBe(3);
  });

  it("says once in the console why a refused traversal did nothing", () => {
    // A refusal is otherwise invisible: History returns undefined and no event
    // fires, so the app's Back button just looks broken.
    const { nav } = fakeNavigation({ canGoBack: false });
    const { history, warnings } = runInjectedScript(undefined, nav);

    history.back();
    history.back();
    history.go(-3);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("[ShipIt preview]");
  });

  it("swallows a rejected traversal so the app's console stays clean", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const { nav } = fakeNavigation({ entries: ["a", "b", "c"], currentIndex: 2, rejectWith: "InvalidStateError" });
      const { history } = runInjectedScript(undefined, nav);
      history.back();
      history.go(-2);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    expect(rejections).toEqual([]);
  });
});

describe("injected preview script — pointer navigation", () => {
  // The bug this exists for: an agent-authored pointer used to arrive as a
  // `src` assignment on the parent's side, which is always a document load. A
  // pointer at a place inside the page the user was already on therefore tore
  // the app down and rebuilt it — a visible blink, and in-page state lost.
  const AT = { pathname: "/requirements", search: "?focus=3", hash: "#req-3" };

  it("changes only the fragment in place when the rest of the URL matches", () => {
    const { nav, calls } = fakeNavigation();
    const { toolbar, location, assigned } = runInjectedScript({ ...AT }, nav);

    toolbar("navigate", { url: "https://preview.localhost:3001/requirements?focus=3#req-7" });

    // A same-document navigation: no request, no reload, and `hashchange`
    // fires — the reaction channel the feature promises the page.
    expect(location.hash).toBe("#req-7");
    expect(assigned).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("does nothing at all when the destination is where the page already is", () => {
    const { nav, calls } = fakeNavigation();
    const { toolbar, location, assigned } = runInjectedScript({ ...AT }, nav);

    toolbar("navigate", { url: "https://preview.localhost:3001/requirements?focus=3#req-3" });

    expect(location.hash).toBe("#req-3");
    expect(assigned).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("removes the fragment in place rather than reloading to drop it", () => {
    // The browser's own fragment path does not cover removal (the navigation
    // algorithm takes it only for a non-null destination fragment), so this
    // would otherwise reload the app to get rid of a "#" — the exact blink the
    // fix exists to remove. A pointer at the app as a whole is this shape.
    const { nav, calls } = fakeNavigation();
    const { toolbar, assigned, pushed, dispatched } = runInjectedScript({ ...AT }, nav);

    toolbar("navigate", { url: "https://preview.localhost:3001/requirements?focus=3" });

    expect(assigned).toEqual([]);
    expect(calls).toEqual([]);
    expect(pushed).toEqual([[null, "", "https://preview.localhost:3001/requirements?focus=3"]]);
    // And the page is told, since the browser fires no event for a rewrite.
    expect(dispatched).toEqual([{
      type: "hashchange",
      oldURL: "https://preview.localhost:3001/requirements?focus=3#req-3",
      newURL: "https://preview.localhost:3001/requirements?focus=3",
    }]);
  });

  it("reports the new path after removing the fragment", () => {
    // The rewrite goes through the wrapped `pushState`, so the toolbar's path
    // display follows it — a bare `history.pushState` would freeze it.
    const { nav } = fakeNavigation();
    const { toolbar, posted, location } = runInjectedScript({ ...AT }, nav);
    // The stub does not update `location` for us; the script's report reads it.
    const advance = () => { location.hash = ""; };

    advance();
    toolbar("navigate", { url: "https://preview.localhost:3001/requirements?focus=3" });

    expect(posted.filter((m) => m.type === "path").map((m) => m.path))
      .toEqual(["/requirements?focus=3#req-3", "/requirements?focus=3"]);
  });

  it("changes the query on the same page in place, and tells the router", () => {
    // Cross-document by default, so this used to reload. These previews are
    // dev tools the agent itself built and route with the History API, so the
    // rewrite plus a `popstate` re-renders them in place instead.
    const { nav, calls } = fakeNavigation();
    const { toolbar, assigned, pushed, dispatched } = runInjectedScript({ ...AT }, nav);

    toolbar("navigate", { url: "https://preview.localhost:3001/requirements?focus=7#req-7" });

    expect(assigned).toEqual([]);
    expect(calls).toEqual([]);
    expect(pushed).toEqual([[null, "", "https://preview.localhost:3001/requirements?focus=7#req-7"]]);
    // popstate is what the router listens on; hashchange is fired too because
    // the fragment moved as well, and a page may key off either (req 11).
    expect(dispatched).toEqual([
      { type: "popstate", state: null },
      {
        type: "hashchange",
        oldURL: "https://preview.localhost:3001/requirements?focus=3#req-3",
        newURL: "https://preview.localhost:3001/requirements?focus=7#req-7",
      },
    ]);
  });

  it("fires only popstate when the query moves but the fragment does not", () => {
    const { nav } = fakeNavigation();
    const { toolbar, dispatched } = runInjectedScript({ ...AT }, nav);

    toolbar("navigate", { url: "https://preview.localhost:3001/requirements?focus=7#req-3" });

    expect(dispatched).toEqual([{ type: "popstate", state: null }]);
  });

  it("still performs a real navigation to a different path", () => {
    // The line sits at the path: a different one is plausibly a different
    // document, where a rewrite would leave stale content under a new URL.
    const { nav, calls } = fakeNavigation();
    const { toolbar, assigned, pushed } = runInjectedScript({ ...AT }, nav);

    toolbar("navigate", { url: "https://preview.localhost:3001/orders/8842" });

    expect(calls).toEqual(["navigate:https://preview.localhost:3001/orders/8842"]);
    expect(assigned).toEqual([]);
    expect(pushed).toEqual([]);
  });

  it("falls back to location.assign without the Navigation API", () => {
    const { toolbar, assigned } = runInjectedScript({ ...AT }, undefined);

    toolbar("navigate", { url: "https://preview.localhost:3001/orders/8842" });

    expect(assigned).toEqual(["https://preview.localhost:3001/orders/8842"]);
  });

  it("swallows a rejected navigation instead of spilling it into the app's console", async () => {
    const rejections: unknown[] = [];
    const onRejection = (r: unknown) => rejections.push(r);
    process.on("unhandledRejection", onRejection);
    const { nav } = fakeNavigation({ rejectWith: "AbortError" });
    const { toolbar } = runInjectedScript({ ...AT }, nav);

    toolbar("navigate", { url: "https://preview.localhost:3001/orders/8842" });
    await new Promise((resolve) => setImmediate(resolve));
    process.off("unhandledRejection", onRejection);

    expect(rejections).toEqual([]);
  });

  it("refuses a destination off the preview's own origin", () => {
    const { nav, calls } = fakeNavigation();
    const { toolbar, assigned } = runInjectedScript({ ...AT }, nav);

    toolbar("navigate", { url: "https://evil.example/x" });

    expect(assigned).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("ignores an unusable or absent url rather than throwing", () => {
    const { nav, calls } = fakeNavigation();
    const { toolbar, assigned } = runInjectedScript({ ...AT }, nav);

    toolbar("navigate", {});
    toolbar("navigate", { url: 42 });

    expect(assigned).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("ignores toolbar commands that did not come from the embedding window", () => {
    // The commands drive this frame's history and location; only the window
    // ShipIt renders us in gets to send them.
    const { nav, calls } = fakeNavigation();
    const { toolbar, assigned, traversed } = runInjectedScript({ ...AT }, nav);

    const stranger = { postMessage: () => {} };
    toolbar("navigate", { url: "https://preview.localhost:3001/orders/8842" }, stranger);
    toolbar("reload", {}, stranger);
    toolbar("back", {}, stranger);

    expect(assigned).toEqual([]);
    expect(calls).toEqual([]);
    expect(traversed).toEqual([]);
  });
});

describe("injected preview script — home navigation", () => {
  // The toolbar's Home button sends the ordinary `navigate` command with the
  // preview's root URL, so what it does is entirely decided in here. These pin
  // the four shapes the button relies on.
  const ROOT = "https://preview.localhost:3001/";

  it("performs a real navigation to root from a different path", () => {
    const { nav, calls } = fakeNavigation();
    const { toolbar, assigned, pushed } = runInjectedScript(
      { pathname: "/orders/8842", search: "?tab=open", hash: "" }, nav,
    );

    toolbar("navigate", { url: ROOT });

    expect(calls).toEqual([`navigate:${ROOT}`]);
    expect(assigned).toEqual([]);
    expect(pushed).toEqual([]);
  });

  it("does nothing when the preview is already at root", () => {
    // Home must not reload the front page for its own sake — the destination
    // is where the page already is, so the script drops it.
    const { nav, calls } = fakeNavigation();
    const { toolbar, assigned, pushed, dispatched } = runInjectedScript(
      { pathname: "/", search: "", hash: "" }, nav,
    );

    toolbar("navigate", { url: ROOT });

    expect(calls).toEqual([]);
    expect(assigned).toEqual([]);
    expect(pushed).toEqual([]);
    expect(dispatched).toEqual([]);
  });

  it("drops a query on the root path in place, and tells the router", () => {
    // Same path, so this is the page the user is already on: a rewrite plus a
    // popstate re-renders it rather than tearing the app down.
    const { nav, calls } = fakeNavigation();
    const { toolbar, assigned, pushed, dispatched } = runInjectedScript(
      { pathname: "/", search: "?tab=open", hash: "" }, nav,
    );

    toolbar("navigate", { url: ROOT });

    expect(calls).toEqual([]);
    expect(assigned).toEqual([]);
    expect(pushed).toEqual([[null, "", ROOT]]);
    expect(dispatched).toEqual([{ type: "popstate", state: null }]);
  });

  it("returns a hash router to its root in place", () => {
    // A hash router's route lives in the fragment, so going home is a fragment
    // REMOVAL — the one same-document case the browser provides no path for.
    const { nav, calls } = fakeNavigation();
    const { toolbar, assigned, pushed, dispatched } = runInjectedScript(
      { pathname: "/", search: "", hash: "#/orders" }, nav,
    );

    toolbar("navigate", { url: ROOT });

    expect(calls).toEqual([]);
    expect(assigned).toEqual([]);
    expect(pushed).toEqual([[null, "", ROOT]]);
    expect(dispatched).toEqual([{
      type: "hashchange",
      oldURL: "https://preview.localhost:3001/#/orders",
      newURL: ROOT,
    }]);
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
