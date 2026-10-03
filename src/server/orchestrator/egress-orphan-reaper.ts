// Reap by parent container ID and liveness: session IDs are reused, and OOM can spare PID 1.
// Uncertain state keeps the sidecar. Agent parents have no restart policy.
import type Docker from "dockerode";
import { EGRESS_RESOLVER_LABEL } from "./egress-dns-install.js";
import { EGRESS_PROXY_LABEL } from "./egress-proxy-install.js";

export const EGRESS_SIDECAR_LABELS = [EGRESS_RESOLVER_LABEL, EGRESS_PROXY_LABEL] as const;

const NETNS_PREFIX = "container:";

export function netnsParentId(networkMode: string | null | undefined): string | null {
  if (!networkMode?.startsWith(NETNS_PREFIX)) return null;
  return networkMode.slice(NETNS_PREFIX.length).trim() || null;
}

function statusCode(err: unknown): number {
  return err && typeof err === "object" && "statusCode" in err ? Number(err.statusCode) : 0;
}

async function listEgressSidecars(docker: Docker, sessionId?: string): Promise<string[]> {
  const ids = new Set<string>();
  for (const label of EGRESS_SIDECAR_LABELS) {
    const filter = sessionId ? `${label}=${sessionId}` : label;
    // Include exited sidecars; separate queries implement OR across tier labels.
    const list = await docker.listContainers({ all: true, filters: { label: [filter] } });
    for (const c of list) ids.add(c.Id);
  }
  return [...ids];
}

async function removeContainer(docker: Docker, id: string): Promise<boolean> {
  try {
    await docker.getContainer(id).remove({ force: true });
    return true;
  } catch (err) {
    const code = statusCode(err);
    // 404 confirms removal; 409 only means another removal is in progress.
    if (code === 404) return true;
    if (code !== 409) console.warn(`[egress-reaper] failed to remove sidecar ${id.slice(0, 12)}:`, err);
    return false;
  }
}

async function sidecarNetnsParent(docker: Docker, sidecarId: string): Promise<string | null> {
  const info = await docker.getContainer(sidecarId).inspect();
  return netnsParentId(info.HostConfig?.NetworkMode);
}

async function isParentDead(docker: Docker, parentId: string): Promise<boolean> {
  try {
    const parent = await docker.getContainer(parentId).inspect();
    const running = parent.State?.Running;
    if (typeof running !== "boolean") return false;
    return !running;
  } catch (err) {
    if (statusCode(err) === 404) return true;
    throw err;
  }
}

export async function isOrphanedSidecar(docker: Docker, sidecarId: string): Promise<boolean> {
  try {
    const parentId = await sidecarNetnsParent(docker, sidecarId);
    if (!parentId) return false;
    return await isParentDead(docker, parentId);
  } catch {
    return false;
  }
}

const REAP_ATTEMPTS = 3;
const REAP_BACKOFF_MS = 2_000;

// Retry here: crash handling removes the session map entry, preventing later teardown sweeps.
export async function reapSessionEgressSidecars(
  docker: Docker,
  sessionId: string,
  deadParentId: string,
  opts: { attempts?: number; backoffMs?: number } = {},
): Promise<number> {
  if (!deadParentId) return 0;

  const attempts = opts.attempts ?? REAP_ATTEMPTS;
  const backoffMs = opts.backoffMs ?? REAP_BACKOFF_MS;

  let removed = 0;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let unresolved: number;
    try {
      const pass = await reapOnce(docker, sessionId, deadParentId);
      removed += pass.removed;
      unresolved = pass.unresolved;
      if (unresolved === 0) return removed;
      lastErr = undefined;
    } catch (err) {
      lastErr = err;
      unresolved = -1;
    }

    if (attempt === attempts) {
      console.warn(
        `[egress-reaper] session ${sessionId}: gave up after ${attempt} attempts with sidecars of ${deadParentId.slice(0, 12)} unaccounted for; the boot sweep will collect them:`,
        lastErr ?? `${unresolved} unresolved`,
      );
      return removed;
    }
    await new Promise((r) => {
      setTimeout(r, backoffMs * attempt).unref?.();
    });
  }
  return removed;
}

