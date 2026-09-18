import { useRef, useState, useLayoutEffect, type RefObject } from "react";
import { usePreviewStore } from "../../stores/preview-store.js";

const DEVICE_PADDING = 16;

export interface DeviceFrameMetrics {

  deviceContainerRef: RefObject<HTMLDivElement | null>;

  deviceFrameActive: boolean;

  deviceWidth: number;

  deviceHeight: number;

  deviceScale: number;

  deviceScalePercent: number;

  availableWidth: number;
  availableHeight: number;
}

export function useDeviceFrame(): DeviceFrameMetrics {
  const devicePreset = usePreviewStore((s) => s.devicePreset);
  const isLandscape = usePreviewStore((s) => s.isLandscape);
  const customSize = usePreviewStore((s) => s.customSize);

  const deviceContainerRef = useRef<HTMLDivElement | null>(null);
  const [deviceContainerSize, setDeviceContainerSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

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

  const activeSize = devicePreset
    ? (devicePreset.category === "custom" && customSize
      ? { width: customSize.width, height: customSize.height }
      : { width: devicePreset.width, height: devicePreset.height })
    : null;
  const deviceWidth = activeSize ? (isLandscape ? activeSize.height : activeSize.width) : 0;
  const deviceHeight = activeSize ? (isLandscape ? activeSize.width : activeSize.height) : 0;
  const availableWidth = Math.max(0, deviceContainerSize.width - DEVICE_PADDING * 2);
  const availableHeight = Math.max(0, deviceContainerSize.height - DEVICE_PADDING * 2);
  const deviceScale = (() => {
    if (!activeSize || deviceContainerSize.width === 0 || deviceContainerSize.height === 0) return 1;
    return Math.min(1, availableWidth / deviceWidth, availableHeight / deviceHeight);
  })();
  const deviceScalePercent = Math.round(deviceScale * 100);
  const deviceFrameActive = !!activeSize;

  return {
    deviceContainerRef,
    deviceFrameActive,
    deviceWidth,
    deviceHeight,
    deviceScale,
    deviceScalePercent,
    availableWidth,
    availableHeight,
  };
}
