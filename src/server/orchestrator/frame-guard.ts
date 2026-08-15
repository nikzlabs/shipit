/**
 * planning#379 — refuse to be framed (clickjacking).
 *
 * The third guard in the set, and the one the other two cannot cover.
 * `api-container-guard.ts` classifies a caller by source IP;
 * `api-origin-guard.ts` classifies a browser caller by `Origin`. A clickjack
 * defeats both **by construction**: the hostile page never calls ShipIt at all.
 * It frames ShipIt's own UI, overlays it, and lets the user click a real
 * control. The request that follows is issued by ShipIt's own frame, so it
 * carries ShipIt's own `Origin` and `Sec-Fetch-Site: same-origin` — it is
 * indistinguishable from a real click, because it IS one. Everything the agent
 * can do is one such click away: dispatch a turn, merge a PR, grant an egress
 * host.
 *
 * So the defence has to be at the framing step, before any request exists:
 * tell the browser not to render ShipIt inside someone else's document.
 *
 * This file is the Fastify half. The policy itself lives in
 * `shared/frame-policy.ts` because the orchestrator is not the only server that
 * hands the UI to a browser — the **Vite dev server** serves the document in
 * `docker/local/dev/compose.yml`, and `vite.config.ts` reads the same policy so
 * that surface is not left frameable (review finding).
 *
 * ## Two headers, and why both
 *
 * `Content-Security-Policy: frame-ancestors 'none'` is the authority — every
 * browser that implements it ignores `X-Frame-Options` entirely. `X-Frame-
 * Options: DENY` is sent alongside for anything that doesn't. They can be
 * exactly equivalent only because the policy is `'none'`: `X-Frame-Options`
 * has no working way to express an allowlist (`ALLOW-FROM` is unimplemented in
 * every current browser), so a future policy that permitted a named framer
 * would have to drop the `X-Frame-Options` line rather than weaken it.
 *
 * The CSP header is written whole rather than merged. ShipIt sends no other CSP
 * on its own responses today; anything that adds one must compose with
 * {@link frameGuardHeaders} rather than overwrite it.
 *
 * ## Local mode does NOT send them, deliberately
 *
 * `RUNTIME_MODE=local` is the dogfood inner orchestrator (docs/118) and nothing
 * else — the repo's own `dev` / `onboarding` Compose services, running inside an
 * outer ShipIt session container. Being framed is that instance's entire job:
 * the **outer** ShipIt renders it in the preview pane at
 * `{sessionId}--{port}.<outer host>`, which is a different origin from the outer
 * UI, so `'self'` would not cover it either. A deny there breaks the loop this
 * project develops in.
 *
 * That split is safe because the two deployments are not the same subject. The
 * attack this closes needs a *victim's browser* pointed at a *hostile page*
 * while it holds a session with a reachable ShipIt. A local-mode instance is
 * reached only through the developer's own outer instance's preview proxy, on
 * their own machine, holding dogfood state; and running local mode as a real
 * deployment is an explicit non-goal of docs/118. It is a strictly smaller
 * exposure than the outer instance that frames it — which DOES send the header.
 *
 * Rejected: deriving the outer origin from `X-Forwarded-Host` (strip the
 * `{uuid}--{port}.` label the preview proxy puts there) and sending a narrow
 * `frame-ancestors <outer origin>` in local mode. It is expressible, but today
 * the inner shell is served by **Vite**, not by `serveStaticClient` — the inner
 * orchestrator never sees the framed document request at all — so the allowance
 * would be untestable machinery guarding a response that does not exist. If an
 * inner instance ever serves its own production build, that is the design to
 * reach for.
 *
 * ## Preview responses are not ShipIt's
 *
 * A request whose `Host` is `{uuid}--{port}.…` belongs to the previewed app, and
 * the preview pane frames it on purpose. Those are skipped, on the same
 * condition the origin guard uses (`hasPreviewProxy`), so a runtime with no
 * proxy cannot be opted out of the header by a forged `Host`. In practice the
 * proxy hijacks the reply and writes upstream headers raw, so nothing set here
 * would survive anyway — the skip states the rule rather than relying on that.
 *
 * The other two framing surfaces in the product need nothing here: the Present
 * tab and the file viewer render into a `srcDoc` iframe with
 * `sandbox="allow-scripts"` (`RenderedFrame.tsx`), which carries no ShipIt
 * origin and fetches no ShipIt URL.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { frameGuardHeaders, type FramePolicy } from "../shared/frame-policy.js";
import { hasPreviewProxy } from "./api-origin-guard.js";
import { parsePreviewSubdomain } from "./preview-proxy.js";

export { framePolicyFor, frameGuardHeaders, type FramePolicy } from "../shared/frame-policy.js";

/**
 * Register the anti-framing headers on every response this orchestrator owns.
 *
 * Registered next to the origin guard in `createOrchestratorApp` so the two
 * browser-facing trust decisions live in one place, and as an `onRequest` hook
 * so the headers reach responses no route handler produces — the SPA fallback,
 * a 404.
 *
 * Registered AFTER the origin guard, whose "must be the first `onRequest` hook"
 * ordering is load-bearing. The consequence is that a request the origin guard
 * refuses gets no framing header, because that hook replies without calling
 * `done()`. Left that way on purpose: its 403 is a JSON error body with nothing
 * to click.
 */
export function registerFrameGuard(app: FastifyInstance, policy: FramePolicy): void {
  const headers = Object.entries(frameGuardHeaders(policy));
  if (headers.length === 0) return;

  app.addHook("onRequest", (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    if (hasPreviewProxy(app) && parsePreviewSubdomain(request.headers.host)) {
      done();
      return;
    }
    for (const [name, value] of headers) reply.header(name, value);
    done();
  });
}
