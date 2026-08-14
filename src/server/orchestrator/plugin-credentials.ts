/**
 * docs/262 req 23 — the orchestrator half of plugin credential needs: read
 * what each activated plugin declares, and read which of those names the
 * CONSUMING project has a value for.
 *
 * Two consumers, one answer:
 *   - `api-routes-plugin-repos.ts` — the Plugins tab card, which names the gap
 *     and offers "Add key…" against the consuming project's own store.
 *   - `service-secrets-resolver.ts` — the `secrets_status` snapshot, so the
 *     Secrets settings row knows which plugins claim a name.
 *
 * ## The store boundary (req 23, last sentence)
 *
 * A plugin's credential store "holds only values the user placed there for
 * plugins; it can never resolve ShipIt's own platform credentials — the user's
 * GitHub identity, tracker tokens, or agent tokens."
 *
 * {@link loadSatisfiedPluginCredentialNames} is the only sanctioned way to
 * answer "is this name satisfied?", and it holds that line by construction:
 *
 *   1. It reads **`SecretStore`**, the per-repository store of values the user
 *      typed into Settings → Secrets. ShipIt's platform credentials live in a
 *      different store entirely (`CredentialStore`: the GitHub token, tracker
 *      tokens, agent/provider routes, MCP OAuth), which this module does not
 *      import and cannot reach — the parameter type admits nothing else.
 *   2. It is keyed by the **consuming session's** `remoteUrl`. Keying it by the
 *      plugin repository's URL would read (and later write) the wrong store —
 *      the trap `plan.md` §3 records for the "Add key…" affordance, here on
 *      the read side.
 *   3. It returns **names only**. Values are read to decide "non-empty" and
 *      then dropped, so nothing downstream — snapshot, WS message, browser —
 *      is even in a position to leak one.
 *
 * `plugin-credentials.test.ts` proves 1 and 2 with a populated `CredentialStore`
 * beside a populated `SecretStore`, rather than asserting it in a comment.
 */

import type { DeclaredPluginRepo, PluginExport, PluginReposConfig } from "../shared/plugin-repos.js";
import { destinationKey } from "../shared/plugin-repos.js";
import {
  declaredPluginCredentials,
  type PluginCredentialDeclaration,
} from "../shared/plugin-credentials.js";
import { resolveShipitConfig } from "../shared/shipit-config.js";
import { readActiveManifest } from "./plugin-generations.js";
import { sessionStateDirForWorkspace } from "./session-state-dir.js";
import type { SecretStore } from "./secret-store.js";

/**
 * What every activated plugin of this workspace declares (req 23).
 *
 * Read fresh — the `issues.trackers` convention this feature already follows:
 * the declaration is a committed file and the manifest belongs to whichever
 * generation is live right now, so a `shipit.yaml` edit or a `shipit plugin
 * refresh` changes the answer on the next call, with no cache to invalidate.
 *
 * Never throws: a workspace whose config cannot be read declares nothing here,
 * and the surfaces that report *why* (the tab's warnings, the card's issues)
 * are unaffected.
 */
export function collectPluginCredentialDeclarations(
  workspaceDir: string,
): PluginCredentialDeclaration[] {
  try {
    const config = resolveShipitConfig(workspaceDir);
    return pluginCredentialDeclarationsFor(workspaceDir, config.plugins, config.pluginExports);
  } catch {
    return [];
  }
}

/**
 * The same answer for a caller that has already parsed the config — the
 * snapshot route, which would otherwise read and parse `shipit.yaml` twice per
 * request and could observe two different versions of it across a mid-request
 * edit.
 */
export function pluginCredentialDeclarationsFor(
  workspaceDir: string,
  plugins: PluginReposConfig,
  selfExports: readonly PluginExport[],
): PluginCredentialDeclaration[] {
  try {
    return declaredPluginCredentials(
      plugins,
      liveManifestReader(workspaceDir, plugins.repos, selfExports),
    );
  } catch {
    return [];
  }
}

/**
 * Resolve a repository name to the manifest of what is actually running:
 * this same file's `exports.plugins` for a `repo: self` declaration (req 27 —
 * the live working tree IS the version), and the active generation's manifest
 * for a tracked one. Null — "not knowable yet" — for a tracked repository with
 * no live generation.
 */
export function liveManifestReader(
  workspaceDir: string,
  repos: readonly DeclaredPluginRepo[],
  selfExports: readonly PluginExport[],
): (repoName: string) => readonly PluginExport[] | null {
  let stateDir: string | null = null;
  try {
    stateDir = sessionStateDirForWorkspace(workspaceDir);
  } catch {
    stateDir = null;
  }
  // Keyed by what each declaration POINTS AT, not only by its kind: the name is
  // re-pointable and the generation's path is keyed by the name, so a manifest
  // read without the source can answer with the PREVIOUS repository's exports —
  // and then this module reports that repository's credential names as the ones
  // this project must satisfy.
  const sourceOf = new Map(repos.map((r) => [r.name.toLowerCase(), destinationKey(r.source)]));

  return (repoName: string) => {
    const source = sourceOf.get(repoName.toLowerCase());
    if (source === undefined) return null;
    if (source === "self") return selfExports;
    if (!stateDir) return null;
    try {
      return readActiveManifest(stateDir, repoName, source);
    } catch {
      return null;
    }
  };
}

/**
 * The names the CONSUMING project has a non-empty value for — the ONLY input
 * that may decide a plugin credential is satisfied (req 23; see the module
 * header for why this function's shape is the security property).
 *
 * `secretStore` is typed as the load method alone so no caller can pass a
 * store that knows about ShipIt's own credentials, and `consumerRemoteUrl` is
 * the consuming session's remote — never a plugin repository's.
 */
export function loadSatisfiedPluginCredentialNames(
  secretStore: Pick<SecretStore, "loadSecrets"> | undefined,
  consumerRemoteUrl: string | null | undefined,
): Set<string> {
  if (!secretStore || !consumerRemoteUrl) return new Set();
  try {
    // Values are read to test emptiness — the same bar the compose resolver
    // applies, so one stored empty string does not read as "set" here and
    // "missing" there — and are discarded with this expression.
    return new Set(
      Object.entries(secretStore.loadSecrets(consumerRemoteUrl))
        .filter(([, value]) => typeof value === "string" && value.length > 0)
        .map(([name]) => name),
    );
  } catch {
    // A store that cannot be read must not report every credential as
    // satisfied — an unreadable store means "nothing known to be set", which
    // renders as the visible gap req 23 asks for.
    return new Set();
  }
}
