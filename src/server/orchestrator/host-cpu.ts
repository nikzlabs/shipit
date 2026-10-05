import os from "node:os";
import type { HostCpuStats } from "../shared/types.js";

export const HOST_CPU_SAMPLE_MS = 10_000;

interface CpuSnapshot {
  busy: number;
  total: number;
  cores: number;
}

function snapshot(cpus: os.CpuInfo[]): CpuSnapshot {
  let busy = 0;
  let total = 0;
  for (const { times } of cpus) {
    const active = times.user + times.nice + times.sys + times.irq;
    busy += active;
    total += active + times.idle;
  }
  return { busy, total, cores: cpus.length };
}

/**
 * Each call reports the load since the previous call, as busy time over total
 * time summed across every core. In a container `os.cpus()` reads the host's
 * `/proc/stat`, so this is the machine and not the orchestrator's own share.
 */
export function createHostCpuSampler(
  readCpus: () => os.CpuInfo[] = () => os.cpus(),
): () => HostCpuStats | null {
  let previous = snapshot(readCpus());
  return () => {
    const current = snapshot(readCpus());
    const busy = current.busy - previous.busy;
    const total = current.total - previous.total;
    const sameCores = current.cores === previous.cores;
    previous = current;
    // A hotplugged core makes the two snapshots sum different sets of counters.
    if (!sameCores || current.cores === 0 || total <= 0) return null;
    return {
      usedPercent: Math.min(100, Math.max(0, (busy / total) * 100)),
      cores: current.cores,
    };
  };
}
