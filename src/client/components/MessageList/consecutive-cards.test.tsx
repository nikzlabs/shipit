import { describe, it, expect, beforeAll } from "vitest";
import { render } from "@testing-library/react";
import type { ChatMessage } from "./types.js";
import { MessageList } from "./MessageList.js";
import type { SettingsProposalCard } from "../../../server/shared/types.js";

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});

const card = (cardId: string, item: string): SettingsProposalCard => ({
  cardId,
  target: { key: "roles[].harness", item },
  label: "Harness",
  description: "The agent CLI the role runs.",
  path: "Settings › Roles",
  from: "claude",
  to: "opencode2",
  phase: "pending",
  createdAt: "2026-11-10T09:31:12.502Z",
});

describe("MessageList — card-only rows in a row", () => {
  it("renders two settings proposals from one tool result as two cards", () => {
    const messages: ChatMessage[] = [
      { role: "user", text: "switch both roles" },
      {
        role: "assistant", text: "",
        toolUse: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "shipit settings propose …" } }],
        toolResults: [{ toolUseId: "t1", content: "ok", isError: false }],
      },
      { role: "assistant", text: "", settingsProposal: card("set-a", "AstraOpenCode") },
      { role: "assistant", text: "", settingsProposal: card("set-b", "DeepSeek Flash Max") },
    ];
    const { container } = render(<MessageList messages={messages} isLoading={false} />);
    expect(container.textContent).toContain("AstraOpenCode");
    expect(container.textContent).toContain("DeepSeek Flash Max");
  });
});
