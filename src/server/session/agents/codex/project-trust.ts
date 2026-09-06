/**
 * Codex project trust — the `[projects."<dir>"] trust_level = "trusted"` entry
 * ShipIt writes into `$CODEX_HOME/config.toml` for the workspace it spawns the
 * app-server in.
 *
 * Codex gates a project's own `.codex/` directory on per-directory trust. Every
 * ShipIt workspace has one: `plugin-skills.ts` creates
 * `<workspace>/<skillsDirName>/skills` for EVERY harness, so `/workspace/.codex`
 * exists even in a session running another backend. Untrusted, the app-server
 * logs an ERROR on `initialize` and sends a `configWarning` notification:
 *
 *   Project-local config, hooks, and exec policies are disabled in the
 *   following folders until the project is trusted, but skills still load.
 *     1. /workspace/.codex
 *        To load project-local config, hooks, and exec policies, add /workspace
 *        as a trusted project in /credentials/.codex/config.toml.
 *
 * Skills still load, so the plugin path was never broken — but a repo carrying
 * its own `.codex/config.toml`, hooks or exec policies had them silently
 * dropped, and the ERROR line reads like a failure in every Codex session's log.
 *
 * Measured against codex-cli 0.153.2 by driving the real app-server (a bare
 * `initialize`, which is where the warning fires):
 *
 *  - The file entry works; a `-c 'projects."<dir>".trust_level="trusted"'`
 *    override on the command line does NOT — the warning survives it. So this
 *    cannot ride the `-c` position the docs/217 and docs/252 overrides use.
 *  - The trust key is the directory that CONTAINS `.codex`, found by walking up
 *    from the spawn cwd — not the cwd itself. Started in `<proj>/sub/deep`, the
 *    warning names `<proj>`, and trusting `<proj>/sub/deep` does not silence it.
 *    ShipIt spawns in the workspace root, which is where the `.codex` is, so the
 *    cwd IS that directory here — {@link ensureCodexProjectTrusted} takes the
 *    directory to trust and leaves that resolution to its caller.
 *
 * Trusting the workspace matches the posture the adapter already runs with:
 * ShipIt's session container IS the sandbox, so the turn starts with
 * `approvalPolicy: "never"` and `sandboxPolicy: { type: "dangerFullAccess" }`
 * (CLAUDE.md §5). This is the Codex counterpart of the Claude CLI's
 * `projects["/workspace"].hasTrustDialogAccepted` (see
 * `orchestrator/agents/claude/user-config.ts`).
 *
 * **It is nonetheless a deliberate capability change, not just quieter logs.**
 * A trusted project's `.codex/hooks` run on lifecycle events — repo-supplied
 * commands executing without the model choosing a tool call — so a repository
 * gains a way to act that "the agent may run anything anyway" does not already
 * cover. We take it because the alternative is a permanently half-loaded config
 * (Codex offers no partial trust), because the container is the boundary, and
 * because ShipIt already trusts the same workspace for Claude. `RUNTIME_MODE=local`
 * (the dogfood inner orchestrator) has no container boundary — same as Claude's
 * `ensureClaudeWorkspaceTrusted` there, and the same reason that mode is for
 * repos you already run in your own shell.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getErrorMessage } from "../../../shared/utils.js";

/** A TOML basic string — the same escaping `tomlString` in the adapter applies. */
function tomlBasicString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * What `existing` already says about `projects`, from the one angle that
 * matters here: may a `[projects."<dir>"]` table be appended to it?
 *
 * - `absent` — nothing declares it; appending is safe.
 * - `declared` — the dir already has an entry. Presence, not value: it was
 *   written either by an earlier run of this function or by the user / the
 *   Codex CLI, and an explicit `trust_level = "untrusted"` is a decision to
 *   respect rather than overwrite.
 * - `ambiguous` — `projects` is declared in a shape this scanner will not
 *   claim to understand (a bare `[projects]` table, an array of tables, a
 *   header it could not parse). Appending could then DUPLICATE a key, which is
 *   not a cosmetic problem: duplicate definitions make the whole file invalid
 *   TOML, and Codex fails to start rather than merely warning. Skipping costs
 *   only the warning this module exists to remove.
 *
 * The equivalence classes are the reason this is not a string compare:
 * `[projects."/workspace"] # mine`, `[projects.'/workspace']` and
 * `[ projects . "/workspace" ]` all declare the same table.
 */
export type CodexProjectsState = "absent" | "declared" | "ambiguous";

/**
 * Split a TOML dotted key (a table header's inside, or the key half of a
 * `key = value` line) into its decoded segments. Returns null when the text is
 * not a well-formed dotted key — the caller treats that as `ambiguous` rather
 * than guessing.
 */
function parseDottedKey(text: string): string[] | null {
  const segments: string[] = [];
  let rest = text.trim();
  for (;;) {
    let segment: string;
    const quote = rest[0];
    if (quote === '"' || quote === "'") {
      // Basic strings take escapes, literal strings take none.
      let i = 1;
      let value = "";
      for (; i < rest.length && rest[i] !== quote; i++) {
        if (quote === '"' && rest[i] === "\\") {
          const next = rest[++i];
          if (next === undefined) return null;
          value += next === "\\" || next === '"' ? next : `\\${next}`;
          continue;
        }
        value += rest[i];
      }
      if (rest[i] !== quote) return null;
      segment = value;
      rest = rest.slice(i + 1).trimStart();
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(rest);
      if (!match) return null;
      segment = match[0];
      rest = rest.slice(match[0].length).trimStart();
    }
    segments.push(segment);
    if (rest === "") return segments;
    if (!rest.startsWith(".")) return null;
    rest = rest.slice(1).trimStart();
  }
}

