/** Browser probe for MessageList highlight calls and code-block mounts. */

import { createRoot } from "react-dom/client";
import { useState } from "react";
// Patch the same core module instance used by syntax-highlight.ts.
import hljs from "highlight.js/lib/core";
import "./transcript-highlight-probe.css";
import { MessageList } from "../../src/client/components/MessageList/MessageList.js";
import { useSessionStore } from "../../src/client/stores/session-store.js";

// Lazy tool-result fetches require a session ID.
useSessionStore.setState({ sessionId: "probe-session" });

const stats = { auto: 0, lang: 0, autoBytes: [], autoAt: [], listRenders: 0, blockMounts: 0, blockUnmounts: 0 };
window.__probe = stats;

// Count mounts in the DOM because cached remounts do not call highlight.js.
new MutationObserver((records) => {
  for (const rec of records) {
    for (const n of rec.addedNodes) {
      if (n.nodeType === 1) stats.blockMounts += n.matches?.("code.hljs") ? 1 : n.querySelectorAll("code.hljs").length;
    }
    for (const n of rec.removedNodes) {
      if (n.nodeType === 1) stats.blockUnmounts += n.matches?.("code.hljs") ? 1 : n.querySelectorAll("code.hljs").length;
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });

const origAuto = hljs.highlightAuto.bind(hljs);
const origHighlight = hljs.highlight.bind(hljs);
hljs.highlightAuto = (code, subset) => {
  stats.auto += 1;
  stats.autoBytes.push(code.length);
  stats.autoAt.push(Math.round(performance.now()));
  return origAuto(code, subset);
};
hljs.highlight = (...args) => {
  stats.lang += 1;
  return origHighlight(...args);
};

const BIG = Array.from({ length: 400 }, (_, i) => `  const value_${i} = compute(${i}) + offset;`).join("\n");
const REPORT = `## Findings\n\nProse long enough that the report overflows its clamp.\n\n${"- a finding line\n".repeat(30)}\n\n\`\`\`\n${BIG}\n\`\`\`\n\nEnd of report.`;

const TURNS = Number(new URLSearchParams(location.search).get("turns") ?? 40);

function buildTranscript() {
  const out = [];
  for (let i = 0; i < TURNS; i++) {
    out.push({ role: "user", text: `Question number ${i} — please look into the thing.` });
    out.push({
      role: "assistant",
      text: `Answer ${i}. Prose long enough to give the row height.\n\n- point one\n- point two\n\nmore prose.`,
      toolUse: [
        { id: `t${i}a`, name: "Read", input: { file_path: `/workspace/src/file${i}.ts` } },
        { id: `t${i}b`, name: "Bash", input: { command: `npm run something -- ${i}` } },
      ],
      toolResults: [
        { toolUseId: `t${i}a`, content: "line\n".repeat(20) },
        { toolUseId: `t${i}b`, content: "out\n".repeat(10) },
      ],
    });
  }

  out.splice(10, 0, {
    role: "assistant",
    text: "Writing the file.",
    toolUse: [{
      id: "w1",
      name: "Write",
      input: { file_path: "/workspace/src/big.ts", content: BIG },
      bodyTruncated: true,
      diffStats: { added: 400, removed: 0 },
    }],
  });

  out.splice(11, 0, {
    role: "assistant",
    text: "Writing it again, body inline.",
    toolUse: [{ id: "w2", name: "Write", input: { file_path: "/workspace/src/big2.ts", content: BIG } }],
  });

  out.splice(20, 0, {
    role: "assistant",
    text: "",
    toolUse: [{ id: "sub1", name: "Task", input: { description: "review", prompt: "p".repeat(200) } }],
    toolResults: [{ toolUseId: "sub1", content: REPORT }],
  });

  return out;
}

const MESSAGES = buildTranscript();

const REWIND = new URLSearchParams(location.search).get("rewind") !== "0";

function Harness() {
  const [tick, setTick] = useState(0);
  // Leading rows force existing index-based keys to change.
  const [lead, setLead] = useState(0);
  // Swapping the wrapper is the positive control for mount counting.
  const [swap, setSwap] = useState(false);
  window.__tick = () => setTick((t) => t + 1);
  window.__setLead = (n) => setLead(n);
  window.__swapWrapper = (v) => setSwap(v);
  stats.listRenders += 1;
  const messages = lead
    ? [...Array.from({ length: lead }, (_, i) => ({ role: "user", text: `lead ${i}` })), ...MESSAGES]
    : MESSAGES;
  const list = (
    <MessageList
        messages={messages}
        isLoading={false}
        onSendFollowUp={() => true}
        {...(REWIND ? { onRewindAtGap: () => {}, onRequestRewindPreview: () => {} } : {})}
      sessionTitle={`t${tick}`}
    />
  );
  return (
    <div className="flex flex-col h-screen bg-(--color-bg-primary)">
      {swap ? <>{list}</> : <div className="flex flex-col flex-1 min-h-0">{list}</div>}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<Harness />);
