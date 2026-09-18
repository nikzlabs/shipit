import type Docker from "dockerode";
import { EGRESS_DEFAULT_ALLOWLIST } from "./egress-allowlist.js";
import { egressDnsEnabled } from "./egress-dns-install.js";
import {
  EGRESS_DECISION_TOKEN_ENV,
  mintEgressDecisionToken,
  tokenFromContainerEnv,
  type EgressDecisionTokenRecovery,
} from "./egress-decision-auth.js";

// Exempts proxy dials from HTTPS redirection. Match the image's UID; differ from agent and resolver.
export const EGRESS_PROXY_UID = 912;

export const EGRESS_PROXY_PORT = 8443;
export const EGRESS_PROXY_LISTEN = `127.0.0.1:${EGRESS_PROXY_PORT}`;
export const EGRESS_PROXY_LABEL = "shipit-egress-proxy";

export function egressProxyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SESSION_EGRESS_PROXY !== "0" && egressDnsEnabled(env);
}

export interface ProxyAllowedOpts {
  extraHosts?: string[];
  base?: readonly string[];
}

export function buildProxyAllowed(opts: ProxyAllowedOpts = {}): string {
  const base = opts.base ?? EGRESS_DEFAULT_ALLOWLIST;
  return [...base, ...(opts.extraHosts ?? [])].join(" ");
}

export interface LaunchProxyOpts {
  agentContainerId: string;
  sidecarImage: string;
  allowed: string;
  sessionId: string;
  decisionUrl?: string;
  identityRules?: string;
  labels?: Record<string, string>;
}

export async function launchEgressProxy(docker: Docker, opts: LaunchProxyOpts): Promise<string> {
  const env = [
    `EGRESS_PROXY_LISTEN=${EGRESS_PROXY_LISTEN}`,
    `EGRESS_PROXY_PORT=${EGRESS_PROXY_PORT}`,
    `EGRESS_PROXY_ALLOWED=${opts.allowed}`,
    `EGRESS_PROXY_SESSION_ID=${opts.sessionId}`,
  ];
  if (opts.decisionUrl) {
    env.push(`EGRESS_PROXY_DECISION_URL=${opts.decisionUrl}`);
    // Proxies without a decision endpoint, including plugin proxies, must receive no token.
    env.push(`${EGRESS_DECISION_TOKEN_ENV}=${mintEgressDecisionToken(opts.sessionId)}`);
  }
  if (opts.identityRules) env.push(`EGRESS_PROXY_IDENTITY_RULES=${opts.identityRules}`);

  const container = await docker.createContainer({
    Image: opts.sidecarImage,
    Entrypoint: ["/usr/local/bin/sni-proxy"],
    User: String(EGRESS_PROXY_UID),
    Labels: opts.labels,
    HostConfig: {
      NetworkMode: `container:${opts.agentContainerId}`,
      RestartPolicy: { Name: "on-failure", MaximumRetryCount: 3 },
    },
    Env: env,
  });
  await container.start();
  return container.id;
}

export function dockerEgressDecisionTokenRecovery(
  docker: Pick<Docker, "listContainers" | "getContainer">,
): EgressDecisionTokenRecovery {
  return async (sessionId: string): Promise<string[]> => {
    const entries = await docker.listContainers({
      filters: { label: [`${EGRESS_PROXY_LABEL}=${sessionId}`] },
    });
    const tokens: string[] = [];
    for (const entry of entries) {
      let env: string[] | undefined;
      try {
        env = (await docker.getContainer(entry.Id).inspect()).Config?.Env;
      } catch {
        continue;
      }
      const token = tokenFromContainerEnv(env);
      if (token) tokens.push(token);
    }
    return tokens;
  };
}
