// Resolve concrete hosts for the IP filter; GitHub uses its published CIDRs.
export const EGRESS_TIER_A_RESOLVE_HOSTS: readonly string[] = [
  "api.anthropic.com",
  "console.anthropic.com",
  "statsig.anthropic.com",
  "platform.claude.com",
  "api.openai.com",
  "auth.openai.com",
  "chatgpt.com",
  "api.deepseek.com",
  "api.z.ai",
  "openrouter.ai",
  "ai-gateway.vercel.sh",
  "opencode.ai",
  "api.x.ai",
  "auth.x.ai",
  "cli-chat-proxy.grok.com",
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
];

export const EGRESS_GITHUB_CIDRS_FALLBACK: readonly string[] = [
  "140.82.112.0/20",
  "143.55.64.0/20",
  "185.199.108.0/22",
  "192.30.252.0/22",
  "20.201.28.0/22",
  "20.205.243.0/24",
  "2606:50c0::/32",
];

function isValidIpv4(s: string): boolean {
  const parts = s.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    return n >= 0 && n <= 255 && String(n) === p;
  });
}

function isValidIpv6(s: string): boolean {
  if (!s.includes(":")) return false;
  if (!/^[0-9a-fA-F:]+$/.test(s)) return false;
  if ((s.match(/::/g) ?? []).length > 1) return false;
  return true;
}

export function isValidIp(s: string): boolean {
  return isValidIpv4(s) || isValidIpv6(s);
}

export function isValidCidr(s: string): boolean {
  const slash = s.indexOf("/");
  if (slash === -1) return false;
  const addr = s.slice(0, slash);
  const prefixStr = s.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixStr)) return false;
  const prefix = Number(prefixStr);
  if (isValidIpv4(addr)) return prefix >= 0 && prefix <= 32;
  if (isValidIpv6(addr)) return prefix >= 0 && prefix <= 128;
  return false;
}

export function parseGitHubMetaCidrs(meta: unknown): string[] {
  if (!meta || typeof meta !== "object") return [];
  const obj = meta as Record<string, unknown>;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of ["web", "api", "git"] as const) {
    const arr = obj[key];
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      if (typeof entry !== "string") continue;
      const cidr = entry.trim();
      if (!isValidCidr(cidr) || seen.has(cidr)) continue;
      seen.add(cidr);
      out.push(cidr);
    }
  }
  return out;
}

export function extractNetworkSubnets(networkInfo: unknown): string[] {
  if (!networkInfo || typeof networkInfo !== "object") return [];
  const ipam = (networkInfo as Record<string, unknown>).IPAM;
  if (!ipam || typeof ipam !== "object") return [];
  const config = (ipam as Record<string, unknown>).Config;
  if (!Array.isArray(config)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of config) {
    if (!entry || typeof entry !== "object") continue;
    const subnet = (entry as Record<string, unknown>).Subnet;
    if (typeof subnet !== "string") continue;
    const cidr = subnet.trim();
    if (!isValidCidr(cidr) || seen.has(cidr)) continue;
    seen.add(cidr);
    out.push(cidr);
  }
  return out;
}

export function buildIpsetMembers(opts: { ips?: readonly string[]; cidrs?: readonly string[] }): string[] {
  const members = new Set<string>();
  for (const ip of opts.ips ?? []) {
    const v = ip.trim();
    if (v && isValidIp(v)) members.add(v);
  }
  for (const cidr of opts.cidrs ?? []) {
    const v = cidr.trim();
    if (v && isValidCidr(v)) members.add(v);
  }
  return [...members].sort();
}
