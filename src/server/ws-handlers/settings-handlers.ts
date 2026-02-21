import type { WsClientMessage } from "../types.js";
import type { HandlerContext } from "./types.js";

type WsPasteAuthCode = Extract<WsClientMessage, { type: "paste_auth_code" }>;

export function handleStartAuth(ctx: HandlerContext): void {
  ctx.authManager.startOAuthFlow();
}

export function handlePasteAuthCode(ctx: HandlerContext, msg: WsPasteAuthCode): void {
  const code = typeof msg.code === "string" ? msg.code.trim() : "";
  if (!code) {
    ctx.send({ type: "error", message: "Authorization code cannot be empty" });
  } else {
    ctx.authManager.sendCode(code);
  }
}
