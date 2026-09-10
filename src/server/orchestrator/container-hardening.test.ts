import { describe, it, expect } from "vitest";
import fs from "node:fs";
import {
  kernelRuntime,
  seccompEnabled,
  resolveSeccompSecurityOpt,
  readonlyRootfsEnabled,
  readonlyRootfsTmpfs,
  readonlyHomeEnv,
  DEFAULT_SECCOMP_PROFILE_PATH,
} from "./container-hardening.js";

describe("kernelRuntime (gVisor opt-in)", () => {
  it("is undefined by default (Docker default runc)", () => {
    expect(kernelRuntime({})).toBeUndefined();
  });

  it("returns the configured runtime name", () => {
    expect(kernelRuntime({ SESSION_RUNTIME: "runsc" })).toBe("runsc");
  });

  it("trims whitespace and treats empty as unset", () => {
    expect(kernelRuntime({ SESSION_RUNTIME: "  runsc  " })).toBe("runsc");
    expect(kernelRuntime({ SESSION_RUNTIME: "   " })).toBeUndefined();
    expect(kernelRuntime({ SESSION_RUNTIME: "" })).toBeUndefined();
  });
});

describe("seccomp resolution", () => {
  it("is off by default → undefined (Docker default profile applies)", () => {
    expect(seccompEnabled({})).toBe(false);
    expect(resolveSeccompSecurityOpt({})).toBeUndefined();
  });

  it("returns a seccomp= SecurityOpt with embedded profile JSON when enabled", () => {
    const opt = resolveSeccompSecurityOpt({ SESSION_SECCOMP: "1" });
    expect(opt).toBeDefined();
    expect(opt!.startsWith("seccomp=")).toBe(true);
    const profile = JSON.parse(opt!.slice("seccomp=".length));
    expect(profile.defaultAction).toBe("SCMP_ACT_ERRNO");
  });

  it("honors a SESSION_SECCOMP_PROFILE path override", () => {
    const opt = resolveSeccompSecurityOpt({
      SESSION_SECCOMP: "1",
      SESSION_SECCOMP_PROFILE: DEFAULT_SECCOMP_PROFILE_PATH,
    });
    expect(opt!.startsWith("seccomp=")).toBe(true);
  });

  it("fails closed when enabled but the profile is unreadable", () => {
    expect(() =>
      resolveSeccompSecurityOpt({
        SESSION_SECCOMP: "1",
        SESSION_SECCOMP_PROFILE: "/nonexistent/seccomp.json",
      }),
    ).toThrow(/unreadable/);
  });
});

describe("committed seccomp profile invariants", () => {
  const profile = JSON.parse(fs.readFileSync(DEFAULT_SECCOMP_PROFILE_PATH, "utf8"));
  const allowed = new Set<string>(
    (profile.syscalls as { names: string[]; action: string }[])
      .filter((s) => s.action === "SCMP_ACT_ALLOW")
      .flatMap((s) => s.names),
  );

  it("is a default-deny allowlist", () => {
    expect(profile.defaultAction).toBe("SCMP_ACT_ERRNO");
    for (const s of profile.syscalls) {
      expect(s.action).toBe("SCMP_ACT_ALLOW");
    }
  });

  it("covers the common architectures", () => {
    const arches = (profile.archMap as { architecture: string }[]).map((a) => a.architecture);
    expect(arches).toContain("SCMP_ARCH_X86_64");
    expect(arches).toContain("SCMP_ARCH_AARCH64");
  });

  it("allows the syscalls node/npm/git/gosu actually need", () => {
    for (const need of [
      "read", "write", "openat", "close", "mmap", "mprotect", "futex",
      "clone", "clone3", "execve", "execveat", "wait4", "exit_group",
      "socket", "connect", "epoll_wait", "arch_prctl",
      "setuid", "setgid", "setgroups", "chown", "fchownat",
      "statx", "newfstatat", "getdents64", "rseq",
    ]) {
      expect(allowed.has(need), `expected ${need} to be allowed`).toBe(true);
    }
  });

  it("denies the high-risk syscalls (tightened beyond Docker's default)", () => {
    for (const denied of [
      "ptrace", "process_vm_readv", "process_vm_writev", "kcmp",
      "userfaultfd", "perf_event_open", "bpf",
      "mount", "umount2", "pivot_root", "unshare", "setns",
      "kexec_load", "init_module", "finit_module", "delete_module",
      "reboot", "swapon", "swapoff",
    ]) {
      expect(allowed.has(denied), `expected ${denied} to be denied`).toBe(false);
    }
  });
});

describe("read-only rootfs", () => {
  it("is off by default", () => {
    expect(readonlyRootfsEnabled({})).toBe(false);
    expect(readonlyHomeEnv({})).toEqual([]);
  });

  it("is enabled by SESSION_READONLY_ROOTFS=1", () => {
    expect(readonlyRootfsEnabled({ SESSION_READONLY_ROOTFS: "1" })).toBe(true);
    expect(readonlyHomeEnv({ SESSION_READONLY_ROOTFS: "1" })).toEqual(["SHIPIT_READONLY_HOME=1"]);
  });

  it("enumerates the minimal writable tmpfs set with /tmp and /home exec", () => {
    const tmpfs = readonlyRootfsTmpfs();
    expect(Object.keys(tmpfs).sort()).toEqual(["/home/shipit", "/plugin-bin", "/plugins", "/run", "/tmp"]);
    expect(tmpfs["/plugin-bin"]).toContain("exec");
    expect(tmpfs["/plugin-bin"]).not.toContain("noexec");
    expect(tmpfs["/tmp"]).toContain("exec");
    expect(tmpfs["/tmp"]).not.toContain("noexec");
    expect(tmpfs["/home/shipit"]).toContain("exec");
    expect(tmpfs["/home/shipit"]).not.toContain("noexec");
    for (const opts of Object.values(tmpfs)) {
      expect(opts).toContain("nosuid");
      expect(opts).toContain("nodev");
    }
  });
});
