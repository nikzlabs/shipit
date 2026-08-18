/**
 * docs/252 — pointing a spawn at the selected model's service, for both
 * harnesses, in a module **either side of the container boundary may import**.
 *
 * Phase 3 wrote these two helpers where their spawns live: `applyServiceRouting`
 * inside the Claude adapter's process module and `codexProviderArgs` beside the
 * Codex one, both under `src/server/session/`. That was right while the only
 * caller was a worker-side spawn. Phase 7 adds a second caller on the other
 * side of the boundary — session naming shells out to a CLI from the
 * **orchestrator** (`session-namer.ts`), which must not import `session/` at
 * all: the prod image omits that tree precisely to keep the boundary honest
 * (`app-di.ts`, "loaded lazily via dynamic import").
 *
 * So the shaping rules move here — pure functions over a `ServiceRouting` and
 * nothing else — and the two session-side modules re-export them for their
 * existing importers and tests. Nothing about the rules changed in the move;
 * the alternative was a second implementation in the orchestrator, which is how
 * a naming turn ends up authenticating differently from the turn it names.
 */

import type { AgentId, ServiceRouting } from "./types.js";
import type { ApiStyle } from "./catalogue/types.js";

/** Every Anthropic credential variable the CLI will read, in preference order. */
const ANTHROPIC_CREDENTIAL_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

/** Every environment credential each harness's CLI prefers over its on-disk login. */
const HARNESS_CREDENTIAL_VARS: Record<AgentId, readonly string[]> = {
  claude: ANTHROPIC_CREDENTIAL_VARS,
  codex: ["OPENAI_API_KEY"],
  // OpenCode auto-detects every well-known provider key env var (verified in
  // docs/268: a bare DEEPSEEK_API_KEY was picked up with no config), plus its
  // own gateway/auth vars and ShipIt's provider-block delivery variable — all
  // of which would out-prefer on-disk credentials and silently re-route
  // billing.
  opencode: [
    "OPENCODE_PROVIDER_API_KEY",
    "OPENCODE_API_KEY",
    "OPENCODE_AUTH_CONTENT",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "OPENROUTER_API_KEY",
  ],
  // Grok reads `XAI_API_KEY` in preference to its on-disk `~/.grok/auth.json`
  // login (the unauthenticated CLI names both sources itself, and T3 Code
  // picks between them on exactly this variable) — so an inherited one would
  // silently bill a scoped-home spawn to the wrong account. `GROK_AUTH` /
  // `GROK_AUTH_PATH` are here for the same reason one step removed: they
  // redirect the CLI at a *different* token store, which defeats the scoped
  // home just as thoroughly as a key would.
  grok: ["XAI_API_KEY", "GROK_AUTH", "GROK_AUTH_PATH"],
};

/**
 * docs/150 / docs/252 — drop the environment credentials a CLI would prefer over
 * the account login on disk, for a spawn scoped to a provider-account root.
 *
 * Pointing `HOME` at an account root is not enough on its own: both CLIs prefer
 * their environment variable over the OAuth credentials on disk, so a host that
 * has one configured — the dogfood `dev` service does, see `CLAUDE.md` — keeps
 * billing metered API usage while the router believes the run is on the selected
 * subscription. The adapters already do this at their own spawn sites
 * (`scrubEnvAuthForScopedHome`, and Codex's `delete env.OPENAI_API_KEY`); this is
 * the same rule for the **orchestrator's** own CLI shell-out, which builds its
 * environment itself.
 *
 * Deliberately only when a scoped home applies: a run on a reserved env/API-key
 * route resolves no account root and must keep exactly those variables — they
 * are its auth.
 */
export function scrubHarnessEnvCredentials(env: Record<string, string>, harnessId: AgentId): void {
  for (const name of HARNESS_CREDENTIAL_VARS[harnessId]) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the key set is the module-level literal above, not caller input.
    delete env[name];
  }
}

