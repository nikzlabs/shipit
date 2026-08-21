import { useRef, useState, useLayoutEffect, type RefObject } from "react";
import { usePreviewStore } from "../../stores/preview-store.js";
import type { DevicePreset } from "../device-presets.js";

/** Inner padding (px) reserved around the scaled device frame inside the panel. */
export const DEVICE_PADDING = 16;

export interface DeviceViewportInput {
  devicePreset: DevicePreset | null;
  isLandscape: boolean;
  customSize: { width: number; height: number } | null;
  containerWidth: number;
  containerHeight: number;
}

export interface DeviceViewportMetrics {
  /** True when a preset (or custom size) is active and the iframe should be framed/scaled. */
  frameActive: boolean;
  /** Device viewport width (px), accounting for landscape rotation. */
  width: number;
  /** Device viewport height (px), accounting for landscape rotation. */
  height: number;
  /** Scale factor (≤ 1) applied so the device fits the panel. */
  scale: number;
  /** `scale` as an integer percentage for the header label. */
  scalePercent: number;
}

/**
 * Pure viewport resolution for the device-framed preview iframe.
 *
 * "Active" means a preset (or a stored custom size) is selected; otherwise the
 * iframe fills the panel and the metrics say so (`frameActive: false`). The
 * active size is rotated first (landscape swaps width and height — this applies
 * to custom sizes too, not just named presets), then scaled down — never up —
 * to fit the container, leaving {@link DEVICE_PADDING} on every side.
 */
export function resolveDeviceViewport(input: DeviceViewportInput): DeviceViewportMetrics {
  const { devicePreset, isLandscape, customSize, containerWidth, containerHeight } = input;
  const activeSize = devicePreset
    ? (devicePreset.category === "custom" && customSize
      ? { width: customSize.width, height: customSize.height }
      : { width: devicePreset.width, height: devicePreset.height })
    : null;
  if (!activeSize) {
    return { frameActive: false, width: 0, height: 0, scale: 1, scalePercent: 100 };
  }
  const width = isLandscape ? activeSize.height : activeSize.width;
  const height = isLandscape ? activeSize.width : activeSize.height;
  // No measured container yet (first layout, or jsdom) — leave the frame at
  // its natural scale until the ResizeObserver supplies real numbers.
  if (containerWidth === 0 || containerHeight === 0) {
    return { frameActive: true, width, height, scale: 1, scalePercent: 100 };
  }
  const availableWidth = Math.max(0, containerWidth - DEVICE_PADDING * 2);
  const availableHeight = Math.max(0, containerHeight - DEVICE_PADDING * 2);
  const scale = Math.min(1, availableWidth / width, availableHeight / height);
  return { frameActive: true, width, height, scale, scalePercent: Math.round(scale * 100) };
}

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
 * owns the panel ref + a ResizeObserver so scale-to-fit recomputes on resize;
 * the metric math itself lives in {@link resolveDeviceViewport}.
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

  const metrics = resolveDeviceViewport({
    devicePreset,
    isLandscape,
    customSize,
    containerWidth: deviceContainerSize.width,
    containerHeight: deviceContainerSize.height,
  });

  return {
    deviceContainerRef,
    deviceFrameActive: metrics.frameActive,
    deviceWidth: metrics.width,
    deviceHeight: metrics.height,
    deviceScale: metrics.scale,
    deviceScalePercent: metrics.scalePercent,
  };
}