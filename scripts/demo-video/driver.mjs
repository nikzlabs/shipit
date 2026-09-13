#!/usr/bin/env node
// Playwright driver for the demo video — docs/296 plan §4.
//
// Drives a ShipIt instance the way a user would (req 5): a session is started
// by clicking "New session", prompts are typed into the composer and sent with
// its button, panes are switched by clicking their tabs. Everything before the
// browser opens is setup over HTTP and is not on camera. Waits are on STATE
// (the UI, or `GET /api/sessions/:id/status`), never on the clock; a wait that
// exceeds the ceiling aborts with the beat id and a screenshot.
//
// Usage:
//   node driver.mjs --instance <url> --scenario <dir> --out <dir>
//                   [--mode record|replay] [--wait-ceiling <seconds>] [--headed]
//
// Reads <scenario>/storyboard.json (plan §3). Writes <out>/recording.webm,
// <out>/beats.json ([{ id, actionAt, readyAt }], seconds on the driver's clock)
// and <out>/run.json (mode, viewport, `anchor.wallAt` — the moment the cut
// step finds in the footage to map that clock onto the video's, plan §4).
//
// Before anything is recorded, both modes verify the demo repo pin (`git
// ls-remote <repo.url> HEAD` must equal `repo.commit`); replay mode also
// requires `proxyUrl` in the storyboard and a 200 from `HEAD <proxyUrl>/api/hello`
// — a replay against a proxy that is not there would be a live take by
// accident. Which side of the proxy a take lands on is otherwise the proxy's
// business (plan §2); `--mode` is written to run.json.
//
// Environment:
//   PLAYWRIGHT_BROWSERS_PATH  where `npx playwright install chromium` put the
//                             browser. Inside a ShipIt session that is
//                             /persist/ms-playwright (the baked
//                             /opt/playwright-browsers holds an older build the
//                             pinned `playwright` package will not launch).
//   DEMO_CHROMIUM             optional executablePath override, for a host with
//                             a Chromium of its own.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { SELECTORS as S } from "./selectors.mjs";
import { beatSlices } from "./cut-plan.mjs";

const POLL_MS = 250;
const DEFAULT_WAIT_CEILING_S = 600;
const DEFAULT_TYPING_CPS = 30;
/** Steps for a pointer glide; more steps = smoother, slower. */
const GLIDE_STEPS = 24;
/**
 * How long the black splash is on screen before the driver navigates to the
 * instance. The cut step finds the splash with blackdetect (`d=0.08`), so it
 * needs to be at least a few frames long at 25 fps; a quarter second is
 * comfortably that and costs nothing, since nothing before the first beat's
 * action is kept.
 */
const SPLASH_MS = 500;

// ── CLI ──────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const opts = {
    instance: null,
    scenario: null,
    out: null,
    mode: "replay",
    waitCeilingS: DEFAULT_WAIT_CEILING_S,
    headed: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case "--instance": opts.instance = next().replace(/\/+$/, ""); break;
      case "--scenario": opts.scenario = path.resolve(next()); break;
      case "--out": opts.out = path.resolve(next()); break;
      case "--mode": {
        const m = next();
        if (m !== "record" && m !== "replay") throw new Error("--mode must be record or replay");
        opts.mode = m;
        break;
      }
      case "--wait-ceiling": opts.waitCeilingS = Number(next()); break;
      case "--headed": opts.headed = true; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  for (const k of ["instance", "scenario", "out"]) {
    if (!opts[k]) throw new Error(`--${k} is required`);
  }
  if (!Number.isFinite(opts.waitCeilingS) || opts.waitCeilingS <= 0) {
    throw new Error("--wait-ceiling must be a positive number of seconds");
  }
  return opts;
}

