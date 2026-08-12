/**
 * docs/262 req 8 — **durable pin resolutions**, scoped to the consuming
 * project's declaration.
 *
 * A pinned tag resolves to a commit exactly once. Every later activation
 * reuses that commit, so re-tagging `v1` upstream warns instead of silently
 * moving the plugin under a project that asked for a fixed version; only
 * editing the declaration re-resolves.
 *
 * **Not per session** (review finding). The first draft kept this in the
 * session state dir, which meant two sessions of the same project could
 * resolve the same moved tag to different commits — the exact drift req 8
 * forbids. The store is therefore orchestrator-wide and keyed by
 * `consumer | repo-name | source | pin`: the *declaration*, since editing the
 * declaration is what re-resolution is defined against.
 *
 * Writes are atomic (temp file + rename): a crash mid-write would otherwise
 * corrupt every pin in the file and silently re-resolve them all.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { DeclaredPluginRepo } from "../shared/plugin-repos.js";

interface PinFile {
  /** declaration key → resolved commit. */
  pins: Record<string, string>;
}

/** Path of the orchestrator-wide pin store, given the app state dir. */
export function pinStorePath(stateDir: string): string {
  return path.join(stateDir, "plugin-pins.json");
}

/**
 * The key a resolution is recorded under. `consumerKey` identifies the
 * consuming project (its remote URL, or the session id for a session with no
 * remote), so two projects pinning the same tag are independent while two
 * sessions of ONE project agree.
 */
export function declarationPinKey(consumerKey: string, repo: DeclaredPluginRepo): string {
  const source = repo.source.kind === "self" ? "self" : `${repo.source.owner}/${repo.source.repo}`;
  return `${consumerKey}|${repo.name}|${source}|${repo.pin ?? ""}`;
}

function read(storePath: string): PinFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf-8")) as PinFile;
    return parsed && typeof parsed === "object" && parsed.pins ? parsed : { pins: {} };
  } catch {
    return { pins: {} };
  }
}

async function write(storePath: string, file: PinFile): Promise<void> {
  await fsp.mkdir(path.dirname(storePath), { recursive: true });
  const tmp = `${storePath}.tmp-${crypto.randomUUID().slice(0, 8)}`;
  await fsp.writeFile(tmp, JSON.stringify(file, null, 2));
  await fsp.rename(tmp, storePath);
}

export interface DurablePinArgs {
  storePath: string;
  consumerKey: string;
  repo: DeclaredPluginRepo;
  /** Resolve the pin against the fetched repository. Called only when needed. */
  resolve: () => Promise<string>;
}

/**
 * The commit this declaration is pinned to, recording it on first resolution.
 *
 * A recorded pin is returned **without re-resolving**: the point of durability
 * is that the pinned commit survives whatever happened to the tag upstream —
 * including the tag being deleted, or an abbreviated name becoming ambiguous.
 * Resolution still runs opportunistically to detect a moved tag, but a failure
 * there is not fatal once a commit is recorded.
 */
export async function resolveDurablePin(
  args: DurablePinArgs,
): Promise<{ commit: string; warning?: string }> {
  const key = declarationPinKey(args.consumerKey, args.repo);
  const store = read(args.storePath);
  const recorded = store.pins[key];

  if (recorded) {
    try {
      const current = await args.resolve();
      if (current !== recorded) {
        return {
          commit: recorded,
          warning:
            `\`${args.repo.pin}\` now points at ${current.slice(0, 9)} upstream, but this project is `
            + `pinned to ${recorded.slice(0, 9)}. Edit the declaration to move it.`,
        };
      }
    } catch {
      // The tag is gone or ambiguous now — irrelevant, we have the commit.
    }
    return { commit: recorded };
  }

  const resolved = await args.resolve();
  store.pins[key] = resolved;
  await write(args.storePath, store);
  return { commit: resolved };
}
