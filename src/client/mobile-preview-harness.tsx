/**
 * Dev-only harness for the mobile-preview feature (docs/066).
 *
 * Mounts the real `PreviewFrame` against a fixed "running" preview on port
 * 8080 (the page is served by docs/066-mobile-preview/harness-server.ts) and
 * seeds the preview store for session "harness" — including the localStorage
 * viewport restore, so reloading the page demonstrates persistence.
 *
 * Not part of the app build: `vite build` only bundles index.html, so this
 * entry (mobile-preview-harness.html) never reaches production output. It is
 * typechecked and linted like the rest of the client.
 */
import { createRoot } from "react-dom/client";
import { PreviewFrame } from "./components/PreviewFrame.js";
import { usePreviewStore } from "./stores/preview-store.js";
import "./index.css";

// Seed before the first render: what useSessionActivation does for a real
// session, and the exact code path under test on a reload.
usePreviewStore.getState().restoreSession("harness");

createRoot(document.getElementById("root")!).render(
  <PreviewFrame
    preview={{ running: true, port: 8080, url: "http://localhost:8080", source: "detected" }}
    sessionId="harness"
    detectedPorts={[]}
    selectedPort={null}
    onSelectPort={() => {}}
    errors={[]}
    onSendErrors={() => {}}
    onClearErrors={() => {}}
  />,
);