export function readStoryboard(scenarioDir) {
  const file = path.join(scenarioDir, "storyboard.json");
  const sb = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!sb.repo?.url) throw new Error(`${file}: repo.url is required`);
  if (!/^[0-9a-f]{40}$/.test(sb.repo.commit ?? "")) throw new Error(`${file}: repo.commit must be a full 40-hex SHA (the pin the driver verifies)`);
  if (!sb.viewport?.width || !sb.viewport?.height) throw new Error(`${file}: viewport {width,height} is required`);
  if (!Array.isArray(sb.beats) || sb.beats.length === 0) throw new Error(`${file}: beats[] is required`);
  const cps = sb.pace?.typingCharsPerSecond;
  if (cps !== undefined && (typeof cps !== "number" || !(cps > 0))) throw new Error(`${file}: pace.typingCharsPerSecond must be a positive number`);
  const ids = new Set();
  for (const b of sb.beats) {
    if (!b.id) throw new Error(`${file}: every beat needs an id`);
    if (ids.has(b.id)) throw new Error(`${file}: duplicate beat id ${b.id}`);
    ids.add(b.id);
    if (b.type !== undefined && b.click !== undefined) throw new Error(`${file}: beat ${b.id} has both type and click`);
    if (!Array.isArray(b.wait ?? [])) throw new Error(`${file}: beat ${b.id}: wait must be a list`);
    for (const k of ["lead", "hold"]) {
      if (typeof b[k] !== "number" || !(b[k] >= 0)) throw new Error(`${file}: beat ${b.id}: ${k} must be a non-negative number of seconds`);
    }
  }
  return sb;
}

/**
 * The driver-clock moment the footage of the beat just completed ends: the
 * later of its lead (`actionAt + lead`; for a beat with no action, from where
 * the previous hold ended) and its hold (`readyAt + hold`). The driver keeps
 * recording until then before it acts again or closes the context, so both
 * slices the cut keeps (plan §5) exist as footage — the hold is the result
 * held still, not the next beat's typing. The same slice math as the cut
 * (`beatSlices`), so the two cannot disagree about where a slice ends.
 *
 * Consequence: whenever a turn outlasts its `lead` (`readyAt ≥ actionAt +
 * lead`), the lead and hold slices are disjoint, and since the next action
 * starts at or after this moment no slice of one beat overlaps another — so
 * the cut keeps exactly Σ(lead + hold) seconds.
 */
export function beatFootageEnd(beatLog, storyboardBeats) {
  if (!Array.isArray(beatLog) || beatLog.length === 0) throw new Error("beat log is empty");
  const last = beatLog[beatLog.length - 1];
  return beatSlices(beatLog, storyboardBeats)
    .filter((s) => s.beat === last.id)
    .reduce((end, s) => Math.max(end, s.end), 0);
}

const log = (msg) => { process.stderr.write(`[driver] ${msg}\n`); };

// ── HTTP setup (unrecorded) ──────────────────────────────────────────────────

async function api(base, method, route, body) {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* status is enough */ }
  return { ok: res.ok, status: res.status, body: parsed };
}

/** Poll `fn` until it returns a truthy value or the deadline passes. */
async function until(fn, { ceilingMs, what }) {
  const deadline = Date.now() + ceilingMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  const detail = last instanceof Error ? ` (last error: ${last.message})` : "";
  throw new WaitCeilingError(`${what} did not hold within ${Math.round(ceilingMs / 1000)}s${detail}`);
}

class WaitCeilingError extends Error {}

function canonicalRepoKey(url) {
  const trimmed = (url ?? "").trim();
  try {
    const u = new URL(trimmed);
    return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "").replace(/\.git$/i, "")}`;
  } catch {
    return trimmed.toLowerCase().replace(/\/+$/, "").replace(/\.git$/i, "");
  }
}

/** Mirrors `parseRepoName` in `src/client/utils/repo-label.ts` — the sidebar group's title. */
function repoDisplayName(url) {
  let label;
  const gh = /github\.com[/:]([^/]+\/[^/.]+)/.exec(url);
  if (gh) label = gh[1];
  else {
    try {
      const u = new URL(url);
      label = (u.hostname + u.pathname).replace(/\.git$/, "");
    } catch {
      label = url.replace(/\.git$/, "");
    }
  }
  const i = label.lastIndexOf("/");
  return i >= 0 ? label.slice(i + 1) : label;
}

/**
 * `git ls-remote <url> HEAD` on the driver host (git is there; `file://` URLs
 * work). The pin is what makes a take repeatable (req 3): a demo repo that
 * drifted from `repo.commit` would replay a cassette against different files.
 */
