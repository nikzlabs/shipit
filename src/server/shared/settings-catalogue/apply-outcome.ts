/**
 * What a settings write is allowed to claim about itself
 * (docs/299-agent-settings-access, plan.md → "Saved" has to mean saved).
 *
 * Two outcomes are not enough. `CredentialStore.save()` caught its disk-write
 * failure, logged it and returned `void`, so a value could be reported saved and
 * vanish at the next restart; `writeGlobalSystemPrompt` swallowed the `unlink`
 * that clears instructions, so "cleared" could be false; and `setGitIdentity`
 * makes two `git config` calls, so the name can land and the email throw. Every
 * other guarantee this feature makes is worthless if "applied" can be false.
 */

export type ApplyStatus =
  /** The change is durable. Every part of it landed. */
  | "applied"
  /** Some of a multi-write operation landed and some did not. */
  | "partial"
  /**
   * Verified that nothing changed. Only a writer that can prove it rolled the
   * change back may claim this — a writer that cannot prove it says `uncertain`.
   */
  | "failed"
  /** The writer cannot say whether the change landed. */
  | "uncertain";

export interface ApplyOutcome {
  readonly status: ApplyStatus;
  /** What did and did not land, in words a card or a log line can repeat. */
  readonly detail?: string;
}

export const APPLIED: ApplyOutcome = { status: "applied" };

export function applyFailed(detail: string): ApplyOutcome {
  return { status: "failed", detail };
}

export function applyPartial(detail: string): ApplyOutcome {
  return { status: "partial", detail };
}

export function applyUncertain(detail: string): ApplyOutcome {
  return { status: "uncertain", detail };
}

/**
 * One outcome for an operation made of several writes. The weakest answer wins,
 * because a caller acts on the weakest guarantee it was given.
 *
 * Two cases are easy to get backwards, and both would claim more than the parts
 * support. A `failed` beside anything that landed is a **`partial`** — "nothing
 * changed" is then untrue of the operation as a whole. A `failed` beside an
 * `uncertain` is **`uncertain`**, not `failed`: `failed` means VERIFIED nothing
 * changed, and a write that could not say whether it landed leaves nothing to
 * verify.
 *
 * An empty group is `applied` by definition — nothing was asked for, so nothing
 * is outstanding. A caller with nothing to write must not fold this in beside
 * real outcomes, because an `applied` that stands for no write makes a lone
 * `failed` read as a `partial`.
 */
export function combineOutcomes(outcomes: readonly ApplyOutcome[]): ApplyOutcome {
  const details = outcomes.map((o) => o.detail).filter((d): d is string => !!d);
  const detail = details.length > 0 ? { detail: details.join(" ") } : {};
  const landed = outcomes.some((o) => o.status === "applied" || o.status === "partial");
  if (outcomes.some((o) => o.status === "partial")) return { status: "partial", ...detail };
  if (outcomes.some((o) => o.status === "failed")) {
    if (landed) return { status: "partial", ...detail };
    return outcomes.some((o) => o.status === "uncertain")
      ? { status: "uncertain", ...detail }
      : { status: "failed", ...detail };
  }
  if (outcomes.some((o) => o.status === "uncertain")) return { status: "uncertain", ...detail };
  return outcomes.length === 0 ? APPLIED : { status: "applied", ...detail };
}

/** Whether the caller may tell the user the change is in place. */
export function isApplied(outcome: ApplyOutcome): boolean {
  return outcome.status === "applied";
}
