import os from "node:os";
import type Docker from "dockerode";
import { getErrorMessage } from "../shared/utils.js";

/** What `docker run --gpus all` sends; the NVIDIA runtime hook does the rest (docs/325-session-gpu-access). */
export const GPU_DEVICE_REQUEST: Docker.DeviceRequest = { Driver: "", Count: -1, Capabilities: [["gpu"]] };

/**
 * Where WSL2 keeps DirectX and the Windows GPU drivers. Mesa's D3D12 driver needs both to draw with
 * the GPU, and the NVIDIA hook mounts only the CUDA files from them (docs/325-session-gpu-access req 7).
 */
export const WSL_GRAPHICS_DIRS: readonly string[] = ["/usr/lib/wsl/lib", "/usr/lib/wsl/drivers"];

/** Empty off WSL2: Docker creates a bind source that does not exist, so a guess would litter the host. */
export function gpuGraphicsBinds(kernelRelease: string = os.release()): string[] {
  if (!/microsoft|wsl/i.test(kernelRelease)) return [];
  return WSL_GRAPHICS_DIRS.map((dir) => `${dir}:${dir}:ro`);
}

/** What a session's agent container started with; decided once per container. */
export type SessionGpu =
  | { state: "off" }
  | { state: "granted" }
  | { state: "unavailable"; reason: string };

export const GPU_ENV = "SHIPIT_GPU";
export const GPU_REASON_ENV = "SHIPIT_GPU_REASON";

const MAX_REASON_LENGTH = 500;

/** NVIDIA's driver capabilities; anything else would ask another device driver for something. */
const NVIDIA_CAPABILITIES: ReadonlySet<string> = new Set([
  "gpu", "compute", "utility", "graphics", "video", "display", "compat32",
]);

export function gpuReason(err: unknown): string {
  const text = getErrorMessage(err).replace(/\s+/g, " ").trim() || "Docker gave no reason";
  return text.length > MAX_REASON_LENGTH ? `${text.slice(0, MAX_REASON_LENGTH)}…` : text;
}

export function gpuEnv(gpu: SessionGpu): string[] {
  if (gpu.state !== "unavailable") return [`${GPU_ENV}=${gpu.state}`];
  return [`${GPU_ENV}=unavailable`, `${GPU_REASON_ENV}=${gpu.reason}`];
}

/** An adopted container is its own record: the previous process kept the state nowhere else. */
export function gpuFromContainer(
  hostConfig: { DeviceRequests?: unknown } | undefined,
  env: string[] | undefined,
): SessionGpu {
  if (Array.isArray(hostConfig?.DeviceRequests) && hostConfig.DeviceRequests.length > 0) {
    return { state: "granted" };
  }
  const read = (name: string): string | undefined =>
    env?.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (read(GPU_ENV) === "unavailable") return { state: "unavailable", reason: read(GPU_REASON_ENV) ?? "" };
  return { state: "off" };
}

/** Why a container of this session gets no GPU; completes "…, because …". */
export function noGpuWhy(gpu: SessionGpu | undefined): string {
  if (gpu === undefined) return "this session's agent container had not started yet";
  if (gpu.state === "unavailable") {
    return `this session's container could not get the GPU when it started: ${gpu.reason || "no reason given"}`;
  }
  return "GPU access is off for this ShipIt install (Settings → Advanced)";
}

/**
 * Null when a device request asks for an NVIDIA GPU and nothing else. `capabilities` is the Docker
 * API's list of alternatives, each a list that must all hold; a Compose list is one alternative.
 */
export function gpuRequestRefusal(request: {
  driver: unknown;
  capabilities: unknown;
  options: unknown;
  capabilitiesRequired: boolean;
}): string | null {
  const { driver, capabilities, options } = request;
  if (driver !== undefined && driver !== null && driver !== "" && driver !== "nvidia") {
    return `driver \`${typeof driver === "string" ? driver : JSON.stringify(driver)}\` is not allowed; `
      + "leave it unset or use `nvidia`";
  }
  if (options !== undefined && options !== null
    && !(typeof options === "object" && !Array.isArray(options) && Object.keys(options).length === 0)) {
    return "device request `options` are not allowed";
  }
  if (capabilities === undefined || capabilities === null
    || (Array.isArray(capabilities) && capabilities.length === 0)) {
    return request.capabilitiesRequired ? "the request must name the `gpu` capability" : null;
  }
  if (!Array.isArray(capabilities)) return "`capabilities` must be a list";
  for (const set of capabilities) {
    if (!Array.isArray(set) || !set.every((cap): cap is string => typeof cap === "string")) {
      return "`capabilities` must be a list of names";
    }
    const unknown = set.find((cap) => !NVIDIA_CAPABILITIES.has(cap));
    if (unknown !== undefined) return `capability \`${unknown}\` is not an NVIDIA GPU capability`;
    if (!set.includes("gpu")) return "the request must name the `gpu` capability";
  }
  return null;
}
