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
