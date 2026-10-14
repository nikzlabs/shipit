import http from "node:http";
import type Docker from "dockerode";

import {
  respond,
  forbidden,
  badRequest,
  readBody,
  parseJsonObjectBody,
  forwardToDocker,
  pipeToDocker,
  ownershipLabels,
  PARENT_SESSION_LABEL,
  MAX_BODY_SIZE,
  DOCKER_SOCKET,
  CONTAINER_NAME_RE,
} from "./docker-proxy-helpers.js";
import type { DockerProxyDeps, Route, RequestContext } from "./docker-proxy-helpers.js";
import {
  containerBelongsToSession,
  networkBelongsToSession,
  sessionOwnedNetwork,
  volumeBelongsToSession,
  getExecParentContainerId,
} from "./docker-proxy-auth.js";
import {
  sanitizeBuildRequest,
  sanitizeContainerCreate,
  sanitizeExecCreate,
  verifyContainerMountPaths,
} from "./docker-proxy-sanitize.js";
import { findAmbiguousFieldCasing } from "./docker-proxy-field-casing.js";
import {
  ProxyEgressRefusal,
  containProxyContainer,
  egressNetworkAttachRefusal,
  isEgressNetworkName,
  prepareProxyContainerStart,
  withProxyStartLock,
} from "./docker-proxy-egress.js";
import { createDockerClient } from "./docker-client.js";
import { NO_HOST_ADDRESS_OPTION } from "./egress-firewall.js";
import { localBlockActive } from "./local-block.js";
import { stackLabel } from "./stack-label.js";

export {
  respond,
  forbidden,
  badRequest,
  readBody,
  parseJsonObjectBody,
  forwardToDocker,
  pipeToDocker,
  PARENT_SESSION_LABEL,
  MAX_BODY_SIZE,
  DOCKER_SOCKET,
  CONTAINER_NAME_RE,
} from "./docker-proxy-helpers.js";
export type {
  SessionInfo,
  DockerProxyDeps,
  Route,
  RequestContext,
} from "./docker-proxy-helpers.js";
export {
  containerBelongsToSession,
  networkBelongsToSession,
  volumeBelongsToSession,
  getExecParentContainerId,
  resolveUnderWorkspace,
} from "./docker-proxy-auth.js";
export {
  sanitizeBuildRequest,
  sanitizeContainerCreate,
  sanitizeExecCreate,
  pinMountPaths,
  verifyContainerMountPaths,
} from "./docker-proxy-sanitize.js";
export { findAmbiguousFieldCasing } from "./docker-proxy-field-casing.js";

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n", 1)[0] ?? "";
}

/**
 * A start or restart with the local block active (docs/319-api-reach-through-host req 8). Docker
 * is called by the container's full id, so the container prepared is the one Docker starts.
 */
async function startContained(
  ctx: RequestContext,
  docker: Docker,
  containerRef: string,
  suffix: string,
  query: string,
): Promise<void> {
  const sidecarImage = process.env.SESSION_EGRESS_SIDECAR_IMAGE;
  if (!sidecarImage) {
    respond(ctx.res, 500, {
      message: "ShipIt did not start the container: no egress sidecar image is configured, "
        + "so it cannot keep the container away from this machine and private networks",
    });
    return;
  }
  const body = await readBody(ctx.req, MAX_BODY_SIZE);
  const contentType = ctx.req.headers["content-type"];
  const version = /^\/v[\d.]+/.exec(ctx.req.url ?? "")?.[0] ?? "";

  await withProxyStartLock(docker, containerRef, async (containerId) => {
    const target = {
      docker,
      sessionId: ctx.session.sessionId,
      containerId,
      sidecarImage,
      labels: stackLabel(ctx.stackName),
    };
    let contain: boolean;
    try {
      contain = await prepareProxyContainerStart(target);
    } catch (err) {
      if (err instanceof ProxyEgressRefusal) {
        forbidden(ctx.res, `Starting this container is refused: ${err.message}`);
      } else {
        respond(ctx.res, 500, {
          message: `ShipIt did not start the container: it could not prepare the firewall that keeps it `
            + `away from this machine and private networks (${firstLine(err)})`,
        });
      }
      return;
    }

    let dockerResult: Awaited<ReturnType<typeof forwardToDocker>>;
    try {
      dockerResult = await forwardToDocker(
        ctx.socketPath,
        "POST",
        `${version}/containers/${containerId}${suffix}${query}`,
        contentType ? { "content-type": contentType } : {},
        body.length > 0 ? body : undefined,
      );
    } catch (err) {
      // Docker may have started it before the answer was lost; a stopped container is left alone.
      if (contain) {
        try { await containProxyContainer(target); } catch { /* it stopped the container */ }
      }
      throw err;
    }
    // 304: already running, and the egress network was just detached, so it is reattached behind
    // a fresh firewall.
    const started = (dockerResult.statusCode >= 200 && dockerResult.statusCode < 300)
      || dockerResult.statusCode === 304;
    if (contain && started) {
      try {
        await containProxyContainer(target);
      } catch (err) {
        console.warn(`[docker-proxy:${ctx.session.sessionId}] containment of ${containerId} failed:`, err);
        respond(ctx.res, 500, {
          message: "The container was stopped: ShipIt could not keep it away from this machine "
            + `and private networks (${firstLine(err)})`,
        });
        return;
      }
    }
    ctx.res.writeHead(dockerResult.statusCode, dockerResult.headers);
    ctx.res.end(dockerResult.body);
  });
}

