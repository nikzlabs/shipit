import { fillPromptTokens, loadPrompt } from "./load-prompt.js";
import { prepareDispatch } from "./prepared-dispatch.js";
import type { SessionRunnerInterface } from "./session-runner.js";

const NOTICE = loadPrompt(import.meta.url, "./prompts/permission-wait-notice.md");

export const PERMISSION_WAIT_NOTICE_MS = 2 * 60_000;
/** No turn could take the line; the next one can. */
export const PERMISSION_WAIT_RETRY_MS = 30_000;

type NoticeRunner = Pick<
  SessionRunnerInterface,
  | "sessionId"
  | "running"
  | "isStreamingActive"
  | "disposed"
  | "awaitingPermissionIds"
  | "appliedPermissionMode"
  | "viewerCount"
  | "dispatch"
>;

interface PermissionWait {
  summary: string;
  since: number;
}

interface Watch {
  /** The requests that the agent has not been told of. */
  waits: Map<string, PermissionWait>;
  timer: ReturnType<typeof setTimeout> | null;
}

const watches = new WeakMap<NoticeRunner, Watch>();

export function buildPermissionWaitNotice(
  waits: readonly PermissionWait[],
  opts: { now: number; userPresent: boolean },
): string {
  const one = waits.length === 1;
  const waited = `${Math.round((opts.now - Math.min(...waits.map((w) => w.since))) / 60_000)} minutes`;
  return fillPromptTokens(NOTICE, {
    WAITING: one ? "1 tool call waits" : `${waits.length} tool calls wait`,
    SINCE: one ? `It has waited ${waited}.` : `The oldest has waited ${waited}.`,
    PRESENCE: opts.userPresent ? "" : " No user has this session open now.",
    // The summary is the subagent's own text; a code span keeps it apart from ShipIt's words.
    CALLS: waits.map((w) => `- \`${w.summary.replaceAll("`", "'")}\``).join("\n"),
    TIME: new Date(opts.now).toISOString(),
  }).trim();
}

/**
 * docs/193-sensitive-file-permission req 2 — a pending request returns nothing, so the main
 * agent cannot see that a background subagent's call waits. The running turn gets one line.
 */
export function watchPermissionWait(
  runner: NoticeRunner,
  request: { requestId: string; summary: string },
): void {
  let watch = watches.get(runner);
  if (!watch) {
    watch = { waits: new Map(), timer: null };
    watches.set(runner, watch);
  }
  watch.waits.set(request.requestId, { summary: request.summary, since: Date.now() });
  arm(runner, watch, PERMISSION_WAIT_NOTICE_MS);
}

function arm(runner: NoticeRunner, watch: Watch, delayMs: number): void {
  if (watch.timer) return;
  watch.timer = setTimeout(() => {
    watch.timer = null;
    check(runner, watch);
  }, delayMs);
  watch.timer.unref?.();
}

function check(runner: NoticeRunner, watch: Watch): void {
  // Every way a request ends takes its id out of this set (`settlePermissionCard`).
  for (const requestId of [...watch.waits.keys()]) {
    if (!runner.awaitingPermissionIds.has(requestId)) watch.waits.delete(requestId);
  }
  if (runner.disposed || watch.waits.size === 0) {
    watches.delete(runner);
    return;
  }
  const now = Date.now();
  const waits = [...watch.waits.values()];
  const due = Math.min(...waits.map((w) => w.since)) + PERMISSION_WAIT_NOTICE_MS;
  if (now < due) {
    arm(runner, watch, due - now);
    return;
  }
  if (!tell(runner, waits, now)) {
    arm(runner, watch, PERMISSION_WAIT_RETRY_MS);
    return;
  }
  console.log(
    `[permission] told the agent of ${runner.sessionId} that ${waits.length} subagent call(s) wait for approval`,
  );
  watches.delete(runner);
}

function tell(runner: NoticeRunner, waits: readonly PermissionWait[], now: number): boolean {
  // Steer only. A dispatch to a runner with no turn starts one, and a new turn can replace
  // the resident process with the subagents that wait (docs/328-session-message-inbox).
  // A turn that does not stream takes no steer; asking would log a refusal at every retry.
  if (!runner.running || !runner.isStreamingActive) return false;
  try {
    const handle = runner.dispatch(
      prepareDispatch({
        text: buildPermissionWaitNotice(waits, { now, userPresent: runner.viewerCount > 0 }),
        agentInterface: undefined,
        execution: undefined,
        activity: undefined,
        images: undefined,
        files: undefined,
        uploads: undefined,
        // The running turn keeps its mode: a steer applies the mode of what it carries.
        permissionMode: runner.appliedPermissionMode,
        postTurn: undefined,
        automatic: true,
        heldId: undefined,
        onTurnComplete: undefined,
        deliveryId: undefined,
        dictated: undefined,
        resetMergedBranch: undefined,
        compactContext: undefined,
        silent: undefined,
        // A steer that the turn ended without is dropped, not queued as a turn of its own.
        bestEffortSteer: true,
      }),
      { whenBusy: "steer-or-refuse" },
    );
    return handle.admitted === "steered";
  } catch (err) {
    console.error(`[permission] telling the agent of ${runner.sessionId} about a waiting call failed:`, err);
    return false;
  }
}
