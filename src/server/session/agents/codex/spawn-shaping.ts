/**
 * docs/252 phase 3 — pointing Codex at the selected model's service.
 *
 * Codex has no base-URL flag and no base-URL environment variable. It resolves
 * an endpoint through a **named provider block**: `model_provider` holds the
 * name of an entry in the `model_providers` table, and that entry carries the
 * URL, the wire format and the name of the variable holding the key. So the
 * seam is a whole block plus a pointer at it, written as `-c` overrides ahead of
 * the `app-server` subcommand — the same position the docs/217 reasoning
 * override already occupies.
 *
 * All of this was measured against codex-cli 0.146.0 driving a local HTTP
 * recorder, not inferred from documentation:
 *
 *  - `-c model_provider=<url>` fails outright with "Model provider `…` not
 *    found", which is what settles that the value is a *name* and the earlier
 *    catalogue guess of a `model_provider.base_url` key was wrong.
 *  - The request goes to `<base_url>/responses`, so a Responses base URL carries
 *    its own `/v1` where an Anthropic-style one does not.
 *  - `env_key` names an ordinary environment variable and its value is sent as
 *    `Authorization: Bearer …`.
 *  - `wire_api = "chat"` is **rejected** by this CLI ("set `wire_api =
 *    \"responses\"` in your provider config"), which is why the Codex harness
 *    declares only `openai-responses` and why {@link wireApiForStyle} treats
 *    anything else as unshapeable rather than mapping it.
 */

import type { ServiceRouting } from "../../../shared/types.js";
import type { ApiStyle } from "../../../shared/catalogue/types.js";

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
