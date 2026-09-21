// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://11111111-1111-1111-1111-111111111111--3000.localhost:8080/app" }

/**
 * Asking ShipIt to start the service an embed names
 * (docs/313-embedded-preview-services req 5). The page says what it wants once
 * the embed is on screen; every other check is ShipIt's.
 *
 * The stubs are installed by an injected script rather than from test code,
 * because a script jsdom executes does not share this module's global object:
 * `parent` and `IntersectionObserver` must be replaced in the world the
 * resolver itself runs in. Results come back through the shared DOM.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { EMBED_RESOLVER_SOURCE } from "./bootstrap.js";

const SETUP = `
  window.__posted = [];
  window.__observers = [];
  Object.defineProperty(window, "parent", {
    configurable: true,
    value: { postMessage: function (message) { window.__posted.push(message); } },
  });
  window.IntersectionObserver = function (callback) {
    this.callback = callback;
    this.observed = [];
    this.disconnected = false;
    window.__observers.push(this);
  };
  window.IntersectionObserver.prototype.observe = function (element) { this.observed.push(element); };
  window.IntersectionObserver.prototype.disconnect = function () { this.disconnected = true; };
  window.__watcherFor = function (element) {
    for (var i = window.__observers.length - 1; i >= 0; i--) {
      if (window.__observers[i].observed.indexOf(element) >= 0) return window.__observers[i];
    }
    return null;
  };
  window.__report = function () {
    document.getElementById("state").textContent = JSON.stringify({
      posted: window.__posted,
      observers: window.__observers.length,
      staleDisconnected: window.__stale ? window.__stale.disconnected : null,
    });
  };
`;

interface State {
  posted: { source?: string; type?: string; name?: string }[];
  observers: number;
  staleDisconnected: boolean | null;
}

function run(js: string): void {
  const script = document.createElement("script");
  script.textContent = js;
  document.head.appendChild(script);
}

function install(ports: Record<string, number> = { assetgen: 5173, web: 3000 }): void {
  const script = document.createElement("script");
  script.setAttribute("data-shipit-services", JSON.stringify(ports));
  script.textContent = EMBED_RESOLVER_SOURCE;
  document.head.appendChild(script);
}

function addIframe(src: string, id: string): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.id = id;
  frame.setAttribute("src", src);
  document.body.appendChild(frame);
  return frame;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function state(): State {
  run("window.__report()");
  return JSON.parse(document.getElementById("state")?.textContent ?? "{}") as State;
}

/** Report the element as on screen, the way a real observer would. */
function intersect(id: string): void {
  run(`(function(){
    var el = document.getElementById(${JSON.stringify(id)});
    var w = window.__watcherFor(el);
    if (w) w.callback([{ isIntersecting: true, target: el }]);
  })()`);
}

const started = (name: string) => ({
  source: "shipit-preview",
  type: "embed_start_service",
  name,
});

describe("embed start requests", () => {
  beforeEach(() => {
    const root = document.createElement("html");
    root.appendChild(document.createElement("head"));
    root.appendChild(document.createElement("body"));
    const state = document.createElement("pre");
    state.id = "state";
    root.lastChild?.appendChild(state);
    document.replaceChild(root, document.documentElement);
    run(SETUP);
  });

  it("asks only once the embed is on screen", async () => {
    install();
    addIframe("shipit-preview://assetgen/e.html", "f");
    await settle();

    expect(state().posted).toEqual([]);
    expect(state().observers).toBe(1);

    intersect("f");

    expect(state().posted).toEqual([started("assetgen")]);
  });

  it("asks once for a service two embeds on the page name", async () => {
    install();
    addIframe("shipit-preview://assetgen/a.html", "a");
    addIframe("shipit-preview://assetgen/b.html", "b");
    await settle();

    intersect("a");
    intersect("b");

    expect(state().posted).toEqual([started("assetgen")]);
  });

  // An offscreen iframe pointed at one service and then another would otherwise
  // keep the first observer alive and start a service never shown under any
  // address.
  it("does not start a service an offscreen embed was retargeted away from", async () => {
    install();
    const frame = addIframe("shipit-preview://assetgen/e.html", "f");
    await settle();
    run('window.__stale = window.__watcherFor(document.getElementById("f"))');

    frame.setAttribute("src", "shipit-preview://web/e.html");
    await settle();

    expect(state().staleDisconnected).toBe(true);
    intersect("f");

    expect(state().posted).toEqual([started("web")]);
  });

  it("ignores a stale observer that fires anyway", async () => {
    install();
    const frame = addIframe("shipit-preview://assetgen/e.html", "f");
    await settle();
    run('window.__stale = window.__watcherFor(document.getElementById("f"))');

    frame.setAttribute("src", "shipit-preview://web/e.html");
    await settle();
    run(`(function(){
      var el = document.getElementById("f");
      window.__stale.callback([{ isIntersecting: true, target: el }]);
    })()`);

    expect(state().posted).toEqual([]);
  });

  it("asks for nothing when the address never resolved", async () => {
    install();
    addIframe("shipit-preview://nope/e.html", "f");
    await settle();
    intersect("f");

    expect(state().posted).toEqual([]);
    expect(state().observers).toBe(0);
  });
});
