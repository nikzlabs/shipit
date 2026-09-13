import { buildCleanupPrompt } from "./cleanup-prompt.js";

/**
 * A direct call is one HTTP request, measured at 400-800 ms; a harness one-shot
 * on a cleanup-shaped prompt was measured at 3.0-4.5 s in a warm container
 * (docs/299-direct-provider-calls plan.md). Both are tuning — the requirement
 * is that *some* deadline is enforced here, end to end (req 9).
 */
export const CLEANUP_DIRECT_TIMEOUT_MS = 3000;
export const CLEANUP_HARNESS_TIMEOUT_MS = 15_000;

const MAX_LENGTH_RATIO = 2;
const PREAMBLE_PATTERNS = [
  /^here(?:'s| is)\b/i,
  /^the cleaned\b/i,
  /^cleaned (?:message|transcript|version)\b/i,
  /^sure[,!]/i,
];

export type CleanupErrorCode =
  | "no-provider"
  | "timeout"
  | "provider-error"
  | "empty-output"
  | "too-long"
  | "preamble";

export interface CleanupResult {
  text: string;
  cleanupErrorCode?: CleanupErrorCode;
}

export interface CleanupRequest {
  prompt: string;
  /**
   * The longest answer `isSane` accepts. A runner must size its output budget
   * ABOVE this, never below: an answer cut off inside the acceptable range
   * reads exactly like a complete one, so the tail of a long dictation would be
   * dropped with nothing to show for it.
   */
  acceptableChars: number;
  signal: AbortSignal;
}

/**
 * How one cleanup prompt is run, resolved from the background-work choice
 * (docs/299-direct-provider-calls req 5). Aborting the signal must *cancel*
 * the run, not merely stop waiting for it — a harness left running would hold a
 * spawn home and keep spending.
 */
export interface CleanupRunner {
  /** Set by whoever built the runner, because a harness needs far longer than an API call. */
  deadlineMs: number;
  run(req: CleanupRequest): Promise<string>;
}

/** A cleaned transcript is the same message tidied, so its ceiling follows the transcript. */
export function acceptableCleanupLength(raw: string): number {
  return Math.max(40, raw.length * MAX_LENGTH_RATIO);
}

function isSane(raw: string, cleaned: string): CleanupErrorCode | null {
  if (!cleaned) return "empty-output";
  if (cleaned.length > acceptableCleanupLength(raw)) return "too-long";
  if (PREAMBLE_PATTERNS.some((p) => p.test(cleaned))) return "preamble";
  return null;
}

/**
 * The deadline is the orchestrator's own and is enforced by racing the run,
 * never by trusting whatever runs the work to answer
 * (docs/299-direct-provider-calls req 9). Passing a timeout downstream bounds
 * nothing: the worker's spawn transport defaults to 35 minutes and aborting it
 * does not cancel the spawn. So on the deadline this
 * returns the raw transcript at once and does NOT await the run — it only
 * signals it to cancel, which the cleanup container does by spawn id, leaving
 * every other request in that shared container alone.
 */
export async function cleanTranscript(
  raw: string,
  runner: CleanupRunner | null,
): Promise<CleanupResult> {
  if (!runner) {
    return { text: raw, cleanupErrorCode: "no-provider" };
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("deadline");
    }, runner.deadlineMs);
  });
  try {
    // Settling the run into a value before the race is what keeps a rejection
    // arriving after the deadline from going unhandled.
    const outcome = await Promise.race([
      // eslint-disable-next-line no-restricted-syntax -- the two-arg form is the point: await would abandon a rejection arriving after the deadline
      runner.run({
        prompt: buildCleanupPrompt(raw),
        acceptableChars: acceptableCleanupLength(raw),
        signal: controller.signal,
      }).then(
        (text) => ({ kind: "text" as const, text }),
        (err: unknown) => ({ kind: "error" as const, err }),
      ),
      deadline,
    ]);
    if (outcome === "deadline") return { text: raw, cleanupErrorCode: "timeout" };
    if (outcome.kind === "error") {
      const aborted = outcome.err instanceof Error && outcome.err.name === "AbortError";
      return { text: raw, cleanupErrorCode: aborted ? "timeout" : "provider-error" };
    }
    const cleaned = outcome.text.trim();
    const problem = isSane(raw, cleaned);
    if (problem) {
      return { text: raw, cleanupErrorCode: problem };
    }
    return { text: cleaned };
  } finally {
    clearTimeout(timer);
  }
}
