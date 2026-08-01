export const SHIPIT_PAGE_MESSAGE_SOURCE = "shipit-preview" as const;
export const AGENT_INTERFACE_MAX_TEXT_LENGTH = 50_000;

export interface AgentInterfaceRequest {
  source: typeof SHIPIT_PAGE_MESSAGE_SOURCE;
  type: "agent_message";
  requestId: string;
  payload: { text: string };
}

export type AgentInterfaceResponse = {
  source: typeof SHIPIT_PAGE_MESSAGE_SOURCE;
  type: "agent_message_result";
  requestId: string;
} & (
  | { ok: true; status: "submitted" }
  | { ok: false; error: string }
);

export interface ShipItVisibilityMessage {
  source: typeof SHIPIT_PAGE_MESSAGE_SOURCE;
  type: "visibility";
  visible: boolean;
}

export function isAgentInterfaceRequest(value: unknown): value is AgentInterfaceRequest {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<AgentInterfaceRequest>;
  if (
    message.source !== SHIPIT_PAGE_MESSAGE_SOURCE
    || message.type !== "agent_message"
    || typeof message.requestId !== "string"
    || message.requestId.length === 0
    || message.requestId.length > 200
    || !message.payload
    || typeof message.payload !== "object"
  ) return false;
  const text = (message.payload as { text?: unknown }).text;
  return typeof text === "string"
    && text.trim().length > 0
    && text.length <= AGENT_INTERFACE_MAX_TEXT_LENGTH;
}

