

import type { ChatMessage } from "../components/MessageList.js";

export function extractTurnProse(turnMessages: ChatMessage[]): string {
  return turnMessages
    .filter((m) => m.role === "assistant" && !m.isError && !m.notice && !m.rolledBack)
    .map((m) => m.text ?? "")
    .filter((t) => t.trim().length > 0)
    .join("\n\n")
    .trim();
}

export function hasSpeakableProse(prose: string): boolean {
  const stripped = prose
    .replace(/```[\s\S]*?```/g, " ")                        
    .replace(/`[^`]*`/g, " ")                         
    .replace(/[#>*_~-]/g, " ")                                 
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")                
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > 0;
}
