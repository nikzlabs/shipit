// TEMPORARY verification harness (docs/278 live check) — deleted after use.
import { createRoot } from "react-dom/client";
import { PreviewFrame } from "./components/PreviewFrame.js";
import { usePreviewStore } from "./stores/preview-store.js";
import "./index.css";

const PORT = window.location.port ? Number(window.location.port) : 80;
const SLOT = "harness:" + PORT;

const store = usePreviewStore.getState();
store.clearPreviewPaths();
store.setPreviewPath(SLOT, "/viewport-demo-app.html");
usePreviewStore.setState({
  status: {
    running: true,
    port: PORT,
    url: window.location.origin + "/",
    source: "vite",
  },
});

createRoot(document.getElementById("panel")!).render(
  <div style={{ height: "100%" }}>
    <PreviewFrame
      preview={usePreviewStore.getState().status}
      sessionId="harness"
      detectedPorts={[]}
      selectedPort={null}
      onSelectPort={() => {}}
      errors={[]}
      onSendErrors={() => {}}
      onClearErrors={() => {}}
    />
  </div>,
);
