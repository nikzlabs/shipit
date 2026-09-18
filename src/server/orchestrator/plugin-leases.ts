import type Docker from "dockerode";
import type { BeginGenerationDeletion } from "./plugin-generations.js";
import { pluginOverlayVolumeName, removePluginOverlay } from "./plugin-overlay.js";

export interface GenerationRef {
  sessionId: string;
  repoName: string;
  generationId: string;
}

export type ReleaseHold = () => void;

// Tokens prevent a late release after session disposal from dropping a new hold.
const holds = new Map<string, Set<object>>();
const deleting = new Set<string>();
const owners = new Map<string, Map<string, ReleaseHold>>();

function generationKey(ref: GenerationRef): string {
  return `${ref.sessionId}::${ref.repoName}::${ref.generationId}`;
}

export function pluginServiceOwner(sessionId: string): string {
  return `services::${sessionId}`;
}

// Resolve the generation and take its hold in one synchronous block, before
// creating its container. A volume alone cannot protect this interval.
export function holdGeneration(ref: GenerationRef): ReleaseHold | null {
  const key = generationKey(ref);
  if (deleting.has(key)) return null;
  const token = {};
  const set = holds.get(key) ?? new Set<object>();
  set.add(token);
  holds.set(key, set);
  return () => {
    const current = holds.get(key);
    if (!current?.delete(token)) return;
    if (current.size === 0) holds.delete(key);
  };
}

export function holdGenerationsForOwner(
  owner: string,
  refs: readonly GenerationRef[],
): GenerationRef[] {
  const previous = owners.get(owner) ?? new Map<string, ReleaseHold>();
  const next = new Map<string, ReleaseHold>();
  const held: GenerationRef[] = [];

  for (const ref of refs) {
    const key = generationKey(ref);
    if (next.has(key)) continue;
    const release = holdGeneration(ref);
    if (!release) continue;
    next.set(key, release);
    held.push(ref);
  }

  for (const release of previous.values()) release();

  if (next.size === 0) owners.delete(owner);
  else owners.set(owner, next);
  return held;
}

export function releaseSessionGenerationHolds(sessionId: string): void {
  const prefix = `${sessionId}::`;
  for (const [owner, held] of [...owners]) {
    for (const [key, release] of [...held]) {
      if (!key.startsWith(prefix)) continue;
      release();
      held.delete(key);
    }
    if (held.size === 0) owners.delete(owner);
  }
  for (const key of [...holds.keys()]) {
    if (key.startsWith(prefix)) holds.delete(key);
  }
  // Only the pruner releases its deletion claim; disposal must not admit another.
}

export function generationHoldCount(ref: GenerationRef): number {
  return holds.get(generationKey(ref))?.size ?? 0;
}

// Keep the check and claim synchronous so no consumer can acquire a hold between them.
export function claimGenerationDeletion(ref: GenerationRef): ReleaseHold | null {
  const key = generationKey(ref);
  if (deleting.has(key) || holds.has(key)) return null;
  deleting.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    deleting.delete(key);
  };
}

// Docker attachments protect consumers across orchestrator restarts. Remove the
// volume before its backing directories, and refuse deletion if it remains held.
export function createGenerationDeletionLease(deps: {
  docker: Docker;
  sessionId: string;
}): BeginGenerationDeletion {
  return async ({ repoName, generationId }) => {
    const claim = claimGenerationDeletion({ sessionId: deps.sessionId, repoName, generationId });
    if (!claim) return null;
    const volume = pluginOverlayVolumeName(deps.sessionId, repoName, generationId);
    let released: boolean;
    try {
      released = await removePluginOverlay(deps.docker, volume);
    } catch {
      released = false;
    }
    if (!released) {
      claim();
      return null;
    }
    return claim;
  };
}
