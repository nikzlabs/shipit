/**
 * Transcript highlight probe (docs/265 section 2b).
 *
 * Counts `highlight.js` calls made by the REAL `MessageList` in a REAL browser,
 * so the transcript can be cleared of — or convicted of — repeating a syntax
 * highlight. jsdom is not a substitute: it has no `content-visibility`, no
 * `ResizeObserver` and no `IntersectionObserver`, which are exactly the three
 * mechanisms a scroll-driven or layout-driven repeat would run through.
 *
 * Plain JSX rather than TSX because `tsconfig.json` has `rootDir: "src"`, so a
 * `.tsx` here is typechecked by nothing and unparseable by eslint. See the vite
 * config beside it.
 *
 * ## Why it measures wall clock, not renders
 *
 * A production trace (2026-08-30) recorded 35 `highlightAuto` calls. Grouped by
 * idle gap they were not 35 events: 29 ran back-to-back with 3-6 ms between them
 * for 8.2 s, at a period equal to one highlight — a self-sustaining loop. A test
 * that drives N scripted re-renders and counts calls cannot see one. So the
 * probe drives an interaction, then sits idle, and asks whether the count keeps
 * climbing.
 *
 * ## Running it
 *
 *     npx vite --config scripts/fixtures/transcript-highlight-probe.vite.config.mjs --port 5199
 *     → http://127.0.0.1:5199/transcript-highlight-probe.html
 *
 * Drive it from the console or Playwright. `window.__probe` holds
 * `{ auto, lang, autoBytes, autoAt, listRenders }`; `autoAt` is a timestamp per
 * call, so the gaps between calls reconstruct the burst structure the trace
 * showed. `window.__tick()` forces a `MessageList` re-render with a changed prop.
 *
 * **Check `getComputedStyle(row).contentVisibility === "auto"` before trusting a
 * run.** The first version of this fixture measured `visible`, because Tailwind
 * scans from the Vite root and never read `src/client` — so the browser was not
 * doing the thing under test and every number was a false negative. The
 * `@source` in the CSS beside this file is the fix.
 *
 * ## What it has established (2026-08-30, recorded in docs/265's checklist)
 *
 * Zero extra highlights from: 6 s idle; 5 s of continuous scrolling then 6 s
 * idle; 20 forced re-renders; replacing every `ChatMessage` object. Opening the
 * diff modal costs exactly one and stays flat over 9 s idle.
 *
 * It also fixes each call site's payload size, which is how a measured duration
 * becomes a surface: `WriteContent` highlights a WHOLE file body (16,979 bytes
 * for the 400-line fixture here — the trace's ~274 ms), while `ReadResult`
 * highlights only its `READ_MAX_LINES` preview unless the user expanded it.
 */

import { createRoot } from "react-dom/client";
import { useState } from "react";
import hljs from "highlight.js";
import "./transcript-highlight-probe.css";
import { MessageList } from "../../src/client/components/MessageList/MessageList.js";
import { useSessionStore } from "../../src/client/stores/session-store.js";

// The docs/244 lazy fetches are gated on a session id; without one they are
// disabled and the paths under test never run.
useSessionStore.setState({ sessionId: "probe-session" });

const stats = { auto: 0, lang: 0, autoBytes: [], autoAt: [], listRenders: 0 };
window.__probe = stats;

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

/** ~400 lines, i.e. the ~274 ms `highlightAuto` the production trace measured. */
const BIG = Array.from({ length: 400 }, (_, i) => `  const value_${i} = compute(${i}) + offset;`).join("\n");
const REPORT = `## Findings\n\nProse long enough that the report overflows its clamp.\n\n${"- a finding line\n".repeat(30)}\n\n\`\`\`\n${BIG}\n\`\`\`\n\nEnd of report.`;

function buildTranscript() {
  const out = [];
  for (let i = 0; i < 40; i++) {
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

  // A Write of a whole file, carrying the docs/244 stripped-body markers — so
  // opening its modal exercises the lazy fetch and its error branch.
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

  // The same Write with its body still inline. Both shapes are present because
  // they fail differently, and only this one reaches `WriteContent` — the single
  // call site that highlights an untruncated body.
  out.splice(11, 0, {
    role: "assistant",
    text: "Writing it again, body inline.",
    toolUse: [{ id: "w2", name: "Write", input: { file_path: "/workspace/src/big2.ts", content: BIG } }],
  });

  // A subagent report carrying the same block: the shape that pairs
  // `SubagentReport`'s `useOverflows` ResizeObserver with `content-visibility`.
  out.splice(20, 0, {
    role: "assistant",
    text: "",
    toolUse: [{ id: "sub1", name: "Task", input: { description: "review", prompt: "p".repeat(200) } }],
    toolResults: [{ toolUseId: "sub1", content: REPORT }],
  });

  return out;
}

const MESSAGES = buildTranscript();

function Harness() {
  const [tick, setTick] = useState(0);
  window.__tick = () => setTick((t) => t + 1);
  stats.listRenders += 1;
  return (
    <div className="flex flex-col h-screen bg-(--color-bg-primary)">
      <MessageList
        messages={MESSAGES}
        isLoading={false}
        onSendFollowUp={() => true}
        onRewindAtGap={() => {}}
        onRequestRewindPreview={() => {}}
        sessionTitle={`t${tick}`}
      />
    </div>
  );
}

createRoot(document.getElementById("root")).render(<Harness />);
