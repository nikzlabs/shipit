/**
 * The local-mode agent home's credential links (SHI-282, docs/118 §dogfood,
 * docs/150 §9).
 *
 * In containerized mode an agent's credentials reach the CLI by *copy*: the
 * orchestrator provisions the routed account's subtree into
 * `<credentialsDir>/sessions/<id>/`, Docker mounts that at `/credentials`, and
 * the session-worker image symlinks `~/.claude`, `~/.claude.json`, `~/.codex`
 * into it. Every step of that chain is keyed on there being a container, and
 * `session-agent-env.ts` gates the whole thing on
 * `runner instanceof ContainerSessionRunner`.
 *
 * In **local mode** (`RUNTIME_MODE=local` — the dogfood `dev` service) there is
 * no container: `buildRunnerFactory` returns a plain `SessionRunner` and the
 * agent CLI is spawned by this very process. So that gate is *always false*,
 * provisioning never ran, and nothing ever put credentials where the CLI looks.
 * Every dogfood turn started against an empty home and reported itself signed
 * out — for Claude and Codex alike, because the gate keys on the runner type
 * rather than on the agent. That symmetry is what gave the bug away.
 *
 * ## What this module owns, and what it does NOT
 *
 * A **session turn's** credentials no longer come from here. `local-agent-home.ts`
 * resolves the session's own account root per spawn and the adapter spawns with
 * `HOME` pointed straight at it, so the CLI reads
 * `provider-accounts/<provider>/<accountId>/.claude` directly — no link
 * traversed, no shared home, no last-turn-wins race between two sessions on
 * different accounts. That is the mechanism for every session-scoped spawn
 * path, because they all resolve an agent through `runner.createAgent`
 * (`route-registry.ts`'s WS context and `runner-registry-factory.ts`'s
 * `SystemTurnDeps` both prefer it over the process-wide `agentFactory`).
 *
 * What this module owns is the **fallback home** — the process-global
 * `agentHome()` that a spawn with *no* session route still lands on. In local
 * mode that is `generateText` (`app-di.ts`), which takes the bare
 * `agentFactory` with no resolver and backs PR-description and AI-review
 * generation. It is also what `resolveLocalAgentHome` deliberately returns
 * `undefined` to fall back to. (`terminal.ts` and `install-controller.ts` read
 * `agentHome()` too, but only the session *worker* constructs them and local
 * mode has none; the auth managers and OAuth refreshers pass account roots
 * directly and never read `agentHome()` at all.)
 *
 * ## Why linking, not copying
 *
 * Load-bearing, and unchanged by the above. The OAuth refresh token is
 * single-use and rotating, which is why the containerized design needs a
 * per-turn re-sync *in* and a sync-back *out* (`syncAgentTokenIn` /
 * `syncAgentTokenBack`) to keep one copy alive — both also container-gated. And
 * local mode has no orchestrator-side refresher at all (`claude-oauth-refresh`
 * / `codex-oauth-refresh` log `skipping start: runtimeMode != containerized`),
 * so the CLI is the only thing refreshing anything. Given a copy it would
 * rotate the *copy*, killing the account root's refresh token and leaving the
 * orchestrator's own auth status permanently wrong.
 *
 * Linking keeps the invariant that makes the two mechanisms safe to run
 * together: **exactly one physical credentials file per account**, the account
 * root's, which the CLI both reads and refreshes in place. A scoped spawn's
 * `HOME/.claude` and the fallback home's `.claude` symlink resolve to the same
 * bytes — both sides compute the path with `providerAccountCredentialRoot` —
 * so there is nothing to keep in step and nothing that can drift.
 *
 * Pure filesystem in/out — no Docker, no DB, no network.
 */

import fs from "node:fs";
import path from "node:path";
import type { AgentId } from "../shared/types/agent-types.js";
import { agentHome } from "../shared/agent-home.js";
import { providerAccountCredentialRoot } from "./provider-account-manager.js";
import { AGENT_CREDENTIAL_PATHS } from "./session-credentials-scaffold.js";

/**
 * True when this orchestrator hosts its agents in-process (`RUNTIME_MODE=local`).
 *
 * Read from `process.env` at call time, for the same reason `agentHome()` is
 * (see its docstring): the value must be resolvable from a module that the
 * containerized orchestrator also imports, without either mode having to inject
 * it through six `SessionAgentEnvDeps` construction sites.
 *
 * Kept in step with `resolveRuntimeMode()` in `app-di.ts` by a test rather than
 * by an import — importing `app-di` from here would close a cycle
 * (`app-di` → … → `session-agent-env` → this module).
 */
export function isLocalRuntime(): boolean {
  return process.env.RUNTIME_MODE?.toLowerCase() === "local";
}

/** What one of this module's verbs did to one credential path. */
export type CredentialLinkOutcome =
  /** Home already pointed at this exact source. */
  | "already-linked"
  /** A link was created (or repointed at a new source). */
  | "linked"
  /** The source doesn't exist — e.g. Codex was never signed in. */
  | "no-source"
  /** A link this module had made was removed ({@link clearAgentHomeCredentialLinks}). */
  | "unlinked"
  /** Nothing was there to remove, or what was there is not ours to touch. */
  | "absent";

