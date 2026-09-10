import { EventEmitter } from "node:events";
import type { WsServerMessage } from "../shared/types/ws-server-messages.js";
import type { ResetEligibleSignalDeps } from "./services/pre-turn-reset.js";
import { emitResetEligible } from "./services/pre-turn-reset.js";

export const RESET_ELIGIBLE_WATCH_DEBOUNCE_MS = 750;
export const RESET_ELIGIBLE_WATCH_MAX_WAIT_MS = 5_000;

export interface ResetEligibleWatchRunner {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly running: boolean;
  emitMessage(msg: WsServerMessage): void;
  on(event: "message", listener: (msg: WsServerMessage) => void): unknown;
  on(event: "disposed", listener: () => void): unknown;
  getMaxListeners(): number;
  setMaxListeners(n: number): unknown;
}

// External writers can change eligibility between turns. Always emit: other emitters
// can replace the client's value without updating a watcher-local deduplication cache.
export function wireResetEligibleOnFileChange(
  deps: ResetEligibleSignalDeps,
  runner: ResetEligibleWatchRunner,
  opts: { debounceMs?: number; maxWaitMs?: number } = {},
): void {
  const debounceMs = opts.debounceMs ?? RESET_ELIGIBLE_WATCH_DEBOUNCE_MS;
  const maxWaitMs = opts.maxWaitMs ?? RESET_ELIGIBLE_WATCH_MAX_WAIT_MS;
  let timer: NodeJS.Timeout | null = null;
  let disposed = false;
  let pendingSince: number | null = null;
  let inFlight = false;
  let missedWhileInFlight = false;

  const schedule = (delayMs: number): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(recompute, delayMs);
    timer.unref?.();
  };

  function recompute(): void {
    timer = null;
    if (disposed) return;
    // The active git read can predate this change; schedule another after it settles.
    if (inFlight) {
      missedWhileInFlight = true;
      return;
    }
    pendingSince = null;
    // Post-turn recomputation covers agent writes.
    if (runner.running) return;
    inFlight = true;
    void (async () => {
      try {
        await emitResetEligible(deps, {
          sessionId: runner.sessionId,
          sessionDir: runner.sessionDir,
          origin: "file-change",
          emit: (msg) => {
            if (!disposed) runner.emitMessage(msg);
          },
        });
      } catch (err) {
        console.error(`[pre-turn-reset] file-change eligibility recompute failed for ${runner.sessionId}:`, err);
      } finally {
        inFlight = false;
        if (missedWhileInFlight) {
          missedWhileInFlight = false;
          if (!disposed) {
            pendingSince = Date.now();
            schedule(debounceMs);
          }
        }
      }
    })();
  }

  runner.on("message", (msg: WsServerMessage) => {
    if (disposed || msg.type !== "files_changed") return;
    if (!deps.getSession(runner.sessionId)?.mergedAt) return;
    const now = Date.now();
    pendingSince ??= now;
    // Cap the trailing debounce so continuous writes cannot starve recomputation.
    schedule(Math.max(0, Math.min(debounceMs, pendingSince + maxWaitMs - now)));
  });

  runner.on("disposed", () => {
    disposed = true;
    missedWhileInFlight = false;
    if (timer) clearTimeout(timer);
    timer = null;
  });

  // Account for this permanent listener without replacing a custom ceiling.
  if (runner.getMaxListeners() === EventEmitter.defaultMaxListeners) {
    runner.setMaxListeners(EventEmitter.defaultMaxListeners + 1);
  }
}
