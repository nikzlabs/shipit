/**
 * Seed the dogfood inner ShipIt with the service credentials the developer set
 * once in the OUTER ShipIt's Settings → Secrets (docs/131 reqs 11–12).
 *
 * ## Why this exists — the bare env var is not a credential
 *
 * The `dev` service already forwarded `ANTHROPIC_API_KEY` and friends into the
 * inner orchestrator's environment, and that is genuinely enough to *run* a
 * turn. It is not enough to be a **credential route**, and the difference is
 * the whole point of this script:
 *
 *   - `listConfiguredCredentials` (`service-routing.ts`) DOES read the raw
 *     environment, so an env-supplied key already makes its models eligible in
 *     the picker, and `envRouteIdFor` gives it a synthetic `env:<NAME>` id;
 *   - but `listCredentialRoutes` (`services/credential-routes.ts`) reads the
 *     credential STORE and nothing else, so the inner Settings → Services
 *     surface shows no credential at all;
 *   - and an env-delivered credential carries no row, which is exactly why
 *     `stringSelectionFor` treats it as a last resort that can be neither
 *     benched, ordered, nor failed over to — and why the quota system has
 *     nothing to attach a reader to (planning#339's `zai-plan-usage`).
 *
 * `app-di.ts` seeds `process.env` FROM the stored routes at boot. This script
 * is the missing inverse: it turns a supplied variable into a stored row, once,
 * so the inner instance holds a real credential rather than an ambient string.
 *
 * ## Generalised, never per-service
 *
 * The mapping from variable name to `(service, billing mode)` is the
 * catalogue's — `credentialStorageEnvNames()` + `credentialModeForStorageEnv()`
 * — so every service ShipIt ships is covered and a new one needs no edit here.
 * The only hand-written list is `docker-compose.yml`'s `x-shipit-secrets`
 * block, which is static YAML; `seed-inner-credentials.test.ts` guards that it
 * stays in step with the catalogue.
 *
 * Written over the inner HTTP API rather than against the store directly: the
 * orchestrator owns that store, is already running, and the POST also fires
 * `propagateCredentialChange()` and the `credential_routes` SSE, so an inner UI
 * that is already open updates live.
 *
 * ## Contract, deliberately the same as the repo seeder's (docs/131)
 *
 *   - req 3: `DOGFOOD_SEED=0` disables it, and `DOGFOOD_SEED_CREDENTIALS=0`
 *     disables just this half.
 *   - req 4: a `(service, billing mode)` that already holds a string credential
 *     is left completely alone, so a restart duplicates nothing and never
 *     clobbers a credential edited in the inner UI.
 *   - req 5: every failure is logged and the remaining names still get their
 *     turn. Always exits 0 — a missing secret is a silent no-op, and a broken
 *     seed is a degraded dogfood loop, not a broken dev service.
 *   - req 6: it never blocks the inner UI; compose backgrounds it.
 *
 * Run with `npx tsx` (not bare `node`) — unlike its repo-seeding sibling this
 * one imports the catalogue, which is TypeScript.
 */

import {
  credentialModeForStorageEnv,
  credentialStorageEnvNames,
  getService,
  type BillingMode,
} from "../src/server/shared/catalogue/index.js";

/** Inner orchestrator. Compose runs it on 4000; Vite proxies /api to it. */
const DEFAULT_BASE_URL = "http://127.0.0.1:4000";

/** Bounded wait — the orch boots behind an `agent.install` gate. */
const HEALTH_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;

/**
 * The variables a vendor CLI reads **directly**, so their presence in the
 * orchestrator's environment can decide an **unshaped** spawn — the harness
 * running on its own vendor, where `applyServiceRouting` is a no-op and so
 * does not clear them.
 *
 * Not a catalogue fact — a property of the CLIs, asserted by the code that
 * strips them: `scrubEnvAuthForScopedHome` (`agents/claude/process.ts`) for the
 * two Anthropic names, and the Codex adapter's `delete env.OPENAI_API_KEY` for
 * the third. Both strip only when a scoped home applies, and
 * `resolveLocalAgentHome` returns one only for an `account` route — so a turn
 * with no route selected, and non-turn work whose own target differs from the
 * runner's resident route, are not covered.
 */
const CLI_READS_DIRECTLY = new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY"]);

const log = (msg: string): void => { console.log(msg); };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One credential the environment supplies and the catalogue can place. */
export interface CredentialCandidate {
  envName: string;
  serviceId: string;
  serviceName: string;
  billingMode: BillingMode;
  secret: string;
}

/** The outcome of one candidate, for the caller's log and the tests' assertions. */
export interface SeedCredentialResult {
  envName: string;
  outcome: "seeded" | "skipped" | "failed";
  detail?: string;
}

/**
 * Every catalogue-declared credential variable this environment actually
 * supplies, in catalogue order.
 *
 * Driven by `credentialStorageEnvNames()` so it is the catalogue and not this
 * file that decides what "a service credential" is. A name the catalogue
 * declares but no longer places — it left a mode between releases — is dropped
 * rather than guessed at.
 */
export function collectCandidates(env: NodeJS.ProcessEnv): CredentialCandidate[] {
  const out: CredentialCandidate[] = [];
  for (const envName of credentialStorageEnvNames()) {
    const secret = env[envName]?.trim();
    if (!secret) continue;
    const owner = credentialModeForStorageEnv(envName);
    if (!owner) continue;
    out.push({
      envName,
      serviceId: owner.serviceId,
      serviceName: getService(owner.serviceId)?.name ?? owner.serviceId,
      billingMode: owner.billingMode,
      secret,
    });
  }
  return out;
}

/**
 * The label the seeded credential wears in inner Settings → Services.
 *
 * Names its provenance on purpose. A developer looking at the inner Services
 * tab has to be able to tell a credential that arrived from an outer secret
 * (and will not be re-synced if they rotate it out there) from one they typed
 * into this instance.
 */
export function seededLabel(candidate: CredentialCandidate): string {
  const kind = candidate.billingMode === "sub" ? "plan" : "key";
  return `${candidate.serviceName} ${kind} (dogfood secret)`;
}

interface ApiResponse {
  ok: boolean;
  status: number;
  body: { error?: string; routes?: { serviceId: string; billingMode: string; via: string }[] } | null;
}

export type FetchImpl = typeof globalThis.fetch;

/**
 * Thin JSON client. Returns the status rather than throwing on a non-2xx,
 * because every caller here treats an HTTP error as "log it and carry on with
 * the next credential" (req 5).
 */
