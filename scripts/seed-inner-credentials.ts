import {
  credentialModeForStorageEnv,
  credentialStorageEnvNames,
  getService,
  type BillingMode,
} from "../src/server/shared/catalogue/index.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:4000";

const HEALTH_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;

const CLI_READS_DIRECTLY = new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY"]);

const log = (msg: string): void => { console.log(msg); };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface CredentialCandidate {
  envName: string;
  serviceId: string;
  serviceName: string;
  billingMode: BillingMode;
  secret: string;
}

export interface SeedCredentialResult {
  envName: string;
  outcome: "seeded" | "skipped" | "failed";
  detail?: string;
}

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
    // Status is sufficient for non-JSON responses.
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

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
    log("credentials: no service credentials in the environment — nothing to seed");
    return { skipped: true, results: [] };
  }

  try {
    await waitForOrch(fetchImpl, baseUrl, opts);
  } catch (err) {
    log(`credentials: ${errorMessage(err)}`);
    return { skipped: true, results: [] };
  }

  // Subscription routes allow duplicates; a failed read must prevent blind POSTs.
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

// Warn from candidates: ambient credentials affect billing even when seeding fails.
export function warnAboutAmbientAuth(candidates: readonly CredentialCandidate[]): string[] {
  const lines: string[] = [];

  const metered = candidates.filter((c) => c.billingMode === "key");
  if (metered.length > 0) {
    lines.push(
      `credentials: ⚠ metered (billed per token): ${metered.map((c) => c.envName).join(", ")}.`
      + " ShipIt's background work (session naming, PR descriptions) follows the"
      + " first eligible model in catalogue order unless it is pinned — check"
      + " Settings → Services → Background work.",
    );
  }

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

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  seedCredentials().catch((err: unknown) => {
    log(`credentials: unexpected failure: ${errorMessage(err)}`);
  });
}
