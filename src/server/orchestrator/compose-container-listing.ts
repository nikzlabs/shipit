import type Docker from "dockerode";

import type { PollerContainer, PollerInspection } from "./service-poller.js";
import { COMPOSE_PROJECT_LABEL } from "./compose-stack-reaper.js";

const COMPOSE_SERVICE_LABEL = "com.docker.compose.service";
const COMPOSE_ONEOFF_LABEL = "com.docker.compose.oneoff";

/**
 * The Engine API source for {@link PollerContainer}, in place of spawning `docker compose ps` plus
 * one `docker inspect` per container (docs/332). A listing row carries the state, the Compose
 * labels and the per-network address, so a running container needs no inspect at all; it carries
 * no exit code, so an exited one still does.
 */
export function mapEngineContainer(ci: Docker.ContainerInfo): PollerContainer {
  const labels = ci.Labels ?? {};
  const nets = ci.NetworkSettings?.Networks ?? {};
  const networks: Record<string, string | undefined> = {};
  for (const [name, settings] of Object.entries(nets)) networks[name] = settings?.IPAddress;
  return {
    ref: ci.Id,
    service: labels[COMPOSE_SERVICE_LABEL],
    state: ci.State ?? "",
    oneOff: labels[COMPOSE_ONEOFF_LABEL] === "True",
    networks,
  };
}

export function containerProject(ci: Docker.ContainerInfo): string | undefined {
  return ci.Labels?.[COMPOSE_PROJECT_LABEL];
}

async function listByLabels(
  docker: Docker,
  labels: string[],
): Promise<Docker.ContainerInfo[]> {
  return docker.listContainers({ all: true, filters: { label: labels } });
}

export function listProjectContainers(
  docker: Docker,
  project: string,
  stackFilters: string[] = [],
): () => Promise<PollerContainer[]> {
  return async () => {
    const list = await listByLabels(docker, [`${COMPOSE_PROJECT_LABEL}=${project}`, ...stackFilters]);
    return list.map(mapEngineContainer);
  };
}

/** One listing for every Compose project on the host, grouped by project (the docs/332 backstop). */
export async function listAllComposeProjects(
  docker: Docker,
  stackFilters: string[] = [],
): Promise<Map<string, PollerContainer[]>> {
  const list = await listByLabels(docker, [COMPOSE_PROJECT_LABEL, ...stackFilters]);
  const byProject = new Map<string, PollerContainer[]>();
  for (const ci of list) {
    const project = containerProject(ci);
    if (!project) continue;
    const rows = byProject.get(project);
    if (rows) rows.push(mapEngineContainer(ci));
    else byProject.set(project, [mapEngineContainer(ci)]);
  }
  return byProject;
}

export function inspectContainerViaApi(
  docker: Docker,
): (ref: string) => Promise<PollerInspection> {
  return async (ref) => {
    const info = await docker.getContainer(ref).inspect();
    const nets = info.NetworkSettings?.Networks ?? {};
    const networks: Record<string, string | undefined> = {};
    for (const [name, settings] of Object.entries(nets)) networks[name] = settings?.IPAddress;
    return {
      ...(typeof info.State?.OOMKilled === "boolean" ? { oomKilled: info.State.OOMKilled } : {}),
      ...(typeof info.State?.ExitCode === "number" ? { exitCode: info.State.ExitCode } : {}),
      networks,
    };
  };
}

export function connectContainerViaApi(
  docker: Docker,
): (networkName: string, ref: string) => Promise<void> {
  return async (networkName, ref) => {
    await docker.getNetwork(networkName).connect({ Container: ref });
  };
}
