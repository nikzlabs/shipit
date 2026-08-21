import { useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { DEVICE_PADDING, resolveDeviceViewport } from "./components/PreviewFrame/DeviceFrame.js";
import { PreviewToolbar } from "./components/PreviewFrame/PreviewToolbar.js";
import { usePreviewStore } from "./stores/preview-store.js";

const BREAKPOINT_PAGE = `<!doctype html><html><head><style>
  html, body { margin: 0; height: 100%; }
  body {
    background: #b91c1c; /* mobile red */
    display: flex; align-items: center; justify-content: center;
    font: 600 28px system-ui, sans-serif; color: #fff;
  }
  @media (min-width: 640px) { body { background: #15803d; } }  /* tablet green */
  @media (min-width: 1024px) { body { background: #1d4ed8; } } /* desktop blue */
</style></head><body><div id="label"></div>
<script>
  const el = document.getElementById("label");
  const paint = () => {
    el.textContent = "innerWidth=" + window.innerWidth + " innerHeight=" + window.innerHeight;
  };
  window.addEventListener("resize", paint);
  paint();
</script></body></html>`;

function Harness() {
  const [panelSize, setPanelSize] = useState({ width: 700, height: 500 });
  const devicePreset = usePreviewStore((s) => s.devicePreset);
  const isLandscape = usePreviewStore((s) => s.isLandscape);
  const customSize = usePreviewStore((s) => s.customSize);

  const m = resolveDeviceViewport({
    devicePreset,
    isLandscape,
    customSize,
    containerWidth: panelSize.width,
    containerHeight: panelSize.height,
  });

  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 8, fontSize: 12 }}>
        {[
          { label: "700×500", w: 700, h: 500 },
          { label: "350×600", w: 350, h: 600 },
          { label: "1200×800", w: 1200, h: 800 },
        ].map((s) => (
          <button key={s.label} onClick={() => setPanelSize({ width: s.w, height: s.h })}>
            {s.label}
          </button>
        ))}
        <button onClick={() => usePreviewStore.getState().reset()}>Reset store</button>
      </div>
      <div
        style={{
          width: panelSize.width,
          height: panelSize.height,
          border: "1px solid #555",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <PreviewToolbar
          isRunning
          showSelector={false}
          portSelectorOpen={false}
          setPortSelectorOpen={() => {}}
          activeStatus="running"
          portLabel="localhost:5173"
          allPorts={[]}
          activePort={5173}
          onSelectPort={() => {}}
          deviceFrameActive={m.frameActive}
          deviceWidth={m.width}
          deviceHeight={m.height}
          deviceScale={m.scale}
          deviceScalePercent={m.scalePercent}
          hasErrors={false}
          errorCount={0}
          errorPanelOpen={false}
          setErrorPanelOpen={() => {}}
          onRefresh={() => {}}
          onBack={() => {}}
          onHome={() => {}}
          activeSlotUrl="http://localhost:5173"
          previewPath={null}
          previewFullUrl={null}
        />
        <div
          data-testid="panel"
          style={{
            flex: 1,
            position: "relative",
            background: m.frameActive ? "#1f2937" : "#fff",
            overflow: "hidden",
          }}
        >
          <iframe
            data-testid="frame"
            title="harness preview"
            srcDoc={BREAKPOINT_PAGE}
            style={
              m.frameActive
                ? {
                    position: "absolute",
                    width: m.width,
                    height: m.height,
                    left: "50%",
                    top: "50%",
                    transform: `translate(-50%, -50%) scale(${m.scale})`,
                    transformOrigin: "center center",
                    border: "1px solid #888",
                    borderRadius: 8,
                    background: "#fff",
                  }
                : { position: "absolute", inset: 0, width: "100%", height: "100%", border: 0 }
            }
          />
          {m.frameActive && (
            <div
              data-testid="indicator"
              style={{
                position: "absolute",
                top: 8,
                left: "50%",
                transform: "translateX(-50%)",
                background: "rgba(0,0,0,0.6)",
                color: "#fff",
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: 999,
                fontFamily: "monospace",
                pointerEvents: "none",
              }}
            >
              {m.width}×{m.height}
              {m.scale < 1 ? ` (${m.scalePercent}%)` : ""}
            </div>
          )}
        </div>
      </div>
      <div id="state" style={{ fontSize: 11, fontFamily: "monospace", color: "#888" }}>
        preset={devicePreset?.id ?? "null"} landscape={String(isLandscape)} customSize=
        {JSON.stringify(customSize)} scale={m.scale.toFixed(3)} padding={DEVICE_PADDING}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);