/** step_finish token classes do not overlap. */
export interface OpencodeTokens {
  total?: number;
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

export interface OpencodeStepFinishPart {
  type: "step-finish";
  reason?: string;
  tokens?: OpencodeTokens;
  cost?: number;
}

export interface OpencodeTextPart {
  type: "text";
  text?: string;
}

export interface OpencodeToolState {
  status?: string;
  input?: unknown;
  output?: string;
  metadata?: Record<string, unknown>;
  title?: string;
  time?: { start?: number; end?: number };
}

export interface OpencodeToolPart {
  type: "tool";
  tool?: string;
  callID?: string;
  state?: OpencodeToolState;
}

export interface OpencodeEvent {
  type: string;
  timestamp?: number;
  sessionID?: string;
  part?: { id?: string; messageID?: string; sessionID?: string } & (
    | OpencodeStepFinishPart
    | OpencodeTextPart
    | OpencodeToolPart
    | { type?: string }
  );
  error?: { name?: string; data?: { message?: string; statusCode?: number; isRetryable?: boolean } };
}

export function parseOpencodeLine(line: string): OpencodeEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as { type?: unknown }).type === "string") {
      return parsed as OpencodeEvent;
    }
    return null;
  } catch {
    return null;
  }
}

/** No terminal result event exists; accumulate steps until process exit. */
export class OpencodeTurnAccumulator {
  sessionId: string | undefined;
  sawStepFinish = false;
  /** Permits successful teardown when MCP children keep a completed CLI alive. */
  sawFinalStop = false;
  errorMessage: string | undefined;
  finalText = "";
  costUsd = 0;
  input = 0;
  output = 0;
  cacheRead = 0;
  cacheWrite = 0;
  contextTokens: number | undefined;

  observe(event: OpencodeEvent): void {
    if (!this.sessionId && typeof event.sessionID === "string") {
      this.sessionId = event.sessionID;
    }
    switch (event.type) {
      case "text": {
        const part = event.part as OpencodeTextPart | undefined;
        // Events contain whole text blocks, not deltas.
        if (typeof part?.text === "string") this.finalText = part.text;
        break;
      }
      case "step_finish": {
        const part = event.part as OpencodeStepFinishPart | undefined;
        this.sawStepFinish = true;
        if (part?.reason !== "tool-calls") this.sawFinalStop = true;
        if (typeof part?.cost === "number") this.costUsd += part.cost;
        const t = part?.tokens;
        if (t) {
          this.input += t.input ?? 0;
          this.output += t.output ?? 0;
          this.cacheRead += t.cache?.read ?? 0;
          this.cacheWrite += t.cache?.write ?? 0;
          const context =
            (t.input ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
          if (context > 0) this.contextTokens = context;
        }
        break;
      }
      case "error": {
        const data = event.error?.data;
        this.errorMessage =
          data?.message ?? event.error?.name ?? "OpenCode reported an error";
        break;
      }
      default:
        break;
    }
  }
}
