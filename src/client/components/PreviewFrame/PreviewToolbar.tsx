import { ArrowClockwiseIcon, ArrowLeftIcon, ArrowSquareOutIcon, CaretDownIcon, CheckIcon, HouseIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "../ui/dropdown-menu.js";
import { Button, buttonVariants } from "../ui/button.js";
import { cn } from "../../utils/cn.js";
import { StatusDot } from "../ui/status-dot.js";
import { DeviceSelector } from "../DeviceSelector.js";
import { usePreviewStore } from "../../stores/preview-store.js";
import { usePreviewToolbarCollapse } from "../../hooks/usePreviewToolbarCollapse.js";
import { PreviewPath } from "./PreviewPath.js";

export interface PortInfo {
  port: number;
  label: string;
  status: "running" | "starting" | "error" | "stopped";
}

function statusToDotVariant(status: string): "success" | "warning" | "error" | "info" {
  switch (status) {
    case "running": return "success";
    case "starting": return "warning";
    case "error": return "error";
    default: return "info";
  }
}

interface PreviewToolbarProps {
  isRunning: boolean;

  showSelector: boolean;
  portSelectorOpen: boolean;
  setPortSelectorOpen: (open: boolean) => void;

  activeStatus: string;

  portLabel: string | null;

  allPorts: PortInfo[];
  activePort: number;
  onSelectPort: (port: number) => void;

  deviceFrameActive: boolean;
  deviceWidth: number;
  deviceHeight: number;
  deviceScale: number;
  deviceScalePercent: number;

  freeformPanelSize: { width: number; height: number } | null;

  hasErrors: boolean;
  errorCount: number;
  errorPanelOpen: boolean;
  setErrorPanelOpen: (fn: (prev: boolean) => boolean) => void;

  onRefresh: () => void;

  onBack: () => void;

  onHome: () => void;

  canGoBack?: boolean;

  activeSlotUrl: string | null;

  previewPath: string | null;

  previewFullUrl: string | null;
}

export function PreviewToolbar({
  isRunning,
  showSelector,
  portSelectorOpen,
  setPortSelectorOpen,
  activeStatus,
  portLabel,
  allPorts,
  activePort,
  onSelectPort,
  deviceFrameActive,
  deviceWidth,
  deviceHeight,
  deviceScale,
  deviceScalePercent,
  freeformPanelSize,
  hasErrors,
  errorCount,
  errorPanelOpen,
  setErrorPanelOpen,
  onRefresh,
  onBack,
  onHome,
  canGoBack,
  activeSlotUrl,
  previewPath,
  previewFullUrl,
}: PreviewToolbarProps) {
  const autoFixEnabled = usePreviewStore((s) => s.autoFixEnabled);
  const autoFixRetries = usePreviewStore((s) => s.autoFixRetries);
  const onToggleAutoFix = usePreviewStore((s) => s.toggleAutoFix);
  const devicePreset = usePreviewStore((s) => s.devicePreset);
  const isLandscape = usePreviewStore((s) => s.isLandscape);
  const customSize = usePreviewStore((s) => s.customSize);
  const setDevicePreset = usePreviewStore((s) => s.setDevicePreset);
  const toggleLandscape = usePreviewStore((s) => s.toggleLandscape);
  const setFreeformSize = usePreviewStore((s) => s.setFreeformSize);

  // PreviewFrame; it's null when the page never reported one, and the entry URL

  const openUrl = previewFullUrl ?? activeSlotUrl;

  const collapseSignature = [
    isRunning, showSelector, portLabel ?? "", hasErrors, errorPanelOpen, errorCount,
    deviceFrameActive, deviceWidth, deviceHeight, autoFixEnabled, autoFixRetries,
    previewPath ?? "",

    devicePreset?.label ?? "", isLandscape,

    // the toolbar's own width never changes and its observer never fires.
    deviceScale, deviceScalePercent,
  ].join("|");
  const collapseRef = usePreviewToolbarCollapse(collapseSignature);

  return (

    <div
      ref={collapseRef}
      data-hide-viewport="false"
      data-hide-autofix="false"
      data-hide-service="false"
      className="group/ptb flex items-center justify-between gap-2 px-3 py-1.5 bg-(--color-bg-secondary) border-b border-(--color-border-secondary) text-xs text-(--color-text-secondary)"
    >
      <span className="flex items-center gap-2 shrink-0">
        {showSelector ? (
          <DropdownMenu open={portSelectorOpen} onOpenChange={setPortSelectorOpen}>
            <DropdownMenuTrigger asChild>
              <button
                className="flex items-center gap-1.5 text-(--color-text-primary) hover:text-(--color-text-secondary) transition-colors cursor-pointer"
                aria-label="Select preview port"

                title={portLabel ? `Preview: ${portLabel}` : "Select preview port"}
              >
                <StatusDot status={statusToDotVariant(activeStatus)} />
                {/* Last label to go: the only one that says WHICH service you
                    are looking at. The dot and the tooltip carry it after. */}
                <span className="group-data-[hide-service=true]/ptb:hidden">{portLabel}</span>
                <CaretDownIcon size={ICON_SIZE.XS} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-35">
              {allPorts.map((item) => {
                const isActive = item.port === activePort;
                return (
                  <DropdownMenuItem
                    key={item.port}
                    onSelect={() => onSelectPort(item.port)}
                    className={`text-xs ${
                      isActive
                        ? "text-(--color-text-primary) bg-(--color-bg-hover)"
                        : "text-(--color-text-secondary)"
                    }`}
                  >
                    <StatusDot status={statusToDotVariant(item.status)} />
                    <span className="flex-1">{item.label}</span>
                    {isActive && <CheckIcon size={ICON_SIZE.XS} className="text-(--color-success)" />}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <>
            {/* `activeStatus` first, exactly as the selector branch above uses
                it: with a single service the pane can be parked on one that is
                stopped or starting (planning#478), and a green dot beside a
                "not running" overlay contradicts it. `isRunning || portLabel`
                stays the fallback for a preview no service row describes. */}
            <StatusDot
              status={
                activeStatus !== "running"
                  ? statusToDotVariant(activeStatus)
                  : isRunning || portLabel ? "success" : "info"
              }
            />
            {/* Wrapped, not bare: a raw text node cannot carry the hide class,
                so this label sat outside the collapse ladder and a long service
                name could still clip the row after every stage was spent. */}
            <span
              className={`group-data-[hide-service=true]/ptb:hidden${portLabel ? "" : " text-(--color-text-tertiary)"}`}
              title={portLabel ?? undefined}
            >
              {portLabel ?? "Preview"}
            </span>
          </>
        )}
        {isRunning && (
          <>
            {/* Separates two LABELLED groups, so it goes when the label on its
                left does — between bare icons it is noise, not structure. */}
            <span className="text-(--color-border-secondary) group-data-[hide-service=true]/ptb:hidden">|</span>
            <DeviceSelector
              activePreset={devicePreset}
              isLandscape={isLandscape}
              customSize={customSize}
              panelSize={freeformPanelSize}
              onSelectPreset={setDevicePreset}
              onToggleLandscape={toggleLandscape}
              onCustomSize={setFreeformSize}
            />
            {deviceFrameActive && (
              <span className="text-(--color-text-tertiary) tabular-nums group-data-[hide-viewport=true]/ptb:hidden">
                {deviceWidth}×{deviceHeight}
                {deviceScale < 1 && (
                  <span className="ml-1 text-(--color-text-tertiary)">({deviceScalePercent}%)</span>
                )}
              </span>
            )}
            {/* Closes the viewport-control group and opens the address-bar one.
                This separator belongs to PreviewPath's region visually, but is
                rendered here so Home can sit to the right of it while still
                appearing when the page has reported no path — the very case
                (no injected script) where Home's document-load fallback is
                what the user needs. Rendered whenever the preview runs, so
                the layout doesn't shift when a path arrives. */}
            <span className="text-(--color-border-secondary) group-data-[hide-viewport=true]/ptb:hidden">|</span>
            {/* Sits to the right of the separator, adjacent to the address bar
                (PreviewPath), where a browser puts its home button. */}
            <Button
              variant="ghost"
              size="sm"
              onClick={onHome}
              title="Go to preview root"
              aria-label="Go to preview root"
              disabled={!activeSlotUrl}
              className="h-7 w-7 p-0"
            >
              <HouseIcon size={ICON_SIZE.SM} />
            </Button>
          </>
        )}
      </span>
      {/* Its own flexible region between the two groups, so the path never
          squeezes the selectors on its left and truncates on its own terms. */}
      <PreviewPath path={previewPath} fullUrl={previewFullUrl} />
      <div className="flex items-center gap-2 shrink-0">
        {hasErrors && (
          <button
            onClick={() => setErrorPanelOpen((prev) => !prev)}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-(--color-error-subtle) text-(--color-error) hover:bg-(--color-bg-hover) transition-colors"
            aria-label="Toggle error panel"
          >
            <span className="inline-flex items-center justify-center min-w-[1.1rem] h-[1.1rem] px-1 text-[10px] font-semibold rounded-full bg-(--color-error) text-(--color-accent-text)">
              {errorCount > 99 ? "99+" : errorCount}
            </span>
            {/* Rides the same stage as Auto-fix, and for the same reason: the
                count pill beside it is red and already says "errors". The pill
                itself never collapses. */}
            <span className="group-data-[hide-autofix=true]/ptb:hidden">
              {errorPanelOpen ? "Hide" : "Errors"}
            </span>
          </button>
        )}
        <label className="flex items-center gap-1 cursor-pointer select-none" title="Auto-fix: automatically send errors to the agent for fixing">
          <input
            type="checkbox"
            checked={autoFixEnabled}
            onChange={onToggleAutoFix}
            // Explicit, because this checkbox otherwise takes its accessible

            aria-label="Auto-fix"
            className="sr-only peer"
          />
          <span className={`relative w-7 h-4 rounded-full transition-colors ${autoFixEnabled ? "bg-(--color-autofix)" : "bg-(--color-border-secondary)"}`}>
            <span className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${autoFixEnabled ? "translate-x-3" : ""}`} />
          </span>
          {/* Goes before the service name: the switch's own colour already
              reports whether auto-fix is on, so the word is the most
              redundant label in the bar. */}
          <span className={`group-data-[hide-autofix=true]/ptb:hidden ${autoFixEnabled ? "text-(--color-autofix)" : ""}`}>
            Auto-fix{autoFixEnabled && autoFixRetries > 0 ? ` (${autoFixRetries}/3)` : ""}
          </span>
        </label>
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          title={canGoBack === false ? "Nothing to go back to in the preview" : "Back"}
          disabled={!activeSlotUrl || canGoBack === false}
          className="h-7 w-7 p-0"
        >
          <ArrowLeftIcon size={ICON_SIZE.SM} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          title="Refresh preview"
          className="h-7 w-7 p-0"
        >
          <ArrowClockwiseIcon size={ICON_SIZE.SM} />
        </Button>
        {openUrl ? (

          <a
            href={openUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="Open preview in new tab"
            aria-label="Open preview in new tab"
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "h-7 w-7 p-0")}
          >
            <ArrowSquareOutIcon size={ICON_SIZE.SM} />
          </a>
        ) : (

          <Button variant="ghost" size="sm" title="Open preview in new tab" disabled className="h-7 w-7 p-0">
            <ArrowSquareOutIcon size={ICON_SIZE.SM} />
          </Button>
        )}
      </div>
    </div>
  );
}