// One unreadable sidecar must not prevent cleanup of the others on every retry.
async function reapOnce(
  docker: Docker,
  sessionId: string,
  deadParentId: string,
): Promise<{ removed: number; unresolved: number }> {
  const ids = await listEgressSidecars(docker, sessionId);
  const ours: string[] = [];
  let unresolved = 0;

  for (const id of ids) {
    try {
      if ((await sidecarNetnsParent(docker, id)) === deadParentId) ours.push(id);
    } catch {
      unresolved++;
    }
  }
  if (ours.length === 0) return { removed: 0, unresolved };

  if (!(await isParentDead(docker, deadParentId))) return { removed: 0, unresolved };

  let removed = 0;
  for (const id of ours) {
    if (await removeContainer(docker, id)) removed++;
    else unresolved++;
  }
  if (removed > 0) {
    console.log(
      `[egress-reaper] session ${sessionId}: removed ${removed} sidecar(s) of dead container ${deadParentId.slice(0, 12)}`,
    );
  }
  return { removed, unresolved };
}

export const EGRESS_PARENT_LABEL = "shipit-egress-parent";

/**
 * Removes sidecars whose `shipit-egress-parent` container no longer exists. Stack teardown
 * removes Compose service containers by project label, which the sidecars do not carry, so
 * this is what reaps them. A parent that still exists, even stopped, keeps its sidecars.
 */
export async function reapParentlessEgressSidecars(
  docker: Docker,
  opts: { parentIds?: Iterable<string>; paceMs?: number } = {},
): Promise<number> {
  const filters = opts.parentIds
    ? [...new Set(opts.parentIds)].filter(Boolean).map((id) => `${EGRESS_PARENT_LABEL}=${id}`)
    : [EGRESS_PARENT_LABEL];
  const byParent = new Map<string, string[]>();
  for (const filter of filters) {
    let list: Docker.ContainerInfo[];
    try {
      list = await docker.listContainers({ all: true, filters: { label: [filter] } });
    } catch (err) {
      console.warn("[egress-reaper] could not list egress sidecars by parent:", err);
      return 0;
    }
    for (const c of list) {
      const parent = c.Labels?.[EGRESS_PARENT_LABEL];
      if (!parent) continue;
      byParent.set(parent, [...(byParent.get(parent) ?? []), c.Id]);
    }
  }

  let removed = 0;
  for (const [parentId, sidecarIds] of byParent) {
    try {
      await docker.getContainer(parentId).inspect();
      continue;
    } catch (err) {
      if (statusCode(err) !== 404) continue;
    }
    for (const id of sidecarIds) {
      // The label alone is not proof: only a container joined to the missing netns is a sidecar.
      let netnsParent: string | null;
      try { netnsParent = await sidecarNetnsParent(docker, id); } catch { continue; }
      if (netnsParent !== parentId) continue;
      if (await removeContainer(docker, id)) {
        removed++;
        console.log(`[egress-reaper] removed sidecar ${id.slice(0, 12)} (parent ${parentId.slice(0, 12)} no longer exists)`);
      }
    }
    if (opts.paceMs) await new Promise((r) => setTimeout(r, opts.paceMs));
  }
  return removed;
}

export async function reapOrphanEgressSidecars(
  docker: Docker,
  opts: { paceMs?: number } = {},
): Promise<number> {
  let ids: string[];
  try {
    ids = await listEgressSidecars(docker);
  } catch (err) {
    console.warn("[egress-reaper] could not list egress sidecars:", err);
    return 0;
  }
  let removed = 0;
  for (const id of ids) {
    if (!(await isOrphanedSidecar(docker, id))) continue;
    if (await removeContainer(docker, id)) {
      removed++;
      console.log(`[egress-reaper] removed orphan sidecar ${id.slice(0, 12)} (netns parent gone)`);
    }
    if (opts.paceMs) await new Promise((r) => setTimeout(r, opts.paceMs));
  }
  return removed;
}