/**
 * Point the agent runtime home's credential paths at the routed account's
 * subtree, so a spawn that lands on the fallback home finds them.
 *
 * Idempotent and cheap (an `lstat` per path on the common no-op), so callers
 * run it on **every** turn rather than once at pin time: the home is shared, so
 * a sibling local session on another account may have repointed it since. The
 * shared-home race that implies is confined to the fallback — a session turn
 * spawns with `HOME` at its own account root and never reads this link. See
 * {@link clearAgentHomeCredentialLinks} for the reserved-route case.
 *
 * `accountId` omitted means the legacy singleton route, whose credentials live
 * at the flat credentials root. That root may itself hold docs/150 alias
 * symlinks; linking to a link is fine, since resolution follows through.
 *
 * A **real** file or directory already sitting at a destination is renamed
 * aside, never deleted — it would be a pre-docs/150 singleton login, and its
 * conversation state is not ours to discard.
 */
export function linkAgentHomeToCredentials(args: {
  credentialsDir: string;
  agentId: AgentId;
  accountId?: string;
  /** Override the runtime home. Tests only; defaults to `agentHome()`. */
  home?: string;
}): Record<string, CredentialLinkOutcome> {
  const home = args.home ?? agentHome();
  const sourceRoot = args.accountId
    ? providerAccountCredentialRoot(args.credentialsDir, args.agentId, args.accountId)
    : args.credentialsDir;

  const outcomes: Record<string, CredentialLinkOutcome> = {};
  for (const rel of AGENT_CREDENTIAL_PATHS[args.agentId]) {
    outcomes[rel] = linkCredentialPath(path.join(sourceRoot, rel), path.join(home, rel));
  }
  return outcomes;
}

/**
 * Remove the credential links this module made, leaving the agent home with no
 * account credentials at all.
 *
 * Called when the turn routed to a **reserved** env route (`claude-api-key`,
 * `claude-env-oauth`, `codex-api-key`), which authenticates from
 * `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `OPENAI_API_KEY` and has no
 * account subtree. Without this, an earlier account-routed turn's link stayed
 * behind and the home carried one route's subscription credentials while the
 * turn ran on another — the CLI's env-beats-disk preference happened to pick
 * the right one, so nothing broke, but nothing made it true either. Clearing
 * makes req 12 (never route subscription work onto metered billing, or the
 * reverse, by accident) hold by construction rather than by coincidence, and it
 * keeps the invariant that the fallback home reflects exactly one route: the
 * most recent local turn's.
 *
 * Only **symlinks** are removed. A real file or directory here predates
 * provider accounts (`AuthManager`'s legacy singleton login ran with
 * `HOME=/root`, which in local mode *was* the agent home) and is not ours to
 * discard — same stance as {@link linkAgentHomeToCredentials}, which renames
 * such a path aside rather than deleting it.
 */
export function clearAgentHomeCredentialLinks(args: {
  agentId: AgentId;
  /** Override the runtime home. Tests only; defaults to `agentHome()`. */
  home?: string;
}): Record<string, CredentialLinkOutcome> {
  const home = args.home ?? agentHome();
  const outcomes: Record<string, CredentialLinkOutcome> = {};
  for (const rel of AGENT_CREDENTIAL_PATHS[args.agentId]) {
    const dest = path.join(home, rel);
    const stat = fs.lstatSync(dest, { throwIfNoEntry: false });
    if (!stat?.isSymbolicLink()) {
      outcomes[rel] = "absent";
      continue;
    }
    // `rmSync` on a symlink unlinks the LINK, never its target — the account
    // root's single physical credentials file is untouched.
    fs.rmSync(dest, { force: true });
    outcomes[rel] = "unlinked";
  }
  return outcomes;
}

function linkCredentialPath(src: string, dest: string): CredentialLinkOutcome {
  // `existsSync` resolves symlinks, so a dangling alias at the source counts as
  // absent — linking to it would only move the failure one hop later.
  if (!fs.existsSync(src)) return "no-source";

  const stat = fs.lstatSync(dest, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) {
    let current: string | null = null;
    try {
      current = fs.readlinkSync(dest);
    } catch {
      // Unreadable link — fall through and replace it.
    }
    if (current === src) return "already-linked";
    // `rmSync` on a symlink unlinks the LINK, never its target.
    fs.rmSync(dest, { force: true });
  } else if (stat) {
    // A real path here predates provider accounts: `AuthManager`'s legacy
    // singleton flow logs in with `HOME=/root`, which in local mode *is* the
    // agent home. Move it aside so the link can be made without destroying a
    // login (and the conversation jsonl beside it) that we cannot recreate.
    const aside = `${dest}.shipit-backup-${Date.now()}`;
    fs.renameSync(dest, aside);
    console.warn(
      `[local-credentials] moved pre-existing ${dest} to ${aside} so it can be linked to ${src}. `
        + `If an older login lived there, its conversation state is still in the backup.`,
    );
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.symlinkSync(src, dest);
  return "linked";
}
