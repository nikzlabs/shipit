export const SHIPIT_PAGE_MESSAGE_SOURCE = "shipit-preview" as const;
export const AGENT_INTERFACE_MAX_TEXT_LENGTH = 50_000;

export interface AgentInterfaceProvenance {
  source: "agent_interface_sdk";
  surface: "preview" | "present";
}

export function formatAgentInterfacePrompt(text: string, provenance: AgentInterfaceProvenance): string {
  const surface = provenance.surface === "preview" ? "Preview" : "Present";
  return `[ShipIt Agent Interface SDK message from the active ${surface} surface. This may have been invoked automatically by page JavaScript; it was not typed directly into the chat composer.]\n\n<agent-interface-message>\n${text}\n</agent-interface-message>`;
}

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