export function verifyRepoPin(repo) {
  let out;
  try {
    out = execFileSync("git", ["ls-remote", repo.url, "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    throw new Error(`git ls-remote ${repo.url} failed: ${(err.stderr ?? err.message).toString().trim()}`);
  }
  const head = out.split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(head ?? "")) throw new Error(`git ls-remote ${repo.url} returned no HEAD`);
  if (head !== repo.commit) {
    throw new Error(`demo repo ${repo.url} is at ${head}, storyboard pins ${repo.commit} — rebuild it (make-demo-repo.sh) or update the pin`);
  }
  return head;
}

/** Replay needs the proxy answering before anything is recorded (plan §2: `HEAD /api/hello` → 200). */
async function verifyProxy(sb) {
  if (!sb.proxyUrl) throw new Error("--mode replay needs proxyUrl in the storyboard: the address the session's Claude CLI reaches the proxy at");
  const url = `${sb.proxyUrl.replace(/\/+$/, "")}/api/hello`;
  let res;
  try {
    res = await fetch(url, { method: "HEAD" });
  } catch (err) {
    throw new Error(`replay proxy not reachable: HEAD ${url}: ${err.cause?.message ?? err.message}`);
  }
  if (res.status !== 200) throw new Error(`replay proxy at ${url} answered ${res.status}, expected 200`);
  log(`replay proxy answering at ${sb.proxyUrl}`);
}

async function setup(opts, sb) {
  const base = opts.instance;
  const ceilingMs = opts.waitCeilingS * 1000;
  log(`demo repo pinned at ${verifyRepoPin(sb.repo)}`);
  if (opts.mode === "replay") await verifyProxy(sb);
  log(`waiting for ${base}/api/bootstrap`);
  await until(async () => (await api(base, "GET", "/api/bootstrap")).ok, { ceilingMs, what: "GET /api/bootstrap" });

  // Add + trust — the same calls scripts/seed-inner-sessions.js makes.
  const url = sb.repo.url;
  const added = await api(base, "POST", "/api/repos", { url });
  if (!added.ok) throw new Error(`POST /api/repos failed: ${added.body?.error ?? `HTTP ${added.status}`}`);
  const key = canonicalRepoKey(url);
  const repo = await until(async () => {
    const res = await api(base, "GET", "/api/repos");
    const r = (res.body?.repos ?? []).find((x) => canonicalRepoKey(x.url) === key);
    return r?.status === "ready" ? r : null;
  }, { ceilingMs, what: `clone of ${url}` });
  const trusted = await api(base, "POST", "/api/repos/trust", { url });
  if (!trusted.ok) throw new Error(`POST /api/repos/trust failed: ${trusted.body?.error ?? `HTTP ${trusted.status}`}`);
  log(`repo ready and trusted: ${repo.url}`);

  if (sb.settings && Object.keys(sb.settings).length > 0) {
    const saved = await api(base, "PUT", "/api/settings", sb.settings);
    if (!saved.ok) throw new Error(`PUT /api/settings failed: ${saved.body?.error ?? `HTTP ${saved.status}`}`);
    log(`settings applied: ${JSON.stringify(sb.settings)}`);
  }

  // Optional model pin, applied to the repo's warm session before it is claimed
  // on camera. Needed only where the install's first eligible model is not the
  // one the take should run on (phase 1: the dogfood instance's default is an
  // Anthropic subscription route the demo cannot use).
  if (sb.model) {
    const warmId = await until(async () => {
      const res = await api(base, "GET", "/api/repos");
      const r = (res.body?.repos ?? []).find((x) => canonicalRepoKey(x.url) === key);
      return r?.warmSessionId ?? null;
    }, { ceilingMs, what: "a warm session for the repo" });
    await pinModel(base, warmId, sb.model, ceilingMs);
    log(`model pinned on warm session ${warmId}: ${JSON.stringify(sb.model)}`);
  }
}

/** WS `set_model` on a session; resolves on the server's `model_selection_changed`. */
function pinModel(base, sessionId, model, ceilingMs) {
  const wsUrl = `${base.replace(/^http/, "ws")}/ws/sessions/${sessionId}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { ws.close(); reject(new Error(`set_model on ${sessionId} got no confirmation`)); }, ceilingMs);
    const done = (err) => { clearTimeout(timer); ws.close(); err ? reject(err) : resolve(); };
    ws.addEventListener("open", () => {
      const { agent: _agent, ...selection } = model;
      ws.send(JSON.stringify({ type: "set_model", ...selection }));
    });
    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.type === "model_selection_changed" && msg.sessionId === sessionId) {
        if (msg.notice) log(`set_model notice: ${msg.notice}`);
        done(msg.modelId === model.model ? undefined : new Error(`set_model landed on ${msg.modelId}, not ${model.model}`));
      } else if (msg.type === "error") {
        done(new Error(`set_model refused: ${msg.message}`));
      }
    });
    ws.addEventListener("error", () => done(new Error(`WebSocket to ${wsUrl} failed`)));
  });
}

// ── Cursor overlay (req 11) ──────────────────────────────────────────────────

/** Injected before any page script: a dot that follows the pointer and pulses on mousedown. */
function cursorOverlayScript() {
  const ID = "__demo_cursor";
  const style = `
#${ID}{position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;
  background:rgba(20,20,20,.55);border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.35),0 2px 6px rgba(0,0,0,.35);
  pointer-events:none;z-index:2147483647;transform:translate(-200px,-200px);transition:transform 40ms linear;}
