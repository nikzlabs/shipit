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

/** One selectable port row in the port dropdown. */
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
  /** Whether to render the port dropdown vs. a plain port label. */
  showSelector: boolean;
  portSelectorOpen: boolean;
  setPortSelectorOpen: (open: boolean) => void;
  /** Status of the active port, used for the leading status dot. */
  activeStatus: string;
  /** Display label for the active port (e.g. "localhost:5173" or a service name). */
  portLabel: string | null;
  /** All selectable ports for the dropdown. */
  allPorts: PortInfo[];
  activePort: number;
  onSelectPort: (port: number) => void;
  // Device-frame metrics (computed by useDeviceFrame in the parent).
  deviceFrameActive: boolean;
  deviceWidth: number;
  deviceHeight: number;
  deviceScale: number;
  deviceScalePercent: number;
  // Error badge.
  hasErrors: boolean;
  errorCount: number;
  errorPanelOpen: boolean;
  setErrorPanelOpen: (fn: (prev: boolean) => boolean) => void;
  /** Force-reload the active iframe. */
  onRefresh: () => void;
  /** Navigate the embedded preview back one step in its session history. */
  onBack: () => void;
  /** Navigate the embedded preview to its root URL. */
  onHome: () => void;
  /**
   * Whether the preview has a history entry of its own to go back to.
   * `undefined` means the page hasn't told us (no Navigation API) — the button
   * stays enabled and the injected script decides.
   */
  canGoBack?: boolean;
  /** URL of the active iframe slot, or null when none is mounted. */
  activeSlotUrl: string | null;
  /** Path + query of the page the preview is on, or null when unknown. */
  previewPath: string | null;
  /** The same location as an absolute URL, for click-to-copy. */
  previewFullUrl: string | null;
}

/**
 * Top bar of the preview pane: port selector, device viewport controls, the
 * error badge, the auto-fix toggle, and refresh / open-in-new-tab actions.
 *
 * Device-viewport and auto-fix UI state are read directly from `preview-store`
 * (same as before the split); port/error/refresh concerns arrive as props.
 */
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
  const setCustomSize = usePreviewStore((s) => s.setCustomSize);

  // The page the preview is CURRENTLY on, not the slot's entry URL —
  // `activeSlotUrl` is where the iframe was pointed when the slot was created,
  // so a user who had clicked into a sub-route (or an SPA route) was sent back
  // to the front page. Same reasoning as the refresh button. `previewFullUrl`
  // is the injected script's reported location, already origin-checked in
  // PreviewFrame; it's null when the page never reported one, and the entry URL
  // is then the only location we know.
  const openUrl = previewFullUrl ?? activeSlotUrl;

  // Changes whenever the bar's intrinsic width changes without the bar's own
  // width changing — a ResizeObserver alone would not fire for any of these.
  const collapseSignature = [
    isRunning, showSelector, portLabel ?? "", hasErrors, errorPanelOpen, errorCount,
    deviceFrameActive, deviceWidth, deviceHeight, autoFixEnabled, autoFixRetries,
    previewPath ?? "",
  ].join("|");
  const collapseRef = usePreviewToolbarCollapse(collapseSignature);

  return (
    // `group/ptb` + the data flags the collapse hook writes. Labels below hide
    // off those flags; the groups stay `shrink-0` so the row genuinely
    // overflows and the hook has something real to measure — giving the labels
    // `truncate` instead would let them absorb the pressure silently and the
    // address, which outranks them, would be squeezed in their place.
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
                // Carries the service name once the collapse hides the label.
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
            <StatusDot status={isRunning || portLabel ? "success" : "info"} />
            {portLabel ? portLabel : <span className="text-(--color-text-tertiary)">Preview</span>}
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
              onSelectPreset={(preset) => {
                setDevicePreset(preset);
                if (!preset) setCustomSize(null);
              }}
              onToggleLandscape={toggleLandscape}
              onCustomSize={(width, height) => {
                setCustomSize({ width, height });
                setDevicePreset({
                  id: "custom",
                  label: `${width}×${height}`,
                  width,
                  height,
                  category: "custom",
                });
              }}
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
            <span>{errorPanelOpen ? "Hide" : "Errors"}</span>
          </button>
        )}
        <label className="flex items-center gap-1 cursor-pointer select-none" title="Auto-fix: automatically send errors to the agent for fixing">
          <input
            type="checkbox"
            checked={autoFixEnabled}
            onChange={onToggleAutoFix}
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
          // A real anchor, not a `<button>` calling `window.open`. Nothing on
          // the web can choose which surface a link opens in — an installed PWA
          // hands `_blank` to its own in-app browser (iOS since 16.4, Android
          // Custom Tabs) and no API overrides that. What a genuine link DOES
          // buy is the platform's native affordances on top of it: long-press →
          // "Open in Safari/Chrome", the share sheet, and on desktop the
          // cmd/ctrl/middle-click that a scripted open silently swallows. So
          // the user can route it to their real browser even though we can't.
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
          // No URL to link to — an anchor without an href is not a control, so
          // fall back to the disabled button for the same affordance and look.
          <Button variant="ghost" size="sm" title="Open preview in new tab" disabled className="h-7 w-7 p-0">
            <ArrowSquareOutIcon size={ICON_SIZE.SM} />
          </Button>
        )}
      </div>
    </div>
  );
}
