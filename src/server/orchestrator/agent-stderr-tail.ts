/**
 * The tail of an agent CLI's stderr for a single turn, shaped for a chat row.
 *
 * When an agent process dies without producing an `agent_result`, the only
 * thing the user is left with is the persisted error row `turn-executor.ts`
 * writes — and that row used to say nothing but `Agent process exited with code
 * 1`. The actual reason was never lost, just misrouted: both adapters forward
 * stderr as a `log` event, which reaches the Logs panel and the durable
 * `sessions/<id>/logs/agent.jsonl`. Neither survives into the transcript, which
 * is the artifact the user still has after a reload. A Codex cold-start failure
 * printed `failed to initialize sqlite state runtime under <dir>` and the user
 * saw an exit code, so diagnosing it needed a filesystem dig.
 *
 * This collects that stderr per turn and renders it as one bounded, redacted,
 * single-line clause the error row can append.
 *
 * **Redaction is not optional here.** stderr is raw CLI output: it routinely
 * carries absolute paths (which leak project and account names — the failure
 * above named the account directory) and can carry tokens outright. It goes
 * through the same deterministic Stage-1 floor as a bug-report body
 * (`services/redaction.ts`), so a secret never enters the transcript in the
 * first place. Stage 2's model pass is deliberately NOT used: it is async,
 * spawns a CLI, and this runs on a path whose whole job is to report that
 * spawning a CLI just failed. What survives Stage 1 is still diagnostic — the
 * message above degrades to `failed to initialize sqlite state runtime under
 * [REDACTED]`, which names the fault exactly.
 */

import { redactStage1 } from "./services/redaction.js";

/**
 * How much redacted stderr to keep. Long enough for a CLI's fatal line (the
 * ones we've seen run 90–200 chars) and short enough that the chat row stays a
 * row. The full text is already in the durable agent log for anyone who needs
 * more.
 */
export const AGENT_STDERR_TAIL_MAX_CHARS = 300;

/**
 * Raw stderr retained before redaction. Bounded separately and generously: a
 * crashing CLI can emit a lot, we only ever render the end of it, and holding
 * more than this per live turn buys nothing.
 */
const RAW_BUFFER_MAX_CHARS = 8_000;

export interface AgentStderrTail {
  /**
   * Record one `log` event. Non-stderr sources are ignored, so this can be
   * wired to the single `log` listener without filtering at the call site.
   */
  record(source: string, text: string): void;
  /**
   * The redacted tail as a single line, or `undefined` when the turn produced
   * no stderr worth showing (the common case for a healthy exit).
   */
  describe(): string | undefined;
}

/**
 * Does this `log` source carry stderr? Claude emits `"stderr"`, Codex emits
 * `"codex-stderr"`; matching the suffix covers both without a per-agent list
 * that a third backend would silently fall out of.
 */
function isStderrSource(source: string): boolean {
  return source.endsWith("stderr");
}

export function createAgentStderrTail(): AgentStderrTail {
  let raw = "";

  return {
    record(source: string, text: string): void {
      if (!isStderrSource(source) || !text) return;
      raw = `${raw}${raw ? "\n" : ""}${text}`;
      if (raw.length > RAW_BUFFER_MAX_CHARS) raw = raw.slice(-RAW_BUFFER_MAX_CHARS);
    },

    describe(): string | undefined {
      if (!raw.trim()) return undefined;
      // Redact BEFORE truncating: slicing first could cut a secret in half and
      // leave a fragment no pattern matches any more.
      const redacted = redactStage1(raw).text;
      // One line — the row is a sentence, not a log pane. Collapse the runs of
      // whitespace that a multi-line stack trace would otherwise smear across.
      const collapsed = redacted.replace(/\s+/g, " ").trim();
      if (!collapsed) return undefined;
      return collapsed.length > AGENT_STDERR_TAIL_MAX_CHARS
        // Keep the END: a CLI's fatal line is the last thing it prints.
        ? `…${collapsed.slice(-AGENT_STDERR_TAIL_MAX_CHARS)}`
        : collapsed;
    },
  };
}
