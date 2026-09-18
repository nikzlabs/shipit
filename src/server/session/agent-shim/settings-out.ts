import {
  renderJson,
  renderLine,
  type Rendered,
} from "../../shared/settings-catalogue/rendered.js";
import { fail, readBodyFromFileOrStdin, success, type ShimIO } from "./shim-common.js";
import { REJECTED_HELP, serverErrorMessage, serverErrorNote, type RunDeps } from "./shipit.js";

/**
 * The only way `shipit settings` writes anything (docs/299-agent-settings-access
 * req 2, planning#537).
 *
 * The settings commands are a line-oriented format an LLM parses, and the text
 * on those lines comes from stored values, from refusals a service composed and
 * from validator output. A brand crossing the process boundary is not a brand —
 * `renderValue` marks a string at the orchestrator, and the shim receives plain
 * JSON — so what the orchestrator renders has to be re-minted here. Three
 * previous fixes each guarded the ONE path that had just been found — stored
 * values, then item notes, then the refusals a service composes — and each left
 * the next one open, because the shim was free to print a string from anywhere.
 *
 * So the printer takes {@link Rendered} and nothing else, and
 * {@link SettingsDeps} carries NO {@link ShimIO}: `shipit-settings.ts` has no
 * `stdout`, no `fail` and no `success` in scope, so there is no second way out
 * of that module. A new refusal message, from a new service, on a new code
 * path, reaches the agent through `lines`/`fail` or it does not reach the agent
 * at all.
 *
 * **What that does NOT close.** The type stops an unrendered string being
 * printed; it does not stop a caller deciding, before minting, that an ingested
 * message's own newlines are the output's line structure —
 * `out.lines(message.split("\n").map(renderLine))` compiles, and every element
 * of it is honestly `Rendered`. So one rule is still the author's:
 * **never derive output STRUCTURE from text this process did not compose.**
 * {@link serverErrorLines} is the helper that exists so nobody has to make that
 * call for a relay error — it renders the server's message WHOLE and adds only
 * ShipIt's own note as a second line.
 */
export interface SettingsOut {
  /** Succeed, printing one output line per element. */
  lines(lines: readonly Rendered[]): void;
  /** Succeed with `--json`: one document, on one line. */
  json(body: unknown): void;
  fail(lines: readonly Rendered[], code?: number): never;
  /**
   * A value too long for a shell word, read from a file or stdin. It is the
   * command's INPUT rather than its output — it goes back to the orchestrator
   * as the proposed value and is never printed — so it stays a plain string.
   */
  readBody(source: string, errorPrefix: string, noun: string): Promise<string>;
}

export type SettingsDeps = Omit<RunDeps, "io"> & { out: SettingsOut };

/**
 * The shim's own help, as lines.
 *
 * Splitting a multi-line string on its newlines is exactly what must never be
 * done to a server message — each forged line would become a line of output.
 * It is safe HERE because this text is a module constant: its line breaks are
 * in the source, and nothing the orchestrator or the store said can reach it.
 */
export function rejectedHelpLines(): readonly Rendered[] {
  return REJECTED_HELP.split("\n").map(renderLine);
}

/**
 * A failed relay call, as lines: the orchestrator's message flattened whole,
 * then the shim's own note about the status if there is one.
 */
export function serverErrorLines(
  res: { status: number; body: Record<string, unknown> },
  fallback: string,
): readonly Rendered[] {
  const note = serverErrorNote(res.status);
  const message = renderLine(serverErrorMessage(res, fallback));
  return note ? [message, renderLine(""), renderLine(note)] : [message];
}

function outFor(io: ShimIO): SettingsOut {
  return {
    lines(lines) {
      success(io, lines.join("\n"));
    },
    json(body) {
      io.stdout(`${renderJson(body)}\n`);
      io.exit(0);
    },
    fail(lines, code = 2) {
      return fail(io, lines.join("\n"), code);
    },
    readBody(source, errorPrefix, noun) {
      // The one output of this module that the module does not compose: the
      // read's own failure path prints through `fail`, and it echoes the path
      // the caller typed. So it is handed an IO that renders instead of the
      // real one, which keeps "everything this module prints is rendered" a
      // statement about the module rather than about its happy path.
      const rendering: ShimIO = {
        stdout: (text) => io.stdout(text),
        stderr: (text) => io.stderr(`${renderLine(text.replace(/\n$/, ""))}\n`),
        exit: (code) => io.exit(code),
      };
      return readBodyFromFileOrStdin(source, rendering, errorPrefix, noun);
    },
  };
}

export function settingsDeps(deps: RunDeps): SettingsDeps {
  const { io, ...rest } = deps;
  return { ...rest, out: outFor(io) };
}
