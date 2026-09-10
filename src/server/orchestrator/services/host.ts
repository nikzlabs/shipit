import type Docker from "dockerode";
import type { SessionManager } from "../sessions.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { HostOverview, HostContainerInfo } from "../../shared/types.js";
import { CONTAINER_LABEL_KEY, CONTAINER_LABEL_VALUE, CONTAINER_SESSION_ID_LABEL } from "../session-container.js";

export interface HostOverviewDeps {
  docker: Docker | null;
  sessionManager: SessionManager;
  runnerRegistry: SessionRunnerRegistry;
}

export async function getHostOverview(deps: HostOverviewDeps): Promise<HostOverview> {
  const generatedAt = new Date().toISOString();

  if (!deps.docker) {
    return { generatedAt, dockerAvailable: false, totals: { containers: 0, running: 0 }, containers: [] };
  }

  let raw: Docker.ContainerInfo[];
  try {
    raw = await deps.docker.listContainers({
      all: true,
      filters: { label: [`${CONTAINER_LABEL_KEY}=${CONTAINER_LABEL_VALUE}`] },
    });
  } catch {
    return { generatedAt, dockerAvailable: false, totals: { containers: 0, running: 0 }, containers: [] };
  }

  const containers: HostContainerInfo[] = raw.map((ci) => {
    const sessionId = ci.Labels?.[CONTAINER_SESSION_ID_LABEL];
    const session = sessionId ? deps.sessionManager.get(sessionId) : undefined;
    const agentRunning = sessionId ? deps.runnerRegistry.get(sessionId)?.running === true : undefined;
    const info: HostContainerInfo = {
      id: ci.Id.slice(0, 12),
      name: (ci.Names?.[0] ?? "").replace(/^\//, ""),
      image: ci.Image,
      state: ci.State,
      status: ci.Status,
      createdAt: ci.Created,
    };
    if (sessionId) info.sessionId = sessionId;
    if (session?.title) info.sessionTitle = session.title;
    if (agentRunning !== undefined) info.agentRunning = agentRunning;
    return info;
  });

  containers.sort((a, b) => b.createdAt - a.createdAt);

  return {
    generatedAt,
    dockerAvailable: true,
    totals: {
      containers: containers.length,
      running: containers.filter((c) => c.state === "running").length,
    },
    containers,
  };
}
