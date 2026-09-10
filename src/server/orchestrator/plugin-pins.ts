import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { DeclaredPluginRepo } from "../shared/plugin-repos.js";

interface PinFile {
  pins: Record<string, string>;
}

export function pinStorePath(stateDir: string): string {
  return path.join(stateDir, "plugin-pins.json");
}

// Share pins across sessions of one project; other projects resolve independently.
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
  resolve: () => Promise<string>;
}

// Atomic rename alone cannot prevent concurrent read-modify-write from losing pins.
const storeLocks = new Map<string, Promise<unknown>>();

function withStoreLock<T>(storePath: string, task: () => Promise<T>): Promise<T> {
  const previous = storeLocks.get(storePath) ?? Promise.resolve();
  // eslint-disable-next-line no-restricted-syntax -- Promise two-arg form: run `task` whether the previous holder settled or rejected
  const next = previous.then(task, task);
  const tail = next.catch(() => undefined).finally(() => {
    if (storeLocks.get(storePath) === tail) storeLocks.delete(storePath);
  });
  storeLocks.set(storePath, tail);
  return next;
}

// Re-resolve to warn about moved tags, but retain the first recorded commit.
export function resolveDurablePin(args: DurablePinArgs): Promise<{ commit: string; warning?: string }> {
  return withStoreLock(args.storePath, async () => {
    const key = declarationPinKey(args.consumerKey, args.repo);
    const recorded = read(args.storePath).pins[key];

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
        // A deleted or ambiguous tag does not invalidate the recorded commit.
      }
      return { commit: recorded };
    }

    const resolved = await args.resolve();
    const store = read(args.storePath);
    const raced = store.pins[key];
    if (raced) return { commit: raced };
    store.pins[key] = resolved;
    await write(args.storePath, store);
    return { commit: resolved };
  });
}
