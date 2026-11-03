import type { AgentRequestUsage } from "./types/agent-types.js";

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
  /** v1 nests `data`; v2 is flat, e.g. `{type: "provider.auth", message, status: 401}`. */
  error?: {
    name?: string;
    data?: { message?: string; statusCode?: number; isRetryable?: boolean };
    type?: string;
    message?: string;
    status?: number;
  };
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
  /** One entry per step, which is one model call (docs/329-tiered-model-pricing). */
  readonly requests: AgentRequestUsage[] = [];

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
        if (part?.tokens) this.addStep(part.tokens);
        break;
      }
      case "error": {
        const data = event.error?.data;
        this.errorMessage =
          data?.message ?? event.error?.message ?? event.error?.name ?? "OpenCode reported an error";
        break;
      }
      default:
        break;
    }
  }

  /** OpenCode 2's stream drops the last step_finish; its server's message list has every step. */
  replaceSteps(steps: readonly { tokens?: OpencodeTokens; cost?: number }[]): void {
    this.costUsd = 0;
    this.input = 0;
    this.output = 0;
    this.cacheRead = 0;
    this.cacheWrite = 0;
    this.contextTokens = undefined;
    this.requests.length = 0;
    for (const step of steps) {
      if (typeof step.cost === "number") this.costUsd += step.cost;
      if (step.tokens) this.addStep(step.tokens);
    }
  }

  private addStep(t: OpencodeTokens): void {
    // Reasoning is generated, so it bills as output and is no part of the prompt.
    const request: AgentRequestUsage = {
      input: t.input ?? 0,
      output: (t.output ?? 0) + (t.reasoning ?? 0),
      cacheRead: t.cache?.read ?? 0,
      cacheWrite: t.cache?.write ?? 0,
    };
    this.requests.push(request);
    this.input += request.input;
    this.output += request.output ?? 0;
    this.cacheRead += request.cacheRead ?? 0;
    this.cacheWrite += request.cacheWrite ?? 0;
    const context = request.input + (request.cacheRead ?? 0) + (request.cacheWrite ?? 0);
    if (context > 0) this.contextTokens = context;
  }
}
