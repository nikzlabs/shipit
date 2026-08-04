/**
 * Seed the dogfood inner ShipIt with a reproducible set of repos (docs/131).
 *
 * The ShipIt-in-ShipIt loop (docs/118) runs an inner orchestrator as the `dev`
 * Compose service. Its state lives in the gitignored `.inner-shipit/`, so every
 * fresh outer session starts from an empty slate: add a repo, wait for it to
 * clone, and only then is there something to test against. This script closes
 * that gap — after the inner orch is healthy it adds and trusts the repos named
 * in `scripts/dogfood-seed.json`, so the inner UI comes up with at least one
 * repo ready to work in (req 1).
 *
 * Seeding is *adding a repo*, not creating a session. `POST /api/repos` clones
 * the bare cache, flips the repo to `ready` and then warms a session for it on
 * its own, so opening the repo in the inner UI is one instant click. The trust
 * call is not optional: a repo added by URL is untrusted, and every agent
 * dispatch opens with the trust gate (403 `repository_untrusted`), so without it
 * seeding "works" and then driving the inner agent fails on first use.
 *
 * Plain Node, no dependencies and no build step — it is launched from the `dev`
 * service's `command:` alongside the orch itself.
 *
 * Contract this script keeps (from docs/131 requirements.md):
 *   - req 3: `DOGFOOD_SEED=0` disables it entirely.
 *   - req 4: repos already registered and `ready` are skipped, so a restart
 *     re-does nothing and duplicates nothing.
 *   - req 5: a bad entry never wedges the dev service — every failure is logged
 *     and the remaining entries still get their turn. Always exits 0.
 *   - req 6: it never blocks the inner UI; compose backgrounds it and Vite comes
 *     up independently.
 *   - req 7: a missing GitHub login is reported as such, rather than showing up
 *     as repos that silently never appear.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Default fixture. Committed, so what gets seeded is the same for everyone (req 2). */
export const FIXTURE_PATH = path.join(HERE, "dogfood-seed.json");

/** Inner orchestrator. Compose runs it on 4000; Vite proxies /api to it. */
const DEFAULT_BASE_URL = "http://127.0.0.1:4000";

/** Bounded waits — the orch boots behind an `agent.install` gate, and a cold
 *  bare-cache clone of a small repo is seconds, not minutes. */
const HEALTH_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 1_000;

const log = (msg) => { console.log(msg); };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Compare two remote URLs the way the orchestrator's repo store does, so a
 * fixture entry written without `.git` still matches a stored `…/repo.git`.
 * Mirrors `canonicalRepoKey` in `src/server/orchestrator/git-utils.ts`.
 */
