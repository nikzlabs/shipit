import {
  isAgentInterfaceRequest,
  type AgentInterfaceResponse,
  type AgentInterfaceProvenance,
} from "../../server/shared/agent-interface-sdk/protocol.js";

interface HandleAgentInterfaceRequestOptions {
  event: MessageEvent;
  iframe: HTMLIFrameElement;
  expectedOrigin: string;
  surface: AgentInterfaceProvenance["surface"];
  dispatch: (text: string, provenance: AgentInterfaceProvenance) => Promise<void>;
}

export async function handleAgentInterfaceRequest(opts: HandleAgentInterfaceRequestOptions): Promise<boolean> {
  if (!isAgentInterfaceRequest(opts.event.data)) return false;
  if (opts.event.source !== opts.iframe.contentWindow || opts.event.origin !== opts.expectedOrigin) return false;

  const responseTarget = opts.expectedOrigin === "null" ? "*" : opts.expectedOrigin;
  const base = {
    source: "shipit-preview" as const,
    type: "agent_message_result" as const,
    requestId: opts.event.data.requestId,
  };
  let response: AgentInterfaceResponse;
  try {
    await opts.dispatch(opts.event.data.payload.text, {
      source: "agent_interface_sdk",
      surface: opts.surface,
    });
    response = { ...base, ok: true, status: "submitted" };
  } catch (error) {
    response = {
      ...base,
      ok: false,
      error: error instanceof Error ? error.message : "ShipIt rejected the message",
    };
  }
  opts.iframe.contentWindow?.postMessage(response, responseTarget);
  return true;
}