function buildRoutes(getDocker: () => Docker): Route[] {
  const routes: Route[] = [];

  function route(method: string, pattern: RegExp, handler: Route["handler"]): void {
    routes.push({ method, pattern, handler });
  }

  route("POST", /^\/v[\d.]+\/containers\/create(\?.*)?$|^\/containers\/create(\?.*)?$/, async (ctx) => {
    try {
      const bodyBuf = await readBody(ctx.req, MAX_BODY_SIZE);
      const body = parseJsonObjectBody(bodyBuf);

      const result = await sanitizeContainerCreate(body, ctx.session, ctx.socketPath);
      if (result.error) {
        forbidden(ctx.res, result.error); return;
      }
      body.Labels = { ...(body.Labels as Record<string, string>), ...ownershipLabels(ctx) };

      const sanitizedBody = Buffer.from(JSON.stringify(body));
      const dockerResult = await forwardToDocker(
        ctx.socketPath,
        "POST",
        ctx.req.url!,
        { "content-type": "application/json" },
        sanitizedBody,
      );

      ctx.res.writeHead(dockerResult.statusCode, dockerResult.headers);
      ctx.res.end(dockerResult.body);
    } catch (err) {
      if ((err as Error).message === "Request body too large") {
        badRequest(ctx.res, "Request body too large (max 10 MB)");
      } else {
        badRequest(ctx.res, (err as Error).message);
      }
    }
  });

  route("GET", /^\/v[\d.]+\/containers\/json(\?.*)?$|^\/containers\/json(\?.*)?$/, async (ctx) => {
    const dockerResult = await forwardToDocker(ctx.socketPath, "GET", ctx.req.url!, ctx.req.headers);
    if (dockerResult.statusCode !== 200) {
      ctx.res.writeHead(dockerResult.statusCode, dockerResult.headers);
      ctx.res.end(dockerResult.body);
      return;
    }

    const containers = JSON.parse(dockerResult.body.toString()) as Record<string, unknown>[];
    const filtered = containers.filter((c) => {
      const labels = c.Labels as Record<string, string> | undefined;
      return labels?.[PARENT_SESSION_LABEL] === ctx.session.sessionId;
    });

    respond(ctx.res, 200, filtered);
  });

  // Hold API trust refresh across starts. Creates have no IP; removals leave safe stale denials.
  // `mounting` ops are the ones where Docker resolves the stored bind sources again (planning#601).
  const containerLabelOps: {
    method: string;
    suffix: string;
    topologyChanging?: boolean;
    mounting?: boolean;
    /** Docker stops the container first, and the session decides how long that takes. */
    mountsAfterStopping?: boolean;
    /** Runs the container in a new network namespace, which needs its firewall (docs/319). */
    startsNamespace?: boolean;
  }[] = [
    { method: "GET", suffix: "/json" },
    { method: "POST", suffix: "/start", topologyChanging: true, mounting: true, startsNamespace: true },
    { method: "POST", suffix: "/stop" },
    {
      method: "POST",
      suffix: "/restart",
      topologyChanging: true,
      mounting: true,
      mountsAfterStopping: true,
      startsNamespace: true,
    },
    { method: "POST", suffix: "/kill" },
    { method: "DELETE", suffix: "" },
    { method: "POST", suffix: "/wait" },
  ];

  for (const op of containerLabelOps) {
    const escapedSuffix = op.suffix.replace(/\//g, "\\/");
    const pattern = new RegExp(
      `^(?:\\/v[\\d.]+)?\\/containers\\/(${CONTAINER_NAME_RE})${escapedSuffix}(\\?.*)?$`,
    );
    route(op.method, pattern, async (ctx, match) => {
      const containerId = match[1];
      if (!(await containerBelongsToSession(ctx.socketPath, containerId, ctx.session.sessionId))) {
        forbidden(ctx.res, "Container does not belong to this session"); return;
      }
      if (op.mounting) {
        const mountCheck = await verifyContainerMountPaths(ctx.socketPath, containerId, ctx.session);
        if (mountCheck.error) { forbidden(ctx.res, mountCheck.error); return; }
        // A restart mounts only once the container has exited, and a container that traps its stop
        // signal holds that open for as long as it likes — long enough to swap a directory on the
        // path this check just cleared. Stop and start instead: a start mounts straight away.
        if (op.mountsAfterStopping && mountCheck.hasHostBind) {
          forbidden(
            ctx.res,
            "Restarting a container with a host bind mount is not supported; stop it and start it instead",
          );
          return;
        }
      }
      const endTopologyChange = op.topologyChanging ? ctx.beginTopologyChange?.() : undefined;
      try {
        if (op.startsNamespace && localBlockActive()) {
          await startContained(ctx, getDocker(), containerId, op.suffix, match[2] ?? "");
          return;
        }
        const piped = pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
        if (op.topologyChanging) await piped;
      } finally {
        endTopologyChange?.();
      }
    });
  }

  route("GET", /^(?:\/v[\d.]+)?\/containers\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)\/logs(\?.*)?$/, async (ctx, match) => {
    const containerId = match[1];
    if (!(await containerBelongsToSession(ctx.socketPath, containerId, ctx.session.sessionId))) {
      forbidden(ctx.res, "Container does not belong to this session"); return;
    }
    void pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  route("POST", /^(?:\/v[\d.]+)?\/containers\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)\/attach(\?.*)?$/, async (ctx, match) => {
    const containerId = match[1];
    if (!(await containerBelongsToSession(ctx.socketPath, containerId, ctx.session.sessionId))) {
      forbidden(ctx.res, "Container does not belong to this session"); return;
    }
    void pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  route("POST", /^(?:\/v[\d.]+)?\/containers\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)\/exec(\?.*)?$/, async (ctx, match) => {
    const containerId = match[1];
    if (!(await containerBelongsToSession(ctx.socketPath, containerId, ctx.session.sessionId))) {
      forbidden(ctx.res, "Container does not belong to this session"); return;
    }

    try {
      const bodyBuf = await readBody(ctx.req, MAX_BODY_SIZE);
      const body = parseJsonObjectBody(bodyBuf);

      const result = sanitizeExecCreate(body);
      if (result.error) {
        forbidden(ctx.res, result.error); return;
      }

      const dockerResult = await forwardToDocker(
        ctx.socketPath,
        "POST",
        ctx.req.url!,
        { "content-type": "application/json" },
        Buffer.from(JSON.stringify(body)),
      );

      ctx.res.writeHead(dockerResult.statusCode, dockerResult.headers);
      ctx.res.end(dockerResult.body);
    } catch (err) {
      if ((err as Error).message === "Request body too large") {
        badRequest(ctx.res, "Request body too large (max 10 MB)");
      } else {
        badRequest(ctx.res, (err as Error).message);
      }
    }
  });

  route("POST", /^(?:\/v[\d.]+)?\/exec\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)\/start(\?.*)?$/, async (ctx, match) => {
    const execId = match[1];
    const containerId = await getExecParentContainerId(ctx.socketPath, execId);
    if (!containerId || !(await containerBelongsToSession(ctx.socketPath, containerId, ctx.session.sessionId))) {
      forbidden(ctx.res, "Exec instance does not belong to this session"); return;
    }
    void pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  route("GET", /^(?:\/v[\d.]+)?\/exec\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)\/json(\?.*)?$/, async (ctx, match) => {
    const execId = match[1];
    const containerId = await getExecParentContainerId(ctx.socketPath, execId);
    if (!containerId || !(await containerBelongsToSession(ctx.socketPath, containerId, ctx.session.sessionId))) {
      forbidden(ctx.res, "Exec instance does not belong to this session"); return;
    }
    void pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  route("POST", /^(?:\/v[\d.]+)?\/containers\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)\/rename(\?.*)?$/, async (ctx) => {
    forbidden(ctx.res, "Container rename is not supported through the Docker proxy");
  });

  route("POST", /^(?:\/v[\d.]+)?\/containers\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)\/update(\?.*)?$/, async (ctx) => {
    forbidden(ctx.res, "Container update is not supported through the Docker proxy");
  });

  route("POST", /^(?:\/v[\d.]+)?\/networks\/create(\?.*)?$/, async (ctx) => {
    try {
      const bodyBuf = await readBody(ctx.req, MAX_BODY_SIZE);
      let body = parseJsonObjectBody(bodyBuf);

      const ambiguous = findAmbiguousFieldCasing(body);
      if (ambiguous) {
        forbidden(ctx.res, ambiguous); return;
      }

      // ShipIt finds its own networks by name, so a session must not take one first.
      if (typeof body.Name === "string" && body.Name.trim().toLowerCase().startsWith("shipit-")) {
        forbidden(ctx.res, `Network name "${body.Name}" is reserved for ShipIt's own networks`); return;
      }
      if (localBlockActive()) {
        if (typeof body.Name === "string" && isEgressNetworkName(body.Name)) {
          forbidden(ctx.res, `Network name "${body.Name}" is reserved for ShipIt's egress networks`); return;
        }
        // Another driver can attach containers to the host's own network; a chosen range can overlap it.
        const driver: unknown = Object.entries(body).find(([key]) => key.normalize("NFKC").toLowerCase() === "driver")?.[1];
        if (driver !== undefined && driver !== "" && driver !== "bridge") {
          forbidden(ctx.res, `Network driver ${JSON.stringify(driver)} is not allowed: only "bridge" keeps containers away `
            + "from this machine and private networks"); return;
        }
        const ipam: unknown = Object.entries(body).find(([key]) => key.normalize("NFKC").toLowerCase() === "ipam")?.[1];
        const ipamConfig: unknown = ipam && typeof ipam === "object"
          ? Object.entries(ipam as Record<string, unknown>).find(([key]) => key.normalize("NFKC").toLowerCase() === "config")?.[1]
          : undefined;
        if (Array.isArray(ipamConfig) && ipamConfig.length > 0) {
          forbidden(ctx.res, "Choosing a network's address range is not allowed: Docker picks one that does not "
            + "overlap this machine's networks"); return;
        }
        // A container on it then starts with no route out, before its firewall (docs/319). Go decodes
        // any casing of the key into the same field, and the last one wins.
        const options = Object.entries(body).find(([key]) => key === "Options")?.[1];
        body = {
          ...Object.fromEntries(
            Object.entries(body).filter(([key]) =>
              !["internal", "options", "enableipv6"].includes(key.normalize("NFKC").toLowerCase())),
          ),
          Internal: true,
          EnableIPv6: false,
          // No host address on the bridge: nothing on it reaches the host before its firewall.
          Options: { ...(options && typeof options === "object" ? options : {}), ...NO_HOST_ADDRESS_OPTION },
        };
      }

      body.Labels = { ...((body.Labels ?? {}) as Record<string, string>), ...ownershipLabels(ctx) };

      const sanitizedBody = Buffer.from(JSON.stringify(body));
      const dockerResult = await forwardToDocker(
        ctx.socketPath,
        "POST",
        ctx.req.url!,
        { "content-type": "application/json" },
        sanitizedBody,
      );

      ctx.res.writeHead(dockerResult.statusCode, dockerResult.headers);
      ctx.res.end(dockerResult.body);
    } catch (err) {
      badRequest(ctx.res, (err as Error).message);
    }
  });

  route("GET", /^(?:\/v[\d.]+)?\/networks(\?.*)?$/, async (ctx) => {
    const dockerResult = await forwardToDocker(ctx.socketPath, "GET", ctx.req.url!, ctx.req.headers);
    if (dockerResult.statusCode !== 200) {
      ctx.res.writeHead(dockerResult.statusCode, dockerResult.headers);
      ctx.res.end(dockerResult.body);
      return;
    }

    const networks = JSON.parse(dockerResult.body.toString()) as Record<string, unknown>[];
    const filtered = networks.filter((n) => {
      const labels = n.Labels as Record<string, string> | undefined;
      return labels?.[PARENT_SESSION_LABEL] === ctx.session.sessionId;
    });

    respond(ctx.res, 200, filtered);
  });

  route("GET", /^(?:\/v[\d.]+)?\/networks\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)(\?.*)?$/, async (ctx, match) => {
    const networkId = match[1];
    if (networkId === "create") { forbidden(ctx.res, "Endpoint not allowed: GET /networks/create"); return; }
    if (!(await networkBelongsToSession(ctx.socketPath, networkId, ctx.session.sessionId))) {
      forbidden(ctx.res, "Network does not belong to this session"); return;
    }
    void pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  route("DELETE", /^(?:\/v[\d.]+)?\/networks\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)(\?.*)?$/, async (ctx, match) => {
    const networkId = match[1];
    if (!(await networkBelongsToSession(ctx.socketPath, networkId, ctx.session.sessionId))) {
      forbidden(ctx.res, "Network does not belong to this session"); return;
    }
    void pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  route("POST", /^(?:\/v[\d.]+)?\/networks\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)\/connect(\?.*)?$/, async (ctx, match) => {
    const networkId = match[1];
    const network = await sessionOwnedNetwork(ctx.socketPath, networkId, ctx.session.sessionId);
    if (!network) {
      forbidden(ctx.res, "Network does not belong to this session"); return;
    }
    const egressRefusal = egressNetworkAttachRefusal(networkId, network);
    if (egressRefusal) {
      forbidden(ctx.res, egressRefusal); return;
    }
    // A running container joins without a new firewall, so only a network that gives it no route counts.
    if (localBlockActive() && !network.isolated) {
      forbidden(ctx.res, `Network "${network.name ?? networkId}" is not internal with no host address, so a container `
        + "on it could reach this machine and private networks; use a network created through this Docker access");
      return;
    }

    try {
      const bodyBuf = await readBody(ctx.req, MAX_BODY_SIZE);
      const body = parseJsonObjectBody(bodyBuf);

      const ambiguous = findAmbiguousFieldCasing(body);
      if (ambiguous) {
        forbidden(ctx.res, ambiguous); return;
      }

      const containerId = body.Container as string;
      if (containerId && !(await containerBelongsToSession(ctx.socketPath, containerId, ctx.session.sessionId))) {
        forbidden(ctx.res, "Container does not belong to this session"); return;
      }

      // A network attachment adds an address to the API trust index.
      const endTopologyChange = ctx.beginTopologyChange?.();
      let dockerResult;
      try {
        dockerResult = await forwardToDocker(
          ctx.socketPath,
          "POST",
          ctx.req.url!,
          { "content-type": "application/json" },
          Buffer.from(JSON.stringify(body)),
        );
      } finally {
        endTopologyChange?.();
      }

      ctx.res.writeHead(dockerResult.statusCode, dockerResult.headers);
      ctx.res.end(dockerResult.body);
    } catch (err) {
      badRequest(ctx.res, (err as Error).message);
    }
  });

  route("POST", /^(?:\/v[\d.]+)?\/networks\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)\/disconnect(\?.*)?$/, async (ctx, match) => {
    const networkId = match[1];
    if (!(await networkBelongsToSession(ctx.socketPath, networkId, ctx.session.sessionId))) {
      forbidden(ctx.res, "Network does not belong to this session"); return;
    }

    try {
      const bodyBuf = await readBody(ctx.req, MAX_BODY_SIZE);
      const body = parseJsonObjectBody(bodyBuf);

      const ambiguous = findAmbiguousFieldCasing(body);
      if (ambiguous) {
        forbidden(ctx.res, ambiguous); return;
      }

      const containerId = body.Container as string;
      if (containerId && !(await containerBelongsToSession(ctx.socketPath, containerId, ctx.session.sessionId))) {
        forbidden(ctx.res, "Container does not belong to this session"); return;
      }

      const dockerResult = await forwardToDocker(
        ctx.socketPath,
        "POST",
        ctx.req.url!,
        { "content-type": "application/json" },
        Buffer.from(JSON.stringify(body)),
      );

      ctx.res.writeHead(dockerResult.statusCode, dockerResult.headers);
      ctx.res.end(dockerResult.body);
    } catch (err) {
      badRequest(ctx.res, (err as Error).message);
    }
  });

  route("POST", /^(?:\/v[\d.]+)?\/volumes\/create(\?.*)?$/, async (ctx) => {
    try {
      const bodyBuf = await readBody(ctx.req, MAX_BODY_SIZE);
      const body = parseJsonObjectBody(bodyBuf);

      const ambiguous = findAmbiguousFieldCasing(body);
      if (ambiguous) {
        forbidden(ctx.res, ambiguous); return;
      }

      // DriverOpts can bind arbitrary host paths into an otherwise session-owned volume.
      const driverOpts = body.DriverOpts as Record<string, string> | undefined;
      if (driverOpts && Object.keys(driverOpts).length > 0) {
        forbidden(ctx.res, "Volume DriverOpts are not allowed (host-path escape risk)"); return;
      }

      if (body.Driver && body.Driver !== "local") {
        forbidden(ctx.res, `Volume driver "${body.Driver as string}" is not allowed`); return;
      }

      body.Labels = { ...((body.Labels ?? {}) as Record<string, string>), ...ownershipLabels(ctx) };

      const sanitizedBody = Buffer.from(JSON.stringify(body));
      const dockerResult = await forwardToDocker(
        ctx.socketPath,
        "POST",
        ctx.req.url!,
        { "content-type": "application/json" },
        sanitizedBody,
      );

      ctx.res.writeHead(dockerResult.statusCode, dockerResult.headers);
      ctx.res.end(dockerResult.body);
    } catch (err) {
      badRequest(ctx.res, (err as Error).message);
    }
  });

  route("GET", /^(?:\/v[\d.]+)?\/volumes(\?.*)?$/, async (ctx) => {
    const dockerResult = await forwardToDocker(ctx.socketPath, "GET", ctx.req.url!, ctx.req.headers);
    if (dockerResult.statusCode !== 200) {
      ctx.res.writeHead(dockerResult.statusCode, dockerResult.headers);
      ctx.res.end(dockerResult.body);
      return;
    }

    const data = JSON.parse(dockerResult.body.toString()) as Record<string, unknown>;
    const volumes = (data.Volumes ?? []) as Record<string, unknown>[];
    const filtered = volumes.filter((v) => {
      const labels = v.Labels as Record<string, string> | undefined;
      return labels?.[PARENT_SESSION_LABEL] === ctx.session.sessionId;
    });
    data.Volumes = filtered;

    respond(ctx.res, 200, data);
  });

  route("GET", /^(?:\/v[\d.]+)?\/volumes\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)(\?.*)?$/, async (ctx, match) => {
    const volumeName = match[1];
    if (volumeName === "create") { forbidden(ctx.res, "Endpoint not allowed: GET /volumes/create"); return; }
    if (!(await volumeBelongsToSession(ctx.socketPath, volumeName, ctx.session.sessionId))) {
      forbidden(ctx.res, "Volume does not belong to this session"); return;
    }
    void pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  route("DELETE", /^(?:\/v[\d.]+)?\/volumes\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)(\?.*)?$/, async (ctx, match) => {
    const volumeName = match[1];
    if (!(await volumeBelongsToSession(ctx.socketPath, volumeName, ctx.session.sessionId))) {
      forbidden(ctx.res, "Volume does not belong to this session"); return;
    }
    void pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  route("GET", /^(?:\/v[\d.]+)?\/images\/.*$/, async (ctx) => {
    void pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  route("POST", /^(?:\/v[\d.]+)?\/images\/create(\?.*)?$/, async (ctx) => {
    void pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  route("DELETE", /^(?:\/v[\d.]+)?\/images\/([^/]+)(\?.*)?$/, async (ctx) => {
    forbidden(ctx.res, "Image deletion is not allowed (images are shared resources)");
  });

  route("POST", /^(?:\/v[\d.]+)?\/build(\?.*)?$/, async (ctx) => {
    const result = await sanitizeBuildRequest(
      ctx.req.url ?? "",
      ctx.req.headers["content-type"],
      ctx.session,
      ctx.socketPath,
    );
    if (result.error) {
      forbidden(ctx.res, result.error); return;
    }
    void pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  route("GET", /^\/_ping$/, async (ctx) => {
    void pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  route("GET", /^(?:\/v[\d.]+)?\/version$/, async (ctx) => {
    void pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  route("GET", /^(?:\/v[\d.]+)?\/info$/, async (ctx) => {
    void pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  route("HEAD", /^\/_ping$/, async (ctx) => {
    void pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  return routes;
}

export function createDockerProxy(deps: DockerProxyDeps): http.Server {
  const socketPath = deps.socketPath ?? DOCKER_SOCKET;
  let docker: Docker | undefined;
  const routes = buildRoutes(() => (docker ??= createDockerClient({ socketPath })));

  const server = http.createServer(async (req, res) => {
    try {
      const remoteIp = req.socket.remoteAddress;
      if (!remoteIp) {
        forbidden(res, "Cannot determine source IP"); return;
      }

      const ip = remoteIp.replace(/^::ffff:/, "");
      const session = deps.getSessionByContainerIp(ip);
      if (!session) {
        forbidden(res, "Unknown source IP"); return;
      }

      if (!session.dockerAccess) {
        forbidden(res, "Docker access not enabled for this session"); return;
      }

      const url = req.url ?? "/";
      const method = (req.method ?? "GET").toUpperCase();

      // Below 1.24 the daemon reads a full HostConfig from a container *start*, which no route
      // here checks. A stock daemon refuses those versions itself; this does not depend on that.
      // The whole prefix is parsed the way Go's `versions.compare` does — component by component,
      // a missing or unparseable one as 0 — so `/v1.2.3/` and `/v1/` are read as the sub-1.24
      // versions the daemon reads them as, rather than skipped for not being two components.
      const version = /^\/v([\d.]+)(?=\/|$)/.exec(url);
      if (version) {
        const [major, minor] = version[1].split(".").map((part) => Number.parseInt(part, 10) || 0);
        if (major < 1 || (major === 1 && (minor ?? 0) < 24)) {
          forbidden(res, `Docker API version v${version[1]} is not supported (minimum v1.24)`);
          return;
        }
      }

      const ctx: RequestContext = {
        req, res, session, socketPath,
        ...(deps.onTopologyChange ? { beginTopologyChange: deps.onTopologyChange } : {}),
        ...(deps.stackName ? { stackName: deps.stackName } : {}),
      };

      for (const route of routes) {
        if (route.method !== method) continue;
        const match = url.match(route.pattern);
        if (match) {
          await route.handler(ctx, match);
          return;
        }
      }

      forbidden(res, `Endpoint not allowed: ${method} ${url}`);
    } catch (err) {
      if (!res.headersSent) {
        respond(res, 500, { message: `Proxy error: ${(err as Error).message}` });
      }
    }
  });

  return server;
}

export async function resolveOwnContainerIp(networkName = "bridge"): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const containerId = (await readFile("/etc/hostname", "utf-8")).trim();

  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: DOCKER_SOCKET, path: `/containers/${containerId}/json`, method: "GET" },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const info = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
            const networkSettings = info.NetworkSettings as Record<string, unknown> | undefined;
            const networks = networkSettings?.Networks as Record<string, Record<string, unknown>> | undefined;
            const net = networks?.[networkName];
            const ip = net?.IPAddress as string | undefined;
            if (!ip) {
              reject(new Error(`Container ${containerId} has no IP on network "${networkName}"`));
              return;
            }
            resolve(ip);
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
        res.on("error", reject);
      },
    );

    req.on("error", reject);
    req.end();
  });
}
