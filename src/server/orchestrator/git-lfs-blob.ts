import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isGitLfsAvailable } from "./git-lfs.js";
import { killChild } from "../shared/kill-child.js";
import { gitArgsWithHooksDisabled } from "../shared/git-hooks-guard.js";
import { gitSpawnOverridesForTree } from "../shared/git-tree-uid.js";

/**
 * Resolve a Git LFS pointer blob to the bytes it stands for, for *rendering*
 * surfaces (the diff viewer's image panes).
 *
 * ## Why the diff viewer needs this at all
 *
 * `git-lfs.ts` materializes LFS content into the **working tree** at
 * provisioning, which is why the file viewer shows real images. The diff viewer
 * doesn't read the working tree — it reads blobs at two commits (`git show
 * <ref>:<path>`), and in an LFS repo the *committed* blob is always the ~130-byte
 * pointer stub. No amount of `git lfs pull` changes that. So an LFS-tracked PNG
 * rendered as a diff shows its sha256 as text (nikzlabs/shipit#1729 follow-up).
 *
 * The pointer path is not the binary path, either. The conventional
 * `.gitattributes` line — `*.png filter=lfs diff=lfs merge=lfs -text` — leaves
 * git's `diff` attribute *set* (to the `lfs` driver) and `-text` only disables
 * eol munging; neither marks the blob binary. git then sniffs the content, sees
 * ASCII, and reports a normal 2-insertion/2-deletion **text** diff. That's why
 * the fix lives on the text side of `buildFileDiffContent` and not only behind
 * its `isBinary` branch.
 *
 * ## Resolution order: local store, then network
 *
 *  1. **`.git/lfs/objects/<a>/<b>/<oid>`** — a plain file read, no subprocess and
 *     no network. This hits for the "after" side of almost every diff, because
 *     provisioning already pulled the objects for the checked-out ref (and
 *     docs/232 hardlinks the shared cache's objects in).
 *  2. **`git lfs smudge`** — the "before" side usually *misses* the local store:
 *     `git lfs pull` fetches objects for the current checkout, not for history.
 *     Without a network fallback the panel would render "After" and an empty
 *     "Before" on every modified image, which is half a feature. Explicitly
 *     invoking `smudge` is unaffected by the orchestrator's
 *     `git lfs install --skip-smudge` — that install writes a `--skip` *argument*
 *     into `filter.lfs.smudge`, so a call we construct ourselves downloads
 *     normally.
 *
 * Every failure returns `null` rather than throwing: a diff whose image couldn't
 * be fetched must still render its other files.
 *
 * ## Why the network fallback is budgeted
 *
 * A diff touching 50 LFS images would otherwise issue 100 serial downloads
 * against a remote that may be slow or unreachable, holding the diff request open
 * for minutes. {@link createLfsBlobResolver} therefore caps network smudges per
 * diff ({@link DEFAULT_NETWORK_FETCH_BUDGET}) and per call
 * ({@link SMUDGE_TIMEOUT_MS}). Over budget degrades to the same "(Git LFS content
 * unavailable)" pane as a fetch failure — bounded latency beats total coverage on
 * a surface the user is waiting on.
 */

/** Every v1 pointer's first line; also our cheap "is this a pointer" prefix test. */
const POINTER_V1_HEADER = "version https://git-lfs.github.com/spec/v1";

/**
 * A real pointer is ~130 bytes. Anything larger isn't one, and the ceiling keeps
 * us from running a regex over a multi-megabyte blob on every binary file.
 */
const MAX_POINTER_BYTES = 1024;

/** Ceiling on one `git lfs smudge`. The user is watching the diff panel load. */
const SMUDGE_TIMEOUT_MS = 15_000;
const SMUDGE_TIMEOUT_ENV = "SHIPIT_GIT_LFS_DIFF_TIMEOUT_MS";

/** Network smudges allowed per diff request — see "Why the network fallback is budgeted". */
const DEFAULT_NETWORK_FETCH_BUDGET = 8;
const NETWORK_FETCH_BUDGET_ENV = "SHIPIT_GIT_LFS_DIFF_FETCH_BUDGET";

export interface LfsPointer {
  /** sha256 hex digest of the real content — also its name in the object store. */
  oid: string;
  /** Byte length of the real content, per the pointer. */
  size: number;
}

/**
 * Parse an LFS v1 pointer, or `null` if this isn't one.
 *
 * Deliberately strict on the header and lenient on ordering/extra keys: the spec
 * lets a pointer carry additional `ext-0-…` lines, and misreading a hand-written
 * text file that merely mentions LFS as a pointer would replace a real text diff
 * with an image pane.
 */
