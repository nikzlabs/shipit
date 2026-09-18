import type { AgentGoalCommand } from "./types/agent-types.js";

/** docs/154 — `/goal` is ShipIt's command; anything after it that is not a keyword is the objective. */
export function parseGoalCommand(text: string): AgentGoalCommand | null {
  const m = /^\/goal(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const arg = (m[1] ?? "").trim();
  switch (arg) {
    case "":
    case "status":
      return { action: "get" };
    case "clear":
    case "pause":
    case "resume":
      return { action: arg };
    default:
      return { action: "set", objective: arg };
  }
}

export function isGoalCommand(text: string): boolean {
  return parseGoalCommand(text) !== null;
}
