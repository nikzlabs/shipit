import { redactStage1 } from "./services/redaction.js";

export const AGENT_STDERR_TAIL_MAX_CHARS = 300;

const RAW_BUFFER_MAX_CHARS = 8_000;

export interface AgentStderrTail {
  record(source: string, text: string): void;
  describe(): string | undefined;
}

function isStderrSource(source: string): boolean {
  return source.endsWith("stderr");
}

export function createAgentStderrTail(): AgentStderrTail {
  let raw = "";

  return {
    record(source: string, text: string): void {
      if (!isStderrSource(source) || !text) return;
      raw = `${raw}${raw ? "\n" : ""}${text}`;
      if (raw.length > RAW_BUFFER_MAX_CHARS) raw = raw.slice(-RAW_BUFFER_MAX_CHARS);
    },

    describe(): string | undefined {
      if (!raw.trim()) return undefined;
      // Redact before display truncation, which could leave an unrecognizable secret fragment.
      const redacted = redactStage1(raw).text;
      const collapsed = redacted.replace(/\s+/g, " ").trim();
      if (!collapsed) return undefined;
      return collapsed.length > AGENT_STDERR_TAIL_MAX_CHARS
        ? `…${collapsed.slice(-AGENT_STDERR_TAIL_MAX_CHARS)}`
        : collapsed;
    },
  };
}