export function parseLfsPointer(content: string | Buffer): LfsPointer | null {
  if (content.length === 0 || content.length > MAX_POINTER_BYTES) return null;
  const text = typeof content === "string" ? content : content.toString("utf-8");
  if (!text.startsWith(POINTER_V1_HEADER)) return null;

  let oid: string | null = null;
  let size: number | null = null;
  for (const line of text.split("\n")) {
    const oidMatch = /^oid sha256:([0-9a-f]{64})$/.exec(line.trim());
    if (oidMatch) oid = oidMatch[1];
    const sizeMatch = /^size (\d+)$/.exec(line.trim());
    if (sizeMatch) size = Number(sizeMatch[1]);
  }
  if (!oid || size === null || !Number.isSafeInteger(size)) return null;
  return { oid, size };
}

/**
 * Path of an object in a clone's LFS store.
 *
 * The two-level fanout (`ab/cd/abcd…`) is git-lfs's own layout; the full oid is
 * repeated as the filename, so this is not `oid.slice(4)`.
 */
export function lfsObjectPath(workspaceDir: string, oid: string): string {
  return path.join(workspaceDir, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid);
}

function smudgeTimeoutMs(): number {
  const raw = Number(process.env[SMUDGE_TIMEOUT_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : SMUDGE_TIMEOUT_MS;
}

function networkFetchBudget(): number {
  const raw = Number(process.env[NETWORK_FETCH_BUDGET_ENV]);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_NETWORK_FETCH_BUDGET;
}

/** Read an object out of the clone's own LFS store. `null` = not cached locally. */
function readLocalLfsObject(workspaceDir: string, pointer: LfsPointer): Buffer | null {
  try {
    const buf = fs.readFileSync(lfsObjectPath(workspaceDir, pointer.oid));
    // A length mismatch means a truncated or half-written object; treat it as a
    // miss so the network path can produce the real bytes.
    return buf.length === pointer.size ? buf : null;
  } catch {
    return null;
  }
}

/**
 * Download one object by piping its pointer through `git lfs smudge`.
 *
 * On failure git-lfs exits non-zero **and echoes the pointer back on stdout**
 * (verified against git-lfs 3.3.0), so the caller must reject pointer-shaped
 * output as well as a bad exit code — returning it would re-embed the checksum
 * as image bytes, which is the exact bug this module exists to fix.
 */
function smudgeLfsObject(workspaceDir: string, pointerText: string, filePath: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let proc;
    try {
      // docs/266 — `git lfs smudge` resolves `filter.lfs.smudge` from the
      // repository's own config, which is the executable-config route this
      // feature exists to close, and this tree is one untrusted code can write.
      // Drop to the tree's owner so the filter runs at its author's authority.
      const treeOverrides = gitSpawnOverridesForTree(workspaceDir);
      proc = spawn("git", gitArgsWithHooksDisabled(["lfs", "smudge", "--", filePath]), {
        cwd: workspaceDir,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        stdio: ["pipe", "pipe", "ignore"],
        ...treeOverrides,
      });
    } catch {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    proc.stdout.on("data", (c: Buffer) => {
      chunks.push(c);
      bytes += c.length;
    });
    const timer = setTimeout(() => killChild(proc, "SIGKILL"), smudgeTimeoutMs());
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || bytes === 0) {
        resolve(null);
        return;
      }
      const out = Buffer.concat(chunks);
      resolve(parseLfsPointer(out) ? null : out);
    });
    proc.stdin.on("error", () => {
      /* EPIPE when git-lfs exits before reading — handled by the close listener. */
    });
    proc.stdin.end(pointerText);
  });
}

/**
 * Resolves LFS pointers to real bytes, with a network budget shared across one
 * diff request.
 *
 * `maxBytes` is checked against the pointer's declared `size` *before* any read,
 * so an oversized asset costs nothing rather than being downloaded and discarded.
 */
export type LfsBlobResolver = (
  pointerText: string | Buffer,
  filePath: string,
  maxBytes: number,
) => Promise<Buffer | null>;

export function createLfsBlobResolver(
  workspaceDir: string,
  /** Test seam — `isAvailable` overrides the memoized `git lfs version` probe. */
  opts?: { isAvailable?: () => Promise<boolean>; networkBudget?: number },
): LfsBlobResolver {
  let remainingFetches = opts?.networkBudget ?? networkFetchBudget();
  let available: Promise<boolean> | null = null;

  return async (pointerText, filePath, maxBytes) => {
    const pointer = parseLfsPointer(pointerText);
    if (!pointer || pointer.size === 0 || pointer.size > maxBytes) return null;

    const local = readLocalLfsObject(workspaceDir, pointer);
    if (local) return local;

    if (remainingFetches <= 0) return null;
    available ??= (opts?.isAvailable ?? isGitLfsAvailable)();
    if (!(await available)) return null;

    // Decrement before awaiting: concurrent resolutions must not all observe the
    // pre-fetch budget and collectively blow through it.
    remainingFetches--;
    const text = typeof pointerText === "string" ? pointerText : pointerText.toString("utf-8");
    const fetched = await smudgeLfsObject(workspaceDir, text, filePath);
    if (!fetched) {
      console.warn(`[git-lfs-blob] Could not fetch LFS content for ${filePath} (oid ${pointer.oid.slice(0, 12)})`);
      return null;
    }
    return fetched;
  };
}
