/**
 * Turns the inner instance's session status card on, so the card the transcript
 * seed writes is actually on screen. docs/303 keeps the feature behind
 * `advanced.sessionStatusCard`, off by default — which is right for the product
 * and wrong for a dogfood instance whose whole job is to be looked at.
 *
 * It runs BEFORE the transcript seed: turning the setting on marks every stored
 * card stale (`onSessionStatusCardEnabled`), so a card seeded first would come
 * up reading "Stale" and hiding its last-turn line.
 *
 * Over HTTP rather than by writing `credentials.json`, because the orchestrator
 * is already up by this point and holds that file in memory: a direct write
 * would be clobbered by its next save and would not reach any viewer.
 *
 * A hand toggle does not survive a reboot of the dev service, because the stored
 * setting reads `false` both when it was never set and when it was turned off,
 * and the seed cannot tell the two apart. `DOGFOOD_SEED_STATUS_CARD=0` is the
 * off-switch that does survive.
 */
import { api, waitForOrch, type FetchImpl } from "./seed-inner-credentials.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:4000";

const log = (msg: string): void => { console.log(`status-card: ${msg}`); };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface SeedStatusCardDeps {
  fetchImpl?: FetchImpl;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}

export type SeedStatusCardResult =
  | { outcome: "enabled" }
  | { outcome: "already-on" }
  | { outcome: "skipped"; reason: string };

export async function seedStatusCardSetting(
  deps: SeedStatusCardDeps = {},
  opts: { timeoutMs?: number; pollIntervalMs?: number; now?: () => number } = {},
): Promise<SeedStatusCardResult> {
  const env = deps.env ?? process.env;
  if (env.DOGFOOD_SEED === "0" || env.DOGFOOD_SEED_STATUS_CARD === "0") {
    log("disabled — skipping");
    return { outcome: "skipped", reason: "disabled" };
  }

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const baseUrl = deps.baseUrl ?? env.SEED_ORCH_URL ?? DEFAULT_BASE_URL;

  try {
    await waitForOrch(fetchImpl, baseUrl, opts);
  } catch (err) {
    log(errorMessage(err));
    return { outcome: "skipped", reason: "orchestrator-down" };
  }

  try {
    // Read first: a PUT that changes nothing would still mark every stored card
    // stale, which is the one thing this step must not do to the seeded card.
    const boot = await api(fetchImpl, baseUrl, "GET", "/api/bootstrap");
    const settings = (boot.body as { settings?: { sessionStatusCard?: unknown } } | null)?.settings;
    if (settings?.sessionStatusCard === true) {
      log("already on — leaving it alone");
      return { outcome: "already-on" };
    }

    const res = await api(fetchImpl, baseUrl, "PUT", "/api/settings", { sessionStatusCard: true });
    if (!res.ok) {
      const detail = res.body?.error ?? `HTTP ${res.status}`;
      log(`could not turn it on — ${detail}`);
      return { outcome: "skipped", reason: detail };
    }
    log("turned on");
    return { outcome: "enabled" };
  } catch (err) {
    log(errorMessage(err));
    return { outcome: "skipped", reason: errorMessage(err) };
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void seedStatusCardSetting().catch((err: unknown) => {
    log(`unexpected failure: ${errorMessage(err)}`);
  });
}
