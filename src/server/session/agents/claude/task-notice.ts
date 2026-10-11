import type { ClaudeEvent } from "../../../shared/types.js";

/**
 * Measured on 2.1.284 (docs/235-agent-self-wake-liveness §8): a CLI resumed after its
 * predecessor exited with a background job outstanding closes that job's notice with a
 * `result` that ran no model turn, and only then reads its prompt. A leaf module, so the
 * adapter and the goal control process can both read it.
 */
export function closesTaskNoticeWithoutTurn(raw: ClaudeEvent): boolean {
  return raw.type === "result"
    && raw.subtype === "success"
    && raw.is_error !== true
    && raw.num_turns === 0
    && raw.origin?.kind === "task-notification";
}
