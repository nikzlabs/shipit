/**
 * Resolve the host (and protocol) used to build container-preview subdomain URLs
 * (`{sessionId}--{port}.<host>`). See `docs/216-tailnet-magicdns-preview-host`.
 *
 * The override is applied ONLY when both signals hold:
 *  1. the server advertises a Tailscale sslip preview host (`tailnetPreviewHost`), and
 *  2. the page is browsed over the node's native MagicDNS name (`*.ts.net`).
 *
 * In that case previews route through the sslip host, forced to `http:` (the
 * sslip host has no wildcard TLS cert, and the MagicDNS app is itself HTTP, so
 * there is no mixed-content downgrade). Every other access path — Cloudflare, a
 * direct sslip.io URL, localhost — falls through to today's behavior, so the
 * override can never hijack a preview path that already works.
 *
 * `VITE_API_HOST` is a DEV-ONLY override (set in `docker/local/dev/compose.yml`,
 * unset in the VPS prod image); kept first so the local dev loop is untouched.
 * It deliberately governs preview host resolution AND the WS/SSE host elsewhere —
 * see the precondition note in the design doc.
 */
/**
 * For a host that can't carry preview subdomains, suggest one that can — or
 * `null` when we have nothing concrete to offer (docs/254 req 8).
 *
 * Only raw IPv4 gets a suggestion, and only via sslip.io, a public wildcard
 * resolver that maps any `<dashed-ip>.sslip.io` name back to that IP. That turns
 * an un-subdomainable host into a working one with no owned domain and no DNS
 * setup, which is exactly the local-install-over-Tailscale case
 * (`deployment/local/tailscale.sh`) and the LAN case. The dashed form is what
 * dodges the raw-IPv4 guard in `buildSubdomainUrl`.
 *
 * Deliberately not suggested for IPv6 literals or dotless hostnames: there is no
 * equivalent one-step fix, so the generic guidance in the empty state is all we
 * can honestly give.
 */
export function suggestWildcardHost(locationHost: string): string | null {
  const [hostname, port] = locationHost.includes(":")
    ? (locationHost.split(":") as [string, string])
    : [locationHost, ""];
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return null;
  if (hostname.split(".").some((o) => Number(o) > 255)) return null;
  // Loopback already works as `localhost`; suggesting sslip.io would be a downgrade.
  if (hostname.startsWith("127.")) return null;
  return `${hostname.replace(/\./g, "-")}.sslip.io${port ? `:${port}` : ""}`;
}

export function resolvePreviewHost(
  locationHost: string,
  tailnetPreviewHost: string | null | undefined,
): { host: string; protocol: string } {
  const viteHost = import.meta.env.VITE_API_HOST as string | undefined;
  if (viteHost) {
    return { host: viteHost, protocol: window.location.protocol };
  }
  const hostname = locationHost.split(":")[0].toLowerCase();
  if (tailnetPreviewHost && hostname.endsWith(".ts.net")) {
    return { host: tailnetPreviewHost, protocol: "http:" };
  }
  return { host: locationHost, protocol: window.location.protocol };
}
