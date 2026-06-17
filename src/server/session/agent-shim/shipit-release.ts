/**
 * `shipit release *` handlers (docs/214 Phase 2) — the deterministic release
 * mechanics surfaced to the inner agent as a thin shim over the orchestrator.
 *
 * `shipit release plan [<patch|minor|major|VERSION>]` — READ-ONLY: detect the
 *   version source + compute the next version; reflects a `proposed` card.
 * `shipit release prepare [<bump|VERSION>] [--pick <sha>…] [--from <branch>]
 *   [--release-branch <name>] [--bootstrap] [--allow-empty] [--prerelease]
 *   [--confirm] [--notes <text>]` — open the version-bump PR against the release
 *   branch (final release; the human-act gate is merging it, CI publishes), OR
 *   cut the `vX.Y.Z-rc.N` tag (prerelease; confirmation-gated via `--confirm`).
 *   A bare `prepare` (no `--pick`/`--from`) is refused as content-free — it would
 *   ship only the version bump; pass `--from <branch>` to bring content, or
 *   `--allow-empty` to cut a bump-only release on purpose.
 *
 * There is intentionally NO `shipit release tag`/`publish`/`push` for final
 * releases — publishing is CI's job (the rejected subcommands live in
 * `shipit.ts`). The agent never hand-runs `git tag`.
 */

import {
  asString,
  fail,
  parseFlags,
  success,
  type ShimIO,
} from "./shim-common.js";
import { REJECTED_HELP, formatError, type RunDeps } from "./shipit.js";

/** Pretty-print a plan/prepare JSON result, or emit it raw with `--json`. */
function report(io: ShimIO, body: Record<string, unknown>, json: boolean, lines: string[]): void {
  if (json) {
    io.stdout(`${JSON.stringify(body)}\n`);
    io.exit(0);
    return;
  }
  success(io, lines.join("\n"));
}

export async function handleReleasePlan(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: { "--version-source-path": "versionSourcePath" },
    booleans: { "--json": "json", "--prerelease": "prerelease" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit release plan: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const payload: Record<string, unknown> = {};
  if (parsed.positional[0]) payload.bump = parsed.positional[0];
  if (parsed.booleans.has("prerelease")) payload.prerelease = true;
  if (parsed.values.versionSourcePath) payload.versionSourcePath = parsed.values.versionSourcePath;

  const res = await deps.call("POST", "/agent-ops/release/plan", payload, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to plan release"), 1);
  }
  const b = res.body;
  report(deps.io, b, parsed.booleans.has("json"), [
    `current:    ${asString(b.currentVersion)}`,
    `next:       ${asString(b.version)}`,
    `tag:        ${asString(b.tag)}`,
    `bump:       ${asString(b.bumpType)}`,
    `source:     ${asString(b.versionSource)}`,
    ...(b.prerelease ? ["prerelease: yes"] : []),
  ]);
}

export async function handleReleasePrepare(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: {
      "--from": "from",
      "--release-branch": "releaseBranch",
      "--notes": "notes",
      "--version-source-path": "versionSourcePath",
    },
    arrays: { "--pick": "pick" },
    booleans: {
      "--json": "json",
      "--prerelease": "prerelease",
      "--confirm": "confirm",
      "--bootstrap": "bootstrap",
      "--allow-empty": "allowEmpty",
    },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit release prepare: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }

  const payload: Record<string, unknown> = {};
  if (parsed.positional[0]) payload.bump = parsed.positional[0];
  if (parsed.booleans.has("prerelease")) payload.prerelease = true;
  if (parsed.booleans.has("confirm")) payload.confirm = true;
  if (parsed.booleans.has("bootstrap")) payload.bootstrap = true;
  if (parsed.booleans.has("allowEmpty")) payload.allowEmpty = true;
  if (parsed.arrays.pick?.length) payload.pick = parsed.arrays.pick;
  if (parsed.values.from) payload.from = parsed.values.from;
  if (parsed.values.releaseBranch) payload.releaseBranch = parsed.values.releaseBranch;
  if (parsed.values.notes) payload.notes = parsed.values.notes;
  if (parsed.values.versionSourcePath) payload.versionSourcePath = parsed.values.versionSourcePath;

  const res = await deps.call("POST", "/agent-ops/release/prepare", payload, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to prepare release"), 1);
  }
  const b = res.body;
  const json = parsed.booleans.has("json");
  switch (b.kind) {
    case "pr-opened":
      report(deps.io, b, json, [
        `${b.alreadyExisted ? "updated" : "opened"} release PR #${asString(b.prNumber)} → ${asString(b.prUrl)}`,
        `version:    ${asString(b.version)} (tag ${asString(b.tag)})`,
        `base:       ${asString(b.releaseBranch)}`,
        "",
        "Merge the PR to publish — CI tags the merged commit and creates the GitHub Release.",
      ]);
      break;
    case "prerelease-proposed":
      report(deps.io, b, json, [
        `proposed prerelease ${asString(b.version)} (tag ${asString(b.tag)}).`,
        "Re-run with --confirm to cut + push the rc tag (a tag push is always confirmation-gated).",
      ]);
      break;
    case "prerelease-tagged":
      report(deps.io, b, json, [
        `pushed prerelease tag ${asString(b.tag)} (${asString(b.sha).slice(0, 8)}).`,
        "CI publishes it as a GitHub prerelease.",
      ]);
      break;
    default:
      report(deps.io, b, json, [`done: ${asString(b.kind) || "ok"}`]);
  }
}
