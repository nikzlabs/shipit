import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const FIXTURE_PATH = path.join(HERE, "dogfood-seed.json");

const DEFAULT_BASE_URL = "http://127.0.0.1:4000";

const HEALTH_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 1_000;

const log = (msg) => { console.log(msg); };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Match the orchestrator's canonicalRepoKey in git-utils.ts.
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
    // Status is sufficient for non-JSON responses.
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

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

async function seedRepo(deps, url, opts) {
  const { fetchImpl, baseUrl } = deps;
  const added = await api(fetchImpl, baseUrl, "POST", "/api/repos", { url });
  if (!added.ok) {
    return { url, outcome: "failed", detail: added.body?.error ?? `HTTP ${added.status}` };
  }
  await waitForReady(deps, url, opts);
  const trusted = await api(fetchImpl, baseUrl, "POST", "/api/repos/trust", { url });
  if (!trusted.ok) {
    return { url, outcome: "failed", detail: `trust failed: ${trusted.body?.error ?? `HTTP ${trusted.status}`}` };
  }
  return { url, outcome: "seeded" };
}

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
    log(errorMessage(err));
    return { skipped: true, results: [] };
  }

  if (bootstrap?.githubStatus?.authenticated === false) {
    log(
      "GitHub is not authenticated in the inner ShipIt — set the GITHUB_TOKEN "
      + "secret in the outer ShipIt's Settings → Secrets. Public repos will "
      + "still clone; private ones will fail.",
    );
  }

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
      log(`${url} — ${errorMessage(err)}`);
      results.push({ url, outcome: "failed", detail: errorMessage(err) });
    }
  }

  const seeded = results.filter((r) => r.outcome === "seeded").length;
  const failed = results.filter((r) => r.outcome === "failed").length;
  log(`done — ${seeded} seeded, ${results.length - seeded - failed} already present, ${failed} failed`);
  return { skipped: false, results };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  seed().catch((err) => {
    log(`unexpected failure: ${errorMessage(err)}`);
  });
}
