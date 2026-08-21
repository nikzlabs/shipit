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
 *    declares only `openai-responses` and why `wireApiForStyle` treats anything
 *    else as unshapeable rather than mapping it.
 *
 * **The rules themselves moved to `shared/spawn-routing.ts` in phase 7**, so the
 * orchestrator's own `codex exec` shell-out (session naming) shapes its spawn
 * from the same source rather than from a second copy. Nothing changed in the
 * move; this module stays as the name every existing importer and test uses.
 */

export {
  SHIPIT_PROVIDER_ID,
  wireApiForStyle,
  codexProviderArgs,
} from "../../../shared/spawn-routing.js";
