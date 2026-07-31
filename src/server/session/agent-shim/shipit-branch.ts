/**
 * `shipit branch` — the agent-facing branch operations ShipIt performs on the
 * agent's behalf (docs/239).
 *
 * Exactly one subcommand today: `reset-to-base`, the explicit mode over the
 * docs/218 reset core. The orchestrator does the git work (it owns the merged-PR
 * facts and the safety anchor), then hands workspace ownership back so the
 * agent's next edit doesn't hit EACCES.
 *
 * The CLI contract is deliberately blunt, because the agent's behavior is the
 * same for every failure: **exit 0 means the branch is ready to build on**
 * (either it was reset, or it was already at the base), **nonzero means stop and
 * report**. "Unsafe" and "errored" are not distinguished — the agent must not
 * proceed in either case, and must not hand-roll a reset instead.
 */

import { parseFlags, fail, success } from "./shim-common.js";
import { REJECTED_HELP, type RunDeps } from "./shipit.js";

interface ResetToBaseResponse {
  outcome?: "reset" | "already-at-base" | "refused";
  reason?: string;
  base?: string;
  fromSha?: string;
  toSha?: string;
}

const RESET_USAGE = `shipit branch reset-to-base [--json]
  Move this session's branch to the base branch its merged PR shipped into, and
  force the remote branch to match. Run this FIRST when a self-merge wake tells
  you your PR merged, before editing anything.

  Exit 0 — the branch is ready ("reset" or "already at base"); proceed.
  Nonzero — refused or failed. STOP: report what it said and do not reset by hand.`;

export async function handleBranchResetToBase(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, { values: {}, booleans: { "--json": "json" } });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit branch reset-to-base: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  if (parsed.positional.length > 0) {
    fail(deps.io, `shipit branch reset-to-base takes no arguments.\n${RESET_USAGE}`);
  }

  const res = await deps.call("POST", "/agent-ops/branch/reset-to-base", {}, deps.env);
  const body = (res.body ?? {}) as ResetToBaseResponse;

  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(res.body ?? {})}\n`);
    deps.io.exit(body.outcome === "reset" || body.outcome === "already-at-base" ? 0 : 1);
    return;
  }

  // A transport / server failure is a refusal as far as the agent is concerned:
  // the branch was not verified as ready, so it must not proceed.
  if (res.status < 200 || res.status >= 300) {
    fail(
      deps.io,
      `branch reset-to-base: FAILED\nreason: ${body.reason ?? `orchestrator returned ${res.status}`}\n\n${REFUSAL_GUIDANCE}`,
      1,
    );
  }

  if (body.outcome === "already-at-base") {
    success(
      deps.io,
      `branch reset-to-base: already at base\nbase:   ${body.base ?? "?"}\nproceed: yes — the branch already matches the latest base.`,
    );
    return;
  }
  if (body.outcome === "reset") {
    success(
      deps.io,
      `branch reset-to-base: reset\nbase:   ${body.base ?? "?"}\nmoved:  ${short(body.fromSha)} → ${short(body.toSha)} (remote branch force-updated to match)\nproceed: yes — build the remaining work on this fresh base; do not re-apply anything the merged PR already shipped.`,
    );
    return;
  }

  fail(
    deps.io,
    `branch reset-to-base: REFUSED\nreason: ${body.reason ?? "the reset was not safe to perform"}\n\n${REFUSAL_GUIDANCE}`,
    1,
  );
}

/**
 * Load-bearing copy, not decoration. The gate is prompt-mediated: a refused
 * agent still has a shell and `git reset --hard` is two words away, so the
 * refusal has to say WHY and forbid the workaround explicitly. The orchestrator
 * carries the same sentence (`RESET_REFUSAL_GUIDANCE` in
 * `services/pre-turn-reset.ts`); it is repeated here so the message survives a
 * transport failure, where no orchestrator body ever arrives.
 */
const REFUSAL_GUIDANCE =
  "Do NOT work around this — do not run `git reset --hard`, `git checkout -f`, `git push --force`, "
  + "or any other manual reset. It refused because a reset here would destroy work that cannot be "
  + "recovered (uncommitted edits have no reflog entry; unmerged commits would be discarded). "
  + "Stop, report what this said, and let the user decide.";

function short(sha?: string): string {
  return sha ? sha.slice(0, 8) : "?";
}

export { RESET_USAGE };