/**
 * docs/252 phase 3 — point this spawn at the selected model's service.
 *
 * **Must run AFTER the scoped-home auth scrub** where one applies, and the
 * ordering is load-bearing rather than incidental: the scrub deletes the very
 * variables this writes, so shaping first would produce a spawn with an
 * endpoint and no credential — a redirected turn that 401s. A test pins the
 * order.
 *
 * Two things happen and both are deliberate:
 *
 *  - **Every Anthropic credential variable is cleared first, then exactly one is
 *    set.** They are not interchangeable at the wire (`ANTHROPIC_API_KEY`
 *    becomes an `x-api-key` header, `ANTHROPIC_AUTH_TOKEN` an
 *    `Authorization: Bearer` one — measured, not assumed), and the CLI prefers
 *    the key. Leaving a stale one behind is how a GLM turn would authenticate
 *    with an Anthropic key against GLM's endpoint.
 *  - **The base URL is set from the catalogue, unconditionally for a shaped
 *    turn.** Inheriting an ambient `ANTHROPIC_BASE_URL` would make where a turn
 *    goes depend on the orchestrator's own environment rather than on what the
 *    user selected.
 *
 * A turn with nothing to shape — the harness on its own vendor through a login
 * account — passes `undefined` and this is a no-op, which is what keeps today's
 * spawn byte-identical for the common case.
 */
export function applyServiceRouting(
  env: Record<string, string>,
  routing: ServiceRouting | undefined,
): { credentialDelivered: boolean } {
  if (!routing) return { credentialDelivered: true };
  const secret = env[routing.credentialSourceEnv];
  for (const name of ANTHROPIC_CREDENTIAL_VARS) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the key set is the module-level literal above, not caller input.
    delete env[name];
  }
  const credentialDelivered = routing.credentialTarget.kind === "env" && !!secret;
  if (credentialDelivered && routing.credentialTarget.kind === "env") {
    env[routing.credentialTarget.name] = secret;
  }
  env.ANTHROPIC_BASE_URL = routing.baseUrl;
  return { credentialDelivered };
}

/**
 * The provider-block name ShipIt writes under.
 *
 * A fixed name rather than one derived from the `serviceId`, because the block
 * is created fresh per spawn and only ever has one occupant: the turn's own
 * service. A per-service name would accumulate blocks in a user's
 * `config.toml`-shaped override set for no gain, and would collide with a
 * provider the user configured under the same name.
 */
export const SHIPIT_PROVIDER_ID = "shipit";

/** Codex's `wire_api` value for a resolved style, or `undefined` if it has none. */
export function wireApiForStyle(style: ApiStyle): string | undefined {
  return style === "openai-responses" ? "responses" : undefined;
}

/**
 * The `-c` overrides that point this spawn at `routing`, or `[]` when there is
 * nothing to shape.
 *
 * Returns nothing rather than a partial block for a style Codex cannot speak:
 * a half-written provider would be rejected at startup, and a turn that runs
 * against OpenAI because its override was dropped is worse than one that does
 * not start. The catalogue join already prevents the case — no model reaches
 * this harness under a style it does not declare — so this is the backstop for
 * a row edited under a running install.
 */
export function codexProviderArgs(routing: ServiceRouting | undefined): string[] {
  if (!routing) return [];
  const wireApi = wireApiForStyle(routing.style);
  if (!wireApi || routing.credentialTarget.kind !== "env") return [];
  const p = `model_providers.${SHIPIT_PROVIDER_ID}`;
  return [
    "-c", `${p}.name=${routing.serviceName}`,
    "-c", `${p}.base_url=${routing.baseUrl}`,
    "-c", `${p}.wire_api=${wireApi}`,
    "-c", `${p}.env_key=${routing.credentialTarget.name}`,
    "-c", `model_provider=${SHIPIT_PROVIDER_ID}`,
  ];
}