#${ID}::after{content:"";position:absolute;inset:-2px;border-radius:50%;border:2px solid rgba(255,255,255,.9);
  opacity:0;transform:scale(1);}
#${ID}.down::after{animation:${ID}-pulse 420ms ease-out;}
@keyframes ${ID}-pulse{0%{opacity:.9;transform:scale(1)}100%{opacity:0;transform:scale(3)}}`;
  return `(() => {
    if (window.top !== window) return;
    const ID = ${JSON.stringify(ID)};
    const ensure = () => {
      if (document.getElementById(ID)) return document.getElementById(ID);
      const st = document.createElement("style"); st.textContent = ${JSON.stringify(style)};
      const dot = document.createElement("div"); dot.id = ID;
      (document.head ?? document.documentElement).appendChild(st);
      document.documentElement.appendChild(dot);
      return dot;
    };
    window.addEventListener("mousemove", (e) => {
      ensure().style.transform = "translate(" + e.clientX + "px," + e.clientY + "px)";
    }, { capture: true, passive: true });
    window.addEventListener("mousedown", () => {
      const dot = ensure(); dot.classList.remove("down"); void dot.offsetWidth; dot.classList.add("down");
    }, { capture: true, passive: true });
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ensure); else ensure();
  })();`;
}

// ── Gestures ─────────────────────────────────────────────────────────────────

class Driver {
  constructor(opts, sb, page, recordingStart) {
    this.opts = opts;
    this.sb = sb;
    this.page = page;
    this.recordingStart = recordingStart;
    this.cursor = sb.cursor !== false;
    this.pointer = { x: sb.viewport.width / 2, y: sb.viewport.height / 2 };
    this.sessionId = null;
    this.claimed = false;
    this.beats = [];
    this.ceilingMs = opts.waitCeilingS * 1000;
    /** Assistant message groups in the transcript when the last prompt was sent; null before any send. */
    this.assistantGroupsAtSend = null;
    this.panesClicked = new Set();
  }

  t() { return (Date.now() - this.recordingStart) / 1000; }

  /**
   * Wall-clock wait until the driver's clock reads `target` — deliberately, and
   * only here: this is footage (the hold the cut keeps), not a state wait.
   */
  async recordUntil(target) {
    const ms = (target - this.t()) * 1000;
    if (ms > 0) await this.page.waitForTimeout(ms);
  }

  /** Glide the pointer to the element's centre, then click it (req 11). */
  async click(locator) {
    await locator.waitFor({ state: "visible", timeout: this.ceilingMs });
    const box = await locator.boundingBox();
    if (!box) throw new Error("click target has no box");
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    if (this.cursor) {
      await this.page.mouse.move(x, y, { steps: GLIDE_STEPS });
      this.pointer = { x, y };
    }
    await locator.click();
  }

  async collapseSidebar() {
    const btn = this.page.locator(S.sidebarCollapse);
    if (await btn.count() > 0 && await btn.first().isVisible()) {
      await this.click(btn.first());
      await this.page.locator(S.sidebarExpand).first().waitFor({ state: "visible", timeout: this.ceilingMs });
    }
  }

  async expandSidebar() {
    const btn = this.page.locator(S.sidebarExpand);
    if (await btn.count() > 0 && await btn.first().isVisible()) {
      await this.click(btn.first());
      await this.page.locator(S.sidebarCollapse).first().waitFor({ state: "visible", timeout: this.ceilingMs });
    }
  }

  async switchPane(pane) {
    if (!pane) return;
    const label = S.paneTabLabels[pane];
    if (!label) return; // transcript / pr-card: the chat pane, always on screen
    const tab = this.page.locator(S.paneTab(label)).first();
    if (await tab.count() === 0) throw new Error(`pane "${pane}": no "${label}" tab on this instance`);
    // Click once even when the tab already reads as current: on a local-mode
    // instance the Files tab is *displayed* by coercion while the client's
    // store still says "preview", and the post-commit tree refresh keys off
    // the store (`git-committed.ts`) — so an un-clicked Files tab never
    // updates. A real click writes the store; after that, trust aria-current.
    if ((await tab.getAttribute("aria-current")) === "page" && this.panesClicked.has(pane)) return;
    await this.click(tab);
    this.panesClicked.add(pane);
  }

  // ── click targets ──

  async clickNewSession() {
    const name = repoDisplayName(this.sb.repo.url);
    await this.expandSidebar();
    const collapsedHeader = this.page.locator(S.repoGroupHeader(name, "Expand"));
    if (await collapsedHeader.count() > 0) await this.click(collapsedHeader.first());
    const header = this.page.locator(S.repoGroupHeader(name, "Collapse")).first();
    await header.waitFor({ state: "visible", timeout: this.ceilingMs });
    const group = header.locator("xpath=../..");
    const row = group.locator(S.repoGroupList).locator("button", { hasText: S.newSessionRowText }).first();
    // The browser's own claim response is the honest source of the session id.
    const claim = this.page.waitForResponse(
      (r) => r.url().includes("/claim-session") && r.request().method() === "POST",
      { timeout: this.ceilingMs },
    ).then(async (r) => {
      const body = await r.json().catch(() => null);
      if (body?.sessionId) { this.sessionId = body.sessionId; this.claimed = true; log(`session claimed: ${body.sessionId}`); }
    }).catch((err) => log(`claim response not observed: ${err.message}`));
    await this.click(row);
    // Collapsed for the rest of the take (plan §6): more room, and it hides the
    // AI-generated session title, the one thing that varies between runs.
    await this.collapseSidebar();
    return claim;
  }

  /** The merge button on the active session's card, or null; `enabled` says whether it can be clicked. */
  async mergeButton() {
    const actions = this.page.locator(S.prCardActions).first();
    if (await actions.count() === 0) return null;
    for (const name of S.mergeButtonNames) {
      const btn = actions.getByRole("button", { name, exact: true });
      if (await btn.count() > 0 && await btn.first().isVisible()) return { locator: btn.first(), enabled: await btn.first().isEnabled() };
    }
    return null;
  }

  async clickMerge() {
    const btn = await this.mergeButton();
    if (!btn?.enabled) throw new Error("no enabled merge button on the PR card");
    await this.click(btn.locator);
  }

  async clickTrust() {
    await this.click(this.page.locator(S.trustAccept).first());
  }

  assistantGroups() {
    return this.page.locator(S.transcript).first().locator(S.assistantMessage).count();
  }

  async typeAndSend(text) {
    const cps = this.sb.pace?.typingCharsPerSecond ?? DEFAULT_TYPING_CPS;
    const input = this.page.locator(S.composerInput).first();
    await this.click(input);
    await input.pressSequentially(text, { delay: 1000 / cps });
    const send = this.page.locator(S.sendButton).first();
    await until(() => send.isEnabled(), { ceilingMs: this.ceilingMs, what: "send button enabled" });
    // The baseline `turn: finished` compares against: the reply to this send
    // is a new assistant group. Counted before the click so a fast turn that
    // is over before the first poll still reads as finished — the transient
    // running state is never required to be observed.
    this.assistantGroupsAtSend = await this.assistantGroups();
    await this.click(send);
  }

  // ── session id ──

  async resolveSessionId() {
    const m = /\/session\/([0-9a-f-]{36})/.exec(this.page.url());
    if (m) this.sessionId = m[1];
    return this.sessionId;
  }

  async status() {
    const id = await this.resolveSessionId();
    if (!id) return null;
    const res = await api(this.opts.instance, "GET", `/api/sessions/${id}/status`);
    return res.ok ? res.body : null;
  }

  // ── wait conditions ──

  async check(cond) {
    const [kind, value] = Object.entries(cond)[0];
    const p = this.page;
    switch (kind) {
      case "turn": {
        const stopVisible = await p.locator(S.stopButton).first().isVisible().catch(() => false);
        const st = await this.status();
        if (value === "running") return stopVisible || st?.running === true;
        if (value === "finished") {
          // A new assistant group since the send, no stop button, and /status
          // idle — three facts about the present, none about a transition the
          // poll might have missed.
          if (this.assistantGroupsAtSend === null) throw new Error("turn: finished waited before any prompt was sent");
          if (stopVisible || st?.running !== false) return false;
          return (await this.assistantGroups()) > this.assistantGroupsAtSend;
        }
        throw new Error(`turn: ${value}?`);
      }
      case "composer": {
        if (value !== "ready") throw new Error(`composer: ${value}?`);
        const input = p.locator(S.composerInput).first();
        if (!(await input.isVisible().catch(() => false))) return false;
        if (!(await input.isEnabled())) return false;
        if ((await input.getAttribute("placeholder")) !== S.composerReadyPlaceholder) return false;
        if (await p.locator(S.trustNotice).count() > 0) return false;
        if (await p.locator(S.sendButton).count() === 0) return false;
        return this.claimed;
      }
      case "transcript_text":
        // Scoped to the transcript: the same words in the composer, the file
        // tree or a PR title must not satisfy a wait on the agent's reply.
        return (await p.locator(S.transcript).first().getByText(value, { exact: false }).count()) > 0;
      case "file_tree":
        return (await p.locator(S.fileTreeEntry(value)).count()) > 0;
      case "pr_card": {
        // Badge selectors are scoped to the active session's card; the sidebar
        // shows the same badge for every session.
        if (value === "open") return (await p.locator(S.prBadgeOpen).count()) > 0;
        if (value === "merged") return (await p.locator(S.prBadgeMerged).count()) > 0;
        throw new Error(`pr_card: ${value}?`);
      }
      case "merge_button": {
        if (value !== "visible") throw new Error(`merge_button: ${value}?`);
        // "visible" means clickable: the button is rendered disabled while the
        // branch is unsynced or the agent runs, and a hold on that is a hold on
        // nothing the next beat can act on.
        const btn = await this.mergeButton();
        return btn !== null && btn.enabled;
      }
      case "preview_text": {
        // Not satisfiable on a local-mode instance: there is no preview there (req 13).
        const frame = p.locator(S.previewFrame).first();
        if (await frame.count() === 0) return false;
        const content = await frame.contentFrame();
        if (!content) return false;
        return (await content.getByText(value, { exact: false }).count()) > 0;
      }
      default:
        throw new Error(`unknown wait condition: ${kind}`);
    }
  }

  async waitAll(beat) {
    const conds = beat.wait ?? [];
    if (conds.length === 0) return;
    await until(async () => {
      for (const c of conds) if (!(await this.check(c))) return false;
      return true;
    }, { ceilingMs: this.ceilingMs, what: `beat ${beat.id}: ${JSON.stringify(conds)}` });
  }

  async runBeat(beat) {
    log(`beat ${beat.id}: ${beat.type !== undefined ? `type ${JSON.stringify(beat.type)}` : beat.click ? `click ${beat.click}` : "(no action)"}`);
    await this.switchPane(beat.pane);
    let actionAt = null;
    let sentAt;
    let pending = null;
    if (beat.click) {
      actionAt = this.t();
      switch (beat.click) {
        case "new-session": pending = await this.clickNewSession(); break;
        case "merge": await this.clickMerge(); break;
        case "trust": await this.clickTrust(); break;
        default: throw new Error(`beat ${beat.id}: unknown click target ${beat.click}`);
      }
    } else if (beat.type !== undefined) {
      // The action starts at the first keystroke, so the prompt being typed is
      // on camera (req 8a) and `lead` has to cover it; `sentAt` marks the send.
      actionAt = this.t();
      await this.typeAndSend(beat.type);
      sentAt = this.t();
    }
    if (pending) await pending;
    await this.waitAll(beat);
    const readyAt = this.t();
    this.beats.push({ id: beat.id, actionAt, ...(sentAt !== undefined ? { sentAt } : {}), readyAt });
    log(`beat ${beat.id}: ready at ${readyAt.toFixed(2)}s`);
    // The hold is footage: keep recording, still, until every slice the cut
    // will keep of this beat exists (`beatFootageEnd`). Nothing acts on the
    // page until then — the next beat's pane switch and typing come after.
    const footageEnd = beatFootageEnd(this.beats, this.sb.beats);
    if (footageEnd > this.t()) log(`beat ${beat.id}: holding until ${footageEnd.toFixed(2)}s`);
    await this.recordUntil(footageEnd);
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────

export async function run(opts) {
  const sb = readStoryboard(opts.scenario);
  fs.mkdirSync(opts.out, { recursive: true });
  await setup(opts, sb);

  const browser = await chromium.launch({
    headless: !opts.headed,
    ...(process.env.DEMO_CHROMIUM ? { executablePath: process.env.DEMO_CHROMIUM } : {}),
  });
  const context = await browser.newContext({
    viewport: sb.viewport,
    recordVideo: { dir: opts.out, size: sb.viewport },
  });
  if (sb.cursor !== false) await context.addInitScript(cursorOverlayScript());

  const recordingStart = Date.now();
  const page = await context.newPage();
  const driver = new Driver(opts, sb, page, recordingStart);
  let video = null;
  let failure = null;
  let anchorWallAt = null;
  let wallDuration = null;
  try {
    // The anchor (plan §4): a black splash, painted and held, then the
    // navigation — the first non-black frame in the recording is the first
    // paint after `anchorWallAt`, so the cut step can put the driver's clock
    // and the video's side by side. Stamped immediately before the goto, and
    // the goto returns on commit, not on load: nothing runs between the stamp
    // and the paint that would widen the gap.
    await page.setContent('<body style="margin:0;background:#000"></body>');
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.waitForTimeout(SPLASH_MS);
    anchorWallAt = driver.t();
    await page.goto(opts.instance, { waitUntil: "commit" });
    if (sb.cursor !== false) await page.mouse.move(driver.pointer.x, driver.pointer.y);
    // Each beat records through its own hold (`runBeat`), so the last beat's
    // hold is on film by the time the loop ends.
    for (const beat of sb.beats) await driver.runBeat(beat);
    await page.screenshot({ path: path.join(opts.out, "final.png") });
  } catch (err) {
    failure = err;
    const beatId = driver.beats.length < sb.beats.length ? sb.beats[driver.beats.length].id : "end";
    const shot = path.join(opts.out, `abort-${beatId}.png`);
    await page.screenshot({ path: shot }).catch(() => {});
    log(`ABORT at beat ${beatId}: ${err.message} — screenshot ${shot}`);
  } finally {
    video = page.video();
    // Measured before the close, not after it: the fallback anchor is
    // `wallDuration − videoDuration`, and shutdown time is not in the file.
    wallDuration = driver.t();
    await context.close();
    await browser.close();
  }

  // beats.json is the bare array the cut step reads (plan §5); the run's
  // metadata sits beside it so the contract stays exactly [{ id, actionAt, readyAt }].
  const beatsFile = path.join(opts.out, "beats.json");
  fs.writeFileSync(beatsFile, JSON.stringify(driver.beats, null, 2) + "\n");
  fs.writeFileSync(path.join(opts.out, "run.json"), JSON.stringify({
    scenario: path.basename(opts.scenario),
    mode: opts.mode,
    viewport: sb.viewport,
    recordedAt: new Date(recordingStart).toISOString(),
    ...(anchorWallAt === null ? {} : { anchor: { wallAt: Number(anchorWallAt.toFixed(3)) } }),
    wallDuration: Number(wallDuration.toFixed(3)),
    completed: driver.beats.length === sb.beats.length,
  }, null, 2) + "\n");

  const recorded = video ? await video.path().catch(() => null) : null;
  const target = path.join(opts.out, "recording.webm");
  if (recorded && fs.existsSync(recorded)) {
    if (path.resolve(recorded) !== target) fs.renameSync(recorded, target);
    log(`video: ${target}`);
  } else {
    log("no video was written");
  }
  log(`beats: ${beatsFile}`);
  if (failure) throw failure;
  return { video: target, beats: beatsFile };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (invokedDirectly) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    log(err.message);
    log("usage: driver.mjs --instance URL --scenario DIR --out DIR [--mode record|replay] [--wait-ceiling S] [--headed]");
    process.exit(2);
  }
  run(opts).then(
    () => process.exit(0),
    (err) => { log(err.stack ?? String(err)); process.exit(err instanceof WaitCeilingError ? 3 : 1); },
  );
}