async function api(
  fetchImpl: FetchImpl,
  baseUrl: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<ApiResponse> {
  const res = await fetchImpl(`${baseUrl}${route}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let parsed: ApiResponse["body"] = null;
  try {
    parsed = (await res.json()) as ApiResponse["body"];
  } catch {
    // Empty or non-JSON body — the status is all we need.
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

/**
 * Wait for the inner orch to answer, exactly as the repo seeder does.
 * `GET /api/bootstrap` is registered by the same `buildApp()` call as
 * everything else, so a 200 there means `/api/credential-routes` is live too.
 */
async function waitForOrch(
  fetchImpl: FetchImpl,
  baseUrl: string,
  opts: { timeoutMs?: number; pollIntervalMs?: number; now?: () => number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const now = opts.now ?? ((): number => Date.now());
  const deadline = now() + timeoutMs;
  let lastError = "no response";
  while (now() < deadline) {
    try {
      const res = await api(fetchImpl, baseUrl, "GET", "/api/bootstrap");
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = errorMessage(err);
    }
    await sleep(opts.pollIntervalMs ?? POLL_INTERVAL_MS);
  }
  throw new Error(`inner orchestrator did not come up within ${timeoutMs}ms (${lastError})`);
}

export interface SeedCredentialsDeps {
  fetchImpl?: FetchImpl;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}

export interface SeedCredentialsOpts {
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
}

/**
 * Run the whole credential seed. Dependency-injected so the unit tests drive it
 * with a fake `fetch` instead of a live orchestrator.
 */
export async function seedCredentials(
  deps: SeedCredentialsDeps = {},
  opts: SeedCredentialsOpts = {},
): Promise<{ skipped: boolean; results: SeedCredentialResult[] }> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const baseUrl = deps.baseUrl ?? process.env.SEED_ORCH_URL ?? DEFAULT_BASE_URL;
  const env = deps.env ?? process.env;

  if (env.DOGFOOD_SEED === "0" || env.DOGFOOD_SEED_CREDENTIALS === "0") {
    log("credentials: disabled — skipping");
    return { skipped: true, results: [] };
  }

  const candidates = collectCandidates(env);
  if (candidates.length === 0) {
    // The common case for anyone who is not Nik: no service secrets set at all.
    // Say nothing alarming and cost the boot nothing — not even the health wait.
    log("credentials: no service credentials in the environment — nothing to seed");
    return { skipped: true, results: [] };
  }

  try {
    await waitForOrch(fetchImpl, baseUrl, opts);
  } catch (err) {
    log(`credentials: ${errorMessage(err)}`);
    return { skipped: true, results: [] };
  }

  // req 4 — the stored routes are the idempotency key. A mode that already
  // holds a string credential is left alone: re-POSTing would duplicate it on a
  // `sub` mode (which permits several) and 409 on a `key` mode, and PATCHing
  // would silently overwrite a credential the developer edited in the inner UI.
  //
  // A discovery that FAILS aborts the whole run rather than carrying on. There
  // is no server-side uniqueness key for `(service, billing mode, string)` — a
  // subscription is *meant* to hold several — so a blind POST after a lost GET
  // is exactly how a duplicate appears, and it grows one per boot. Nothing is
  // lost by stopping: the next dev-service start re-runs this, and doing
  // nothing is the correct outcome for a seeder that cannot see the state it
  // is reconciling against. (Cross-agent review found this; the first cut
  // logged and continued, copying the repo seeder's per-entry tolerance into a
  // place where the cost is a silently duplicated credential.)
  const held = new Set<string>();
  try {
    const res = await api(fetchImpl, baseUrl, "GET", "/api/credential-routes");
    if (!res.ok || !Array.isArray(res.body?.routes)) {
      log(
        `credentials: could not list existing credentials (HTTP ${res.status}) —`
        + " skipping, so a lost read cannot duplicate a subscription credential",
      );
      return { skipped: true, results: [] };
    }
    for (const route of res.body.routes) {
      if (route.via === "string") held.add(`${route.serviceId}:${route.billingMode}`);
    }
  } catch (err) {
    log(
      `credentials: could not list existing credentials (${errorMessage(err)}) —`
      + " skipping, so a lost read cannot duplicate a subscription credential",
    );
    return { skipped: true, results: [] };
  }

  const results: SeedCredentialResult[] = [];
  for (const candidate of candidates) {
    const modeKey = `${candidate.serviceId}:${candidate.billingMode}`;
    if (held.has(modeKey)) {
      log(`credentials: ${candidate.envName} — ${modeKey} already has a credential, leaving it alone`);
      results.push({ envName: candidate.envName, outcome: "skipped" });
      continue;
    }
    try {
      const res = await api(fetchImpl, baseUrl, "POST", "/api/credential-routes", {
        serviceId: candidate.serviceId,
        billingMode: candidate.billingMode,
        secret: candidate.secret,
        label: seededLabel(candidate),
      });
      if (!res.ok) {
        const detail = res.body?.error ?? `HTTP ${res.status}`;
        log(`credentials: ${candidate.envName} — ${detail}`);
        results.push({ envName: candidate.envName, outcome: "failed", detail });
        continue;
      }
      held.add(modeKey);
      log(`credentials: ${candidate.envName} — added as ${modeKey}`);
      results.push({ envName: candidate.envName, outcome: "seeded" });
    } catch (err) {
      // req 5 — one bad entry must not stop the others.
      const detail = errorMessage(err);
      log(`credentials: ${candidate.envName} — ${detail}`);
      results.push({ envName: candidate.envName, outcome: "failed", detail });
    }
  }

  warnAboutAmbientAuth(candidates);

  const seeded = results.filter((r) => r.outcome === "seeded").length;
  const failed = results.filter((r) => r.outcome === "failed").length;
  log(
    `credentials: done — ${seeded} added, ${results.length - seeded - failed} already present,`
    + ` ${failed} failed`,
  );
  return { skipped: false, results };
}

/**
 * Say, at boot, what supplying these credentials can cost.
 *
 * Two warnings, because there are two mechanisms and the first one is the
 * bigger and less obvious of the two. A cross-agent review caught that an
 * earlier version printed only the second and called the other five names
 * "inert", which is wrong in the way that matters.
 *
 * Printed from the CANDIDATES rather than the results: both hazards follow from
 * the credential existing, whether this run stored it, skipped it as already
 * present, or failed.
 */
export function warnAboutAmbientAuth(candidates: readonly CredentialCandidate[]): string[] {
  const lines: string[] = [];

  // 1. Background work follows the install. `firstEligibleNonTurnSelection`
  //    (`non-turn-model.ts`) resolves an unset background-work model to the
  //    first eligible model in catalogue order, so a metered key can become
  //    what session naming and PR descriptions spend on — no CLI involved, and
  //    true of every metered key, not just the vendor-native ones.
  const metered = candidates.filter((c) => c.billingMode === "key");
  if (metered.length > 0) {
    lines.push(
      `credentials: ⚠ metered (billed per token): ${metered.map((c) => c.envName).join(", ")}.`
      + " ShipIt's background work (session naming, PR descriptions) follows the"
      + " first eligible model in catalogue order unless it is pinned — check"
      + " Settings → Services → Background work.",
    );
  }

  // 2. The vendor-native names additionally bypass a connected account on an
  //    UNSHAPED spawn — see CLI_READS_DIRECTLY.
  const ambient = candidates.filter((c) => CLI_READS_DIRECTLY.has(c.envName));
  if (ambient.length > 0) {
    lines.push(
      `credentials: ⚠ ${ambient.map((c) => c.envName).join(", ")} are read by the CLI`
      + " directly. A redirected turn clears them, but a turn on the harness's own"
      + " vendor with no account route resolved will use them instead of a"
      + " connected subscription.",
    );
  }

  for (const line of lines) log(line);
  return lines;
}

// Entry point. Never exits non-zero: a seeding failure is a degraded dogfood
// loop, not a broken dev service (req 5).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  seedCredentials().catch((err: unknown) => {
    log(`credentials: unexpected failure: ${errorMessage(err)}`);
  });
}
