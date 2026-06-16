import { useRef, useState, useLayoutEffect, type RefObject } from "react";
import { usePreviewStore } from "../../stores/preview-store.js";

/** Inner padding (px) reserved around the scaled device frame inside the panel. */
const DEVICE_PADDING = 16;

export interface DeviceFrameMetrics {
  /** Attach to the panel that contains the device-framed iframe (measured for scale-to-fit). */
  deviceContainerRef: RefObject<HTMLDivElement | null>;
  /** True when a preset (or custom size) is active and the iframe should be framed/scaled. */
  deviceFrameActive: boolean;
  /** Device viewport width (px), accounting for landscape rotation. */
  deviceWidth: number;
  /** Device viewport height (px), accounting for landscape rotation. */
  deviceHeight: number;
  /** Scale factor (≤ 1) applied so the device fits the panel. */
  deviceScale: number;
  /** `deviceScale` as an integer percentage for the header label. */
  deviceScalePercent: number;
}

/**
 * Computes device-frame metrics for the preview iframe.
 *
 * When a preset is active, the iframe is resized to the preset width/height and
 * scaled down with `transform: scale()` if it doesn't fit the panel. The hook
 * owns the panel ref + a ResizeObserver so scale-to-fit recomputes on resize.
 */
export function useDeviceFrame(): DeviceFrameMetrics {
  const devicePreset = usePreviewStore((s) => s.devicePreset);
  const isLandscape = usePreviewStore((s) => s.isLandscape);
  const customSize = usePreviewStore((s) => s.customSize);

  const deviceContainerRef = useRef<HTMLDivElement | null>(null);
  const [deviceContainerSize, setDeviceContainerSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  // Observe device container size to compute scale-to-fit when a preset is active.
  useLayoutEffect(() => {
    const el = deviceContainerRef.current;
    if (!el) return;
    const update = () => {
      setDeviceContainerSize({ width: el.clientWidth, height: el.clientHeight });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [devicePreset, isLandscape, customSize]);

  // ---- Device frame metrics ----
  // Only applied when a preset (or custom size) is active. Otherwise the iframe fills the panel.
  const activeSize = devicePreset
    ? (devicePreset.category === "custom" && customSize
      ? { width: customSize.width, height: customSize.height }
      : { width: devicePreset.width, height: devicePreset.height })
    : null;
  const deviceWidth = activeSize ? (isLandscape ? activeSize.height : activeSize.width) : 0;
  const deviceHeight = activeSize ? (isLandscape ? activeSize.width : activeSize.height) : 0;
  const deviceScale = (() => {
    if (!activeSize || deviceContainerSize.width === 0 || deviceContainerSize.height === 0) return 1;
    const availableWidth = Math.max(0, deviceContainerSize.width - DEVICE_PADDING * 2);
    const availableHeight = Math.max(0, deviceContainerSize.height - DEVICE_PADDING * 2);
    return Math.min(1, availableWidth / deviceWidth, availableHeight / deviceHeight);
  })();
  const deviceScalePercent = Math.round(deviceScale * 100);
  const deviceFrameActive = !!activeSize;

  return { deviceContainerRef, deviceFrameActive, deviceWidth, deviceHeight, deviceScale, deviceScalePercent };
}