export function canonicalRepoKey(url) {
  const trimmed = (url ?? "").trim();
  try {
    const u = new URL(trimmed);
    const p = u.pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
    return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${p}`;
  } catch {
    return trimmed.toLowerCase().replace(/\/+$/, "").replace(/\.git$/i, "");
  }
}

/**
 * Read the fixture. A missing or malformed file is not an error worth failing
 * the dev service over — it just means nothing to seed (req 5).
 */
export async function readFixture(fixturePath = FIXTURE_PATH) {
  let raw;
  try {
    raw = await readFile(fixturePath, "utf8");
  } catch {
    log(`no fixture at ${fixturePath} — nothing to seed`);
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    const repos = Array.isArray(parsed?.repos) ? parsed.repos : [];
    return repos
      .map((entry) => (typeof entry === "string" ? entry : entry?.url))
      .filter((url) => typeof url === "string" && url.trim().length > 0)
      .map((url) => url.trim());
  } catch (err) {
    log(`fixture ${fixturePath} is not valid JSON (${errorMessage(err)}) — nothing to seed`);
    return [];
  }
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Thin JSON client. Returns `{ ok, status, body }` rather than throwing on a
 * non-2xx, because every caller here treats an HTTP error as "log it and carry
 * on with the next repo" (req 5).
 */
async function api(fetchImpl, baseUrl, method, route, body) {
  const res = await fetchImpl(`${baseUrl}${route}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    // Empty or non-JSON body — the status is all we need.
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

/**
 * Wait for the inner orch to answer. `GET /api/bootstrap` is the probe: it is
 * registered by the same `buildApp()` call as everything else, so a 200 there
 * means the API surface this script drives is live. Its payload also carries
 * `githubStatus`, which is how we detect req 7's not-authenticated case without
 * a second round-trip.
 */
export async function waitForOrch(deps, opts = {}) {
  const { fetchImpl, baseUrl } = deps;
  const timeoutMs = opts.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const now = opts.now ?? (() => Date.now());
  const deadline = now() + timeoutMs;
  let lastError = "no response";
  while (now() < deadline) {
    try {
      const res = await api(fetchImpl, baseUrl, "GET", "/api/bootstrap");
      if (res.ok) return res.body ?? {};
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = errorMessage(err);
    }
    await sleep(opts.pollIntervalMs ?? POLL_INTERVAL_MS);
  }
  throw new Error(`inner orchestrator did not come up within ${timeoutMs}ms (${lastError})`);
}

/** Poll `GET /api/repos` until this repo reports `ready`. */
async function waitForReady(deps, url, opts = {}) {
  const { fetchImpl, baseUrl } = deps;
  const timeoutMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const now = opts.now ?? (() => Date.now());
  const key = canonicalRepoKey(url);
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const res = await api(fetchImpl, baseUrl, "GET", "/api/repos");
    const repo = (res.body?.repos ?? []).find((r) => canonicalRepoKey(r.url) === key);
    if (repo?.status === "ready") return repo;
    await sleep(opts.pollIntervalMs ?? POLL_INTERVAL_MS);
  }
  throw new Error(`clone did not finish within ${timeoutMs}ms`);
}

/**
 * Seed one repo: add → wait for the clone → trust. Returns the outcome rather
 * than throwing; the caller logs it and moves to the next entry.
 */
async function seedRepo(deps, url, opts) {
  const { fetchImpl, baseUrl } = deps;
  const added = await api(fetchImpl, baseUrl, "POST", "/api/repos", { url });
  if (!added.ok) {
    return { url, outcome: "failed", detail: added.body?.error ?? `HTTP ${added.status}` };
  }
  // The clone runs in the background; the repo is only usable once it's `ready`.
  await waitForReady(deps, url, opts);
  // Untrusted repos fail every agent dispatch with 403 `repository_untrusted`,
  // so trust is part of seeding, not a separate concern (docs/178).
  const trusted = await api(fetchImpl, baseUrl, "POST", "/api/repos/trust", { url });
  if (!trusted.ok) {
    return { url, outcome: "failed", detail: `trust failed: ${trusted.body?.error ?? `HTTP ${trusted.status}`}` };
  }
  return { url, outcome: "seeded" };
}

/**
 * Run the whole seed. Exported (and dependency-injected) so the unit tests can
 * drive it with a fake `fetch` instead of a live orchestrator.
 */
export async function seed(deps = {}, opts = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const baseUrl = deps.baseUrl ?? process.env.SEED_ORCH_URL ?? DEFAULT_BASE_URL;
  const env = deps.env ?? process.env;

  if (env.DOGFOOD_SEED === "0") {
    log("DOGFOOD_SEED=0 — skipping");
    return { skipped: true, results: [] };
  }

  const urls = await readFixture(opts.fixturePath ?? FIXTURE_PATH);
  if (urls.length === 0) return { skipped: true, results: [] };

  const client = { fetchImpl, baseUrl };
  let bootstrap;
  try {
    bootstrap = await waitForOrch(client, opts);
  } catch (err) {
    // Nothing to do but say so — the inner UI is unaffected either way (req 6).
    log(errorMessage(err));
    return { skipped: true, results: [] };
  }

  // req 7 — make "no GitHub login" a legible reason rather than repos that
  // silently never appear. Public repos still clone anonymously, so this is a
  // warning, not a stop.
  if (bootstrap?.githubStatus?.authenticated === false) {
    log(
      "GitHub is not authenticated in the inner ShipIt — set the GITHUB_TOKEN "
      + "secret in the outer ShipIt's Settings → Secrets. Public repos will "
      + "still clone; private ones will fail.",
    );
  }

  // req 4 — the registered-repo list is the idempotency key. A repo that is
  // already there and `ready` is left completely alone, so restarting the dev
  // service re-clones nothing and duplicates nothing.
  let existing = [];
  try {
    const res = await api(fetchImpl, baseUrl, "GET", "/api/repos");
    existing = res.body?.repos ?? [];
  } catch (err) {
    log(`could not list repos (${errorMessage(err)}) — continuing`);
  }
  const alreadyReady = new Set(
    existing.filter((r) => r.status === "ready").map((r) => canonicalRepoKey(r.url)),
  );

  const results = [];
  for (const url of urls) {
    if (alreadyReady.has(canonicalRepoKey(url))) {
      log(`${url} — already present`);
      results.push({ url, outcome: "skipped" });
      continue;
    }
    try {
      const result = await seedRepo(client, url, opts);
      log(result.outcome === "seeded" ? `${url} — added and trusted` : `${url} — ${result.detail}`);
      results.push(result);
    } catch (err) {
      // req 5 — one bad entry must not stop the others.
      log(`${url} — ${errorMessage(err)}`);
      results.push({ url, outcome: "failed", detail: errorMessage(err) });
    }
  }

  const seeded = results.filter((r) => r.outcome === "seeded").length;
  const failed = results.filter((r) => r.outcome === "failed").length;
  log(`done — ${seeded} seeded, ${results.length - seeded - failed} already present, ${failed} failed`);
  return { skipped: false, results };
}

// Entry point. Never exits non-zero: a seeding failure is a degraded dogfood
// loop, not a broken dev service (req 5).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  seed().catch((err) => {
    log(`unexpected failure: ${errorMessage(err)}`);
  });
}