/**
 * The inside of a table header, or null when `line` is not one. Scans for the
 * closing bracket with quote awareness (a `]` or a `#` inside a quoted key is
 * data), and rejects anything but whitespace or a comment after it.
 */
function tableHeaderBody(line: string): string | null {
  if (!line.startsWith("[")) return null;
  let quote: string | null = null;
  for (let i = 1; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "]") {
      const after = line.slice(i + 1).trim();
      if (after !== "" && !after.startsWith("#")) return null;
      return line.slice(1, i);
    }
  }
  return null;
}

/** Whether a line could possibly be talking about the `projects` table. */
function mentionsProjects(line: string): boolean {
  return /(^|[[.\s"'])projects([\s.\]"']|$)/.test(line);
}

/** See {@link CodexProjectsState}. */
export function codexProjectsState(existing: string, dir: string): CodexProjectsState {
  let state: CodexProjectsState = "absent";
  let sawTableHeader = false;
  for (const raw of existing.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    if (line.startsWith("[")) {
      sawTableHeader = true;
      // `[[projects…]]` — an array of tables, which our table header cannot
      // coexist with. Never emitted by ShipIt or the CLI, so don't model it.
      if (line.startsWith("[[")) {
        if (mentionsProjects(line)) state = "ambiguous";
        continue;
      }
      const body = tableHeaderBody(line);
      if (body === null) {
        if (mentionsProjects(line)) state = "ambiguous";
        continue;
      }
      const segments = parseDottedKey(body);
      if (segments === null) {
        if (mentionsProjects(line)) state = "ambiguous";
        continue;
      }
      if (segments[0] !== "projects") continue;
      // `[projects]` — the dir's key may or may not live inside it, and this
      // scanner does not parse table bodies. Refuse rather than risk a dup.
      if (segments.length === 1) return "ambiguous";
      // `[projects."<dir>"]`, and also `[projects."<dir>".sub]`, which defines
      // the same table implicitly.
      if (segments[1] === dir) return "declared";
      continue;
    }

    // A dotted key — `projects."<dir>".trust_level = "trusted"` is the same
    // declaration written without a header. Only before the first table
    // header: past one, the key belongs to THAT table, not to the root.
    if (sawTableHeader || !mentionsProjects(line)) continue;
    const eq = line.indexOf("=");
    if (eq === -1) { state = "ambiguous"; continue; }
    const segments = parseDottedKey(line.slice(0, eq));
    if (segments === null) { state = "ambiguous"; continue; }
    if (segments[0] === "projects" && (segments.length === 1 || segments[1] === dir)) {
      return "declared";
    }
  }
  return state;
}

/**
 * Ensure `$configDir/config.toml` trusts `projectDir`, creating the file if
 * `configDir` exists. Returns whether the file was written.
 *
 * Idempotent and safe to call on every spawn, and best-effort: an unwritable or
 * unreadable config must not fail a turn — the worst case of skipping is the
 * pre-existing behaviour, a warning and project-local config left unloaded.
 *
 * **It never CREATES the config dir**, only a file inside one. Every production
 * caller already has one: `writeMcpConfig` mkdirs it before every resident turn,
 * and a sub-agent spawn's isolated home is materialized with a `.codex` by
 * `agentCredentialDirs`. Creating it here would instead mean any caller passing
 * a not-yet-real home (a unit test's fake account root) silently grew a
 * directory tree on disk.
 *
 * The entry is APPENDED, so it lands outside the `# <shipit-managed-mcp>`
 * block the adapter rewrites before every turn (that block is replaced between
 * its markers, and anything after the end marker is preserved verbatim).
 */
export function ensureCodexProjectTrusted(configDir: string, projectDir: string): boolean {
  const dir = path.resolve(projectDir);
  const configPath = path.join(configDir, "config.toml");
  if (!existsSync(configDir)) return false;
  try {
    let existing = "";
    try {
      existing = readFileSync(configPath, "utf-8");
    } catch { /* no config yet */ }

    if (codexProjectsState(existing, dir) !== "absent") return false;

    const block = [
      "# ShipIt trusts the workspace it spawns Codex in, so the repo's own",
      "# .codex/ config, hooks and exec policies load. To opt out, KEEP this",
      "# table and set trust_level = \"untrusted\" — ShipIt only ever adds the",
      "# table when the config declares no `projects` entry for the directory,",
      "# so deleting it just brings it back on the next turn.",
      `[projects.${tomlBasicString(dir)}]`,
      `trust_level = "trusted"`,
      "",
    ].join("\n");

    writeFileSync(configPath, `${existing.trimEnd()}${existing.trimEnd() ? "\n\n" : ""}${block}`);
    return true;
  } catch (err) {
    console.warn(`[codex] could not trust ${dir} in ${configPath}: ${getErrorMessage(err)}`);
    return false;
  }
}
