import fs from "node:fs";
import path from "node:path";
import type { PersistedMessage } from "../chat-history.js";

/**
 * Inline budget for one tool input or one tool result. Anything longer is written to a
 * file and named in the replay instead (`docs/144-rewind-fork-ux` U8, resolved 2026-09-22).
 */
export const INLINE_DETAIL_LIMIT = 500;

/**
 * Where a replay's spilled tool payloads are written, and where the agent will see them.
 * The two differ because the orchestrator writes to the session's scratch directory on its
 * own filesystem while a containerized agent reads the same directory at `/persist`.
 */
export interface ReplaySpillTarget {
  hostDir: string;
  agentDir: string;
}

/**
 * A session's scratch directory, the sibling of its workspace that mounts at `/persist`
 * (`container-lifecycle.ts` defaults `scratchDir` to `<sessionRoot>/scratch`).
 *
 * `sessionRootDir` is the session's own directory, the PARENT of its workspace — the same
 * root the uploads directory hangs off.
 */
export function replaySpillDirs(
  sessionRootDir: string,
  opts: { containerized: boolean },
): ReplaySpillTarget {
  const hostDir = path.join(sessionRootDir, "scratch", "replay");
  return {
    hostDir,
    agentDir: opts.containerized ? "/persist/replay" : hostDir,
  };
}

/**
 * Owns the spill directory for one build of one replay.
 *
 * The directory is emptied first: a session holds exactly one armed replay, so files from
 * an earlier build are unreachable from the new one and would otherwise accumulate for the
 * life of the session.
 */
class SpillWriter {
  private index = 0;
  private usable: boolean;

  constructor(private readonly target: ReplaySpillTarget) {
    this.usable = this.reset();
  }

  private reset(): boolean {
    try {
      fs.rmSync(this.target.hostDir, { recursive: true, force: true });
      fs.mkdirSync(this.target.hostDir, { recursive: true });
      return true;
    } catch (err) {
      console.warn(`[replay] cannot use spill dir ${this.target.hostDir}:`, err);
      return false;
    }
  }

  /** The agent-visible path of the written file, or null to fall back to an excerpt. */
  write(toolName: string, body: string): string | null {
    if (!this.usable) return null;
    this.index += 1;
    const name = `${String(this.index).padStart(3, "0")}-${safeName(toolName)}.txt`;
    try {
      fs.writeFileSync(path.join(this.target.hostDir, name), body, "utf8");
    } catch (err) {
      console.warn(`[replay] failed to spill ${name}:`, err);
      this.usable = false;
      return null;
    }
    return `${this.target.agentDir}/${name}`;
  }
}

function safeName(toolName: string): string {
  const cleaned = toolName.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40);
  return cleaned || "tool";
}

function excerpt(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length <= INLINE_DETAIL_LIMIT
    ? flat
    : `${flat.slice(0, INLINE_DETAIL_LIMIT)}… (truncated)`;
}

function sizeNote(body: string): string {
  const bytes = Buffer.byteLength(body, "utf8");
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * One payload as the replay carries it: short ones inline, long ones as the name of a file
 * holding the whole thing. Without a spill target a long one degrades to an excerpt, which
 * is still more than the text-only replay carried.
 */
function payload(spill: SpillWriter | null, toolName: string, body: string): string {
  if (body.length <= INLINE_DETAIL_LIMIT) return excerpt(body);
  const spilled = spill?.write(toolName, body) ?? null;
  return spilled ? `(${sizeNote(body)}) ${spilled}` : excerpt(body);
}

function attachmentLine(m: PersistedMessage): string | null {
  const names: string[] = [];
  for (const f of m.files ?? []) names.push(f.path);
  for (const p of m.uploadPaths ?? []) names.push(p);
  const images = m.images?.length ?? 0;
  if (images > 0) names.push(`${images} image${images === 1 ? "" : "s"}`);
  return names.length > 0 ? `  [attached] ${names.join(", ")}` : null;
}

/**
 * The work a message did, which `role` and `text` alone cannot show.
 *
 * An assistant turn that only called tools persists with `text: ""`
 * (`chat-card-persistence.ts` keeps a group for its tool calls alone), so without these
 * lines it replays as a bare `Assistant:` and the agent has no record that the work
 * happened at all.
 */
export function detailLines(
  m: PersistedMessage,
  spill: SpillWriter | null,
): string[] {
  const lines: string[] = [];
  const attached = attachmentLine(m);
  if (attached) lines.push(attached);

  const results = new Map((m.toolResults ?? []).map((r) => [r.toolUseId, r]));
  for (const call of m.toolUse ?? []) {
    const input = payload(spill, call.name, JSON.stringify(call.input ?? {}));
    lines.push(`  [tool] ${call.name} ${input}`);
    const result = results.get(call.id);
    if (!result) continue;
    results.delete(call.id);
    const label = result.isError ? "result: error" : "result";
    lines.push(`  [${label}] ${payload(spill, call.name, result.content)}`);
  }
  // A result whose call is on an earlier row still says what the work produced.
  for (const orphan of results.values()) {
    const label = orphan.isError ? "result: error" : "result";
    lines.push(`  [${label}] ${payload(spill, "result", orphan.content)}`);
  }
  return lines;
}

export function openSpill(target: ReplaySpillTarget | undefined): SpillWriter | null {
  return target ? new SpillWriter(target) : null;
}

export type { SpillWriter };
