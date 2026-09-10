// Unknown IPs are trusted as browser/host callers. Register networks for untrusted
// containers before they start; registering individual IPs afterward leaves a gap.

import type { FastifyInstance } from "fastify";
import { parsePreviewSubdomain } from "./preview-proxy.js";
import {
  isEgressDecisionPath,
  presentedEgressDecisionToken,
  verifyEgressDecisionToken,
} from "./egress-decision-auth.js";

declare module "fastify" {
  interface FastifyContextConfig {
    /** Allows the owning session's agent container, subject to the global deny list. */
    containerAccessible?: boolean;
  }

  interface FastifyInstance {
    containerAccessibleRoutes: Set<string>;
  }
}

const HARD_DENY_PREFIXES = [
  "/api/secrets",
  "/api/mcp-servers",
  "/api/provider-accounts",
  "/api/credential-routes",
  "/api/trackers",
  "/api/updates",
] as const;

export function isHardDeniedGlobal(pathname: string): boolean {
  return HARD_DENY_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

// Use the socket peer; a container can forge X-Forwarded-For.
export function normalizeRemoteIp(remoteAddress: string | undefined): string | null {
  if (!remoteAddress) return null;
  return remoteAddress.replace(/^::ffff:/, "");
}

const untrustedCidrs = new Set<string>();

export function registerUntrustedContainerNetwork(cidr: string): boolean {
  if (!parseCidr(cidr)) return false;
  untrustedCidrs.add(cidr);
  return true;
}

export function clearUntrustedContainerNetworks(): void {
  untrustedCidrs.clear();
}

export function isUntrustedContainerIp(ip: string): boolean {
  const addr = ipv4ToInt(ip);
  if (addr === null) return false;
  for (const cidr of untrustedCidrs) {
    const parsed = parseCidr(cidr);
    if (parsed && (addr & parsed.mask) === (parsed.base & parsed.mask)) return true;
  }
  return false;
}

function parseCidr(cidr: string): { base: number; mask: number } | null {
  const [addr, bitsRaw] = cidr.split("/");
  const base = addr ? ipv4ToInt(addr) : null;
  const bits = Number.parseInt(bitsRaw ?? "", 10);
  if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  // JS masks shift counts to five bits; /0 needs an explicit zero mask.
  const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
  return { base, mask };
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value * 256) + n;
  }
  return value >>> 0;
}

function sessionSegment(pathname: string): string | null {
  const parts = pathname.split("/");
  if (parts[1] === "api" && parts[2] === "sessions" && parts[3]) {
    return decodeURIComponent(parts[3]);
  }
  return null;
}

export interface ContainerGuardDeps {
  containerManager?: {
    getSessionByContainerIp(ip: string): { sessionId: string } | undefined;
    getSessionByAnyContainerIp?(ip: string): Promise<{ sessionId: string } | undefined>;
    isLikelySessionContainerIp?(ip: string): boolean;
  };
}

// Register before domain routes so onRoute observes every opt-in.
export function registerContainerOriginGuard(
  app: FastifyInstance,
  deps: ContainerGuardDeps,
): void {
  const containerAccessibleRoutes = new Set<string>();
  app.decorate("containerAccessibleRoutes", containerAccessibleRoutes);

  app.addHook("onRoute", (routeOptions) => {
    if (!routeOptions.config?.containerAccessible) return;
    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method];
    for (const method of methods) {
      if (method === "HEAD") continue;
      containerAccessibleRoutes.add(`${method} ${routeOptions.url}`);
    }
  });

  const { containerManager } = deps;

  app.addHook("onRequest", async (request, reply) => {
    const ip = normalizeRemoteIp(request.socket.remoteAddress);

    if (ip && isUntrustedContainerIp(ip)) {
      return reply
        .code(403)
        .send({ error: "This endpoint is not available to session containers." });
    }

    if (!containerManager) return;

    let caller: { sessionId: string } | undefined;
    let otherContainer: { sessionId: string } | undefined;
    try {
      caller = ip ? containerManager.getSessionByContainerIp(ip) : undefined;
      if (ip && !caller) {
        otherContainer = await containerManager.getSessionByAnyContainerIp?.(ip);
      }
    } catch {
      if (ip && containerManager.isLikelySessionContainerIp?.(ip)) {
        return reply.code(403).send({ error: "Container origin could not be verified." });
      }
      return;
    }
    if (!caller && !otherContainer) return;

    const pathname = (request.url ?? "/").split("?")[0];
    const ownerSessionId = (caller ?? otherContainer)!.sessionId;

    // Safe only while the preview proxy hijacks every matching host before API routing.
    const previewOwner = parsePreviewSubdomain(request.headers.host)?.sessionId.toLowerCase();
    if (previewOwner === ownerSessionId.toLowerCase()) return;

    // The egress sidecar shares the service's IP; require its session-scoped secret.
    if (otherContainer) {
      if (isEgressDecisionPath(pathname)) {
        const token = presentedEgressDecisionToken(request.headers);
        const scoped = new URLSearchParams((request.url ?? "").split("?")[1] ?? "").get("session");
        if (token && scoped === otherContainer.sessionId
          && await verifyEgressDecisionToken(otherContainer.sessionId, token)) {
          return;
        }
      }
      return reply
        .code(403)
        .send({ error: "This endpoint is not available to session containers." });
    }
    if (!caller) return;

    if (isHardDeniedGlobal(pathname)) {
      return reply
        .code(403)
        .send({ error: "This endpoint is not available to session containers." });
    }

    if (request.routeOptions?.config?.containerAccessible !== true) {
      return reply
        .code(403)
        .send({ error: "This endpoint is not available to session containers." });
    }

    const scoped =
      sessionSegment(pathname) ??
      new URLSearchParams((request.url ?? "").split("?")[1] ?? "").get("session");
    if (scoped !== caller.sessionId) {
      return reply
        .code(403)
        .send({ error: "Session containers may only act on their own session." });
    }
  });
}
