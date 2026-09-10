import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { frameGuardHeaders, type FramePolicy } from "../shared/frame-policy.js";
import { hasPreviewProxy } from "./api-origin-guard.js";
import { parsePreviewSubdomain } from "./preview-proxy.js";

export { framePolicyFor, frameGuardHeaders, type FramePolicy } from "../shared/frame-policy.js";

// Register after the origin guard; its JSON refusals need no framing header.
export function registerFrameGuard(app: FastifyInstance, policy: FramePolicy): void {
  const headers = Object.entries(frameGuardHeaders(policy));
  if (headers.length === 0) return;

  app.addHook("onRequest", (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    // A preview-shaped Host exempts only runtimes that actually proxy previews.
    if (hasPreviewProxy(app) && parsePreviewSubdomain(request.headers.host)) {
      done();
      return;
    }
    for (const [name, value] of headers) reply.header(name, value);
    done();
  });
}
