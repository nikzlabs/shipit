import os from "node:os";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

export const EVENT_LOOP_WINDOW_MS = 10_000;
export const EVENT_LOOP_P99_WARN_MS = 200;
// One long stall is a single sample, which p99 over a window of many samples hides.
export const EVENT_LOOP_MAX_WARN_MS = 1_000;

export interface EventLoopLagOptions {
  windowMs?: number;
  p99WarnMs?: number;
  maxWarnMs?: number;
  warn?: (line: string) => void;
}

type LagHistogram = Pick<IntervalHistogram, "percentile" | "max" | "mean">;

/**
 * Lag alone cannot tell a blocked main thread from a CPU-starved host: high
 * `cpu` (this process) points at our own JavaScript, low `cpu` with high `load1` at the host.
 */
export interface LagContext {
  processCpuPercent: number;
  load1: number;
}

const NS_PER_MS = 1e6;

export function lagWarning(
  histogram: LagHistogram,
  windowMs: number,
  context: LagContext,
  p99WarnMs = EVENT_LOOP_P99_WARN_MS,
  maxWarnMs = EVENT_LOOP_MAX_WARN_MS,
): string | null {
  const p99 = histogram.percentile(99) / NS_PER_MS;
  const max = histogram.max / NS_PER_MS;
  if (p99 <= p99WarnMs && max <= maxWarnMs) return null;
  const mean = histogram.mean / NS_PER_MS;
  return `[event-loop] lag over ${Math.round(windowMs / 1000)}s: p99=${Math.round(p99)}ms max=${Math.round(max)}ms mean=${Math.round(mean)}ms`
    + ` cpu=${Math.round(context.processCpuPercent)}% load1=${context.load1.toFixed(1)}/${os.availableParallelism()}`;
}

export function startEventLoopLagMonitor(opts: EventLoopLagOptions = {}): () => void {
  const windowMs = opts.windowMs ?? EVENT_LOOP_WINDOW_MS;
  const warn = opts.warn ?? ((line: string) => console.warn(line));
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let cpuStart = process.cpuUsage();
  let wallStart = performance.now();
  const timer = setInterval(() => {
    const cpu = process.cpuUsage(cpuStart);
    const wallMs = performance.now() - wallStart;
    const processCpuPercent = wallMs > 0 ? ((cpu.user + cpu.system) / 1000 / wallMs) * 100 : 0;
    const line = lagWarning(histogram, windowMs, { processCpuPercent, load1: os.loadavg()[0] }, opts.p99WarnMs, opts.maxWarnMs);
    if (line) warn(line);
    histogram.reset();
    cpuStart = process.cpuUsage();
    wallStart = performance.now();
  }, windowMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}
