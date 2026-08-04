/**
 * Per-tool policy for tool **inputs** on the docs/244 wire projection
 * (SHI-296, reqs 1 and 5).
 *
 * The result side answers one question — "does anything draw this result's
 * content without a click?" (`rendersResultContentInline`). Inputs cannot be
 * answered that coarsely: a tool's input is a *bag of keys*, and the transcript
 * draws some of them and not others. A `Bash` call shows the first 80
 * characters of `command` and nothing else; a `Task` call shows `description`
 * and `subagent_type` while its `prompt` sits behind a collapsed disclosure; an
 * `AskUserQuestion` draws its whole `questions` structure as the card itself.
 * So the policy is per (tool, key), not per tool.
 *
 * ## The three treatments
 *
 * * **`keep`** — the transcript draws this value, in full, without a click. It
 *   must stay on the wire whatever its size, exactly like
 *   `WHOLE_RESULT_TOOL_NAMES` on the result side.
 * * **`head`** — the transcript draws a *fixed-length prefix*. Only `command`
 *   qualifies, and only because the renderer's own bound is a literal
 *   `slice(0, 80)` (`message-tools.tsx`), which makes the deletion provably
 *   invisible: the client slices to exactly what the server shipped.
 * * **`drop`** — nothing draws it until a click. The key leaves the payload
 *   entirely and comes back from `GET /api/sessions/:id/tool-inputs/:toolUseId`
 *   when the view that shows it opens.
 *
 * ## Where each `keep` comes from
 *
 * Every entry below was read off a render path, not assumed. The complete set
 * of components that touch `tool.input` is small enough to enumerate:
 *
 * | Reader | Keys |
 * |---|---|
 * | the compact one-line summary (`message-tools.tsx`) | `command` (first 80 chars), `file_path`, `pattern`, `query`, `url` |
 * | `DiffBlock` via Edit/Write | `file_path` (the body is replaced by `diffStats`) |
 * | `DiffBlock` via Codex `apply_patch` | `changes` / `files` — the `+N -M` is derived from each change's `diff` |
 * | `AskUserQuestion` | `questions` — the card *is* the transcript, and its branch returns before any modal |
 * | `TodoPanel` (`MessageList.tsx`) | `TodoWrite.todos` |
 * | `SubagentCall` | `description`, `subagent_type` (and `prompt`, behind a collapsed disclosure) |
 * | the `Skill` chip (`MessageToolUse.tsx`) | `skill`, `args` |
 * | `PresentToolChip` | `title` |
 * | `PlanApproval` (`findPlanContent`) | the **`content` of a `Write` to `.claude/plans/`** |
 *
 * That last row is the one this module exists to get right. `findPlanContent`
 * scans backwards for a `Write` whose path contains `.claude/plans/` and renders
 * its `content` as markdown *inline*, with no click and no fetch path — so the
 * blanket Edit/Write body strip shipped in docs/244 blanked the plan card on
 * every history load. Naming the marker here and importing it at both ends is
 * what keeps the two from drifting again.
 *
 * ## Deliberately NOT kept
 *
 * `ExitPlanMode.plan` is dropped. Nothing renders it: `PlanApproval` sources its
 * text from the `Write` above, and the `ExitPlanMode` branch returns before the
 * tool-call modal. It is still fetchable from the endpoint; it simply has no
 * view. Requirement 1 is the whole argument for dropping it.
 *
 * ## Sizes are bounded only where a bound is provable
 *
 * `pattern`, `query`, `url` and `questions` render inline with no length bound
 * of their own (the one-liner clips them with CSS, whose width depends on the
 * viewport). Slicing them would mean guessing at how many characters a wide
 * screen shows, so they are kept whole — the same trade `AskUserQuestion` makes
 * on the result side. In practice they are tens of bytes.
 */

import { SUBAGENT_TOOL_NAMES } from "./transcript-slice-tools.js";
import { isPresentTool } from "./tool-names.js";

/**
 * Below this, an input value is left on the wire instead of being stripped.
 *
 * Same reasoning as `RESULT_STRIP_FLOOR_BYTES`, arrived at independently for a
 * different payload class: stripping replaces the value with a `bodyTruncated`
 * marker plus an `inputChars` entry — roughly 40 bytes of JSON — and buys a
 * network round-trip. For a 12-byte `timeout` that is strictly worse.
 */
export const INPUT_STRIP_FLOOR_BYTES = 200;

/**
 * How many characters of `command` the transcript's one-line tool summary
 * draws. Imported by `message-tools.tsx` rather than duplicated, so the
 * projection's head slice and the renderer's `slice()` are the same number by
 * construction — the deletion is invisible only while they agree.
 */
export const COMMAND_SUMMARY_CHARS = 80;

/**
 * The path fragment that makes a `Write` a plan document whose body
 * `PlanApproval` renders inline. Imported by `findPlanContent`
 * (`MessageList.tsx`) so the reader and the projection cannot disagree about
 * which writes are plan documents.
 */
export const PLAN_DOC_PATH_MARKER = ".claude/plans/";

/** What the transcript draws from one input key. See the module docstring. */
export type InputKeyTreatment = "keep" | "head" | "drop";

/** Keys the compact one-line tool summary draws in full (`message-tools.tsx`). */
const SUMMARY_KEYS = new Set(["file_path", "pattern", "query", "url"]);

/**
 * Tools whose entire input the transcript draws, with no modal behind it.
 *
 * `AskUserQuestion` and `TodoWrite` render their input as the card itself and
 * return before the tool-call modal, so a dropped key would be unreachable
 * rather than deferred. `apply_patch` is here for a different reason: its
 * inline `+N -M` is derived from each change's `diff`, so the bodies *are* the
 * summary. Deferring them would need per-change stats and a per-change fetch
 * key, which is a second lazy mechanism for one backend's tool — recorded as a
 * known gap instead.
 */
const WHOLE_INPUT_TOOL_NAMES = new Set(["AskUserQuestion", "TodoWrite", "apply_patch"]);

/** Keys the subagent renderers draw beside the collapsed prompt. */
const SUBAGENT_SUMMARY_KEYS = new Set(["description", "subagent_type", "skill", "args"]);

/** True for a `Write` whose body `PlanApproval` renders inline (`findPlanContent`). */
export function isPlanDocumentWrite(toolName: string, input: Record<string, unknown>): boolean {
  return toolName === "Write"
    && typeof input.file_path === "string"
    && input.file_path.includes(PLAN_DOC_PATH_MARKER);
}

/**
 * How the projection must treat `key` in `toolName`'s input.
 *
 * Ordered most-specific first: a whole-input tool wins over everything, then
 * the plan-document exemption, then the keys the one-liner draws for *any*
 * tool, then the per-family rules, then the default — which is `drop`, because
 * the tool-call modal is the only other thing that reads an input and the modal
 * is a click.
 */
export function inputKeyTreatment(
  toolName: string,
  key: string,
  input: Record<string, unknown>,
): InputKeyTreatment {
  if (WHOLE_INPUT_TOOL_NAMES.has(toolName)) return "keep";
  if (key === "content" && isPlanDocumentWrite(toolName, input)) return "keep";
  if (SUMMARY_KEYS.has(key)) return "keep";
  if (SUBAGENT_TOOL_NAMES.has(toolName)) return SUBAGENT_SUMMARY_KEYS.has(key) ? "keep" : "drop";
  if (isPresentTool(toolName)) return key === "title" ? "keep" : "drop";
  if (key === "command") return "head";
  return "drop";
}
