import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Runs the sidecar scripts against stubbed tools that record every call, so the
// rule ORDER is visible: an accept placed before a drop is the defect to catch.
// The CI job `egress-sidecar-image` checks the same rules in a real namespace.

const run = promisify(execFile);
const SCRIPTS = path.resolve("docker/egress-sidecar");

interface Stubs {
  dir: string;
  log: string;
}

function makeStubs(): Stubs {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-local-block-"));
  const log = path.join(dir, "calls.log");
  const stub = (name: string, body: string) =>
    fs.writeFileSync(path.join(dir, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  const record = `echo "$(basename "$0") $*" >> "${log}"`;
  stub("iptables", `${record}
case "$*" in
  "-S SHIPIT-LOCAL") printf '%s\\n' "\${STUB_LOCAL_RULES:-}" ;;
  *"-L SHIPIT-"*) [ "\${STUB_CHAIN_EXISTS:-0}" = 1 ] || exit 1 ;;
  *" -C "*|"-C "*|*"-t nat -C"*|*"-t nat -D"*) exit 1 ;;
esac
exit 0`);
  stub("ip6tables", `${record}
[ "\${STUB_IP6_FAIL:-0}" = 1 ] && exit 1
case "$*" in
  *"-L SHIPIT-"*) [ "\${STUB_CHAIN_EXISTS:-0}" = 1 ] || exit 1 ;;
  *" -C "*|"-C "*) exit 1 ;;
esac
exit 0`);
  stub("ipset", `${record}\nexit 0`);
  stub("ip", `${record}
case "$*" in
  "route") echo "default via 172.18.0.1 dev eth0" ;;
esac
exit 0`);
  stub("dig", `${record}
case "$*" in
  *" A nas.example") echo 192.168.1.20 ;;
  *" AAAA nas.example") echo fd7a:115c:a1e0::20 ;;
esac
exit 0`);
  stub("curl", `${record}\nexit 7`);
  // The self-test connects through bash's /dev/tcp inside `timeout`.
  stub("timeout", `${record}
if [ "\${STUB_SELFTEST_LEAKS:-0}" = 1 ]; then echo "connect: Connection timed out"; exit 124; fi
echo "bash: connect: Operation not permitted"; exit 1`);
  return { dir, log };
}

async function runScript(
  stubs: Stubs,
  script: string,
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; calls: string[] }> {
  let code = 0;
  let stdout: string;
  try {
    const result = await run("bash", [path.join(SCRIPTS, script)], {
      env: { PATH: `${stubs.dir}:${process.env.PATH ?? ""}`, ...env },
      timeout: 10_000,
    });
    stdout = result.stdout;
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    code = typeof e.code === "number" ? e.code : 1;
    stdout = e.stdout ?? "";
  }
  const calls = fs.existsSync(stubs.log) ? fs.readFileSync(stubs.log, "utf-8").trim().split("\n") : [];
  return { code, stdout, calls };
}

function indexOf(calls: string[], exact: string): number {
  const i = calls.indexOf(exact);
  if (i < 0) throw new Error(`missing call: ${exact}\n${calls.join("\n")}`);
  return i;
}

let stubs: Stubs;
beforeEach(() => { stubs = makeStubs(); });
afterEach(() => { fs.rmSync(stubs.dir, { recursive: true, force: true }); });

describe("init-firewall.sh — the local block (docs/319 req 4)", () => {
  it("open policy: refuses the host, gateway and private ranges, then accepts the rest, with no ipset", async () => {
    const { code, calls } = await runScript(stubs, "init-firewall.sh", {
      EGRESS_POLICY: "open",
      EGRESS_HOST_ADDRS: "203.0.113.7 2001:db8::7",
      EGRESS_LOCAL_TCP: "172.18.0.2/32:4123",
    });
    expect(code).toBe(0);
    expect(calls.some((c) => c.startsWith("ipset "))).toBe(false);
    // DROP before any flush, so a reinstall never runs without the block.
    expect(indexOf(calls, "iptables -P OUTPUT DROP")).toBeLessThan(indexOf(calls, "iptables -F OUTPUT"));
    const ssh = indexOf(calls, "iptables -A OUTPUT -j SHIPIT-SSH");
    const core = indexOf(calls, "iptables -A OUTPUT -j SHIPIT-CORE");
    const local = indexOf(calls, "iptables -A OUTPUT -j SHIPIT-LOCAL");
    const block = indexOf(calls, "iptables -A OUTPUT -j SHIPIT-BLOCK");
    expect(ssh).toBeLessThan(core);
    expect(core).toBeLessThan(local);
    expect(local).toBeLessThan(block);
    expect(block).toBeLessThan(calls.lastIndexOf("iptables -P OUTPUT ACCEPT"));
    indexOf(calls, "iptables -A SHIPIT-LOCAL -d 203.0.113.7 -j DROP");
    indexOf(calls, "iptables -A SHIPIT-LOCAL -d 172.18.0.1 -j DROP");
    // Only ShipIt's own address on the shared network: every session's agent is on it.
    indexOf(calls, "iptables -A SHIPIT-CORE -d 172.18.0.2/32 -p tcp --dport 4123 -j ACCEPT");
    expect(calls.some((c) => c.includes("-j ACCEPT") && c.includes("172.18.0.0/"))).toBe(false);
    for (const range of ["10.0.0.0/8", "100.64.0.0/10", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16"]) {
      indexOf(calls, `iptables -A SHIPIT-BLOCK -d ${range} -j DROP`);
    }
    for (const range of ["fc00::/7", "fe80::/10"]) indexOf(calls, `ip6tables -A SHIPIT-BLOCK -d ${range} -j DROP`);
    indexOf(calls, "ip6tables -A SHIPIT-LOCAL -d 2001:db8::7 -j DROP");
    expect(calls.lastIndexOf("ip6tables -P OUTPUT ACCEPT")).toBeGreaterThan(indexOf(calls, "ip6tables -A OUTPUT -j SHIPIT-BLOCK"));
  });

  it("contained policy: the allowlist set comes after the block, so a private answer stays refused", async () => {
    const { code, calls } = await runScript(stubs, "init-firewall.sh", { EGRESS_ALLOWED_CIDRS: "140.82.112.0/20" });
    expect(code).toBe(0);
    indexOf(calls, "ipset create shipit-egress-allow4 hash:net family inet");
    const block = indexOf(calls, "iptables -A OUTPUT -j SHIPIT-BLOCK");
    const allow = indexOf(calls, "iptables -A OUTPUT -m set --match-set shipit-egress-allow4 dst -j ACCEPT");
    expect(block).toBeLessThan(allow);
    expect(calls.lastIndexOf("iptables -P OUTPUT DROP")).toBeGreaterThan(allow);
    expect(calls).not.toContain("iptables -P OUTPUT ACCEPT");
  });

  it("opens a granted SSH destination on its port only, before the host and private drops (req 5)", async () => {
    const { code, calls } = await runScript(stubs, "init-firewall.sh", {
      EGRESS_POLICY: "open",
      EGRESS_SSH_TARGETS: "nas.example:2222 10.0.0.5:22 [fd00::5]:22",
    });
    expect(code).toBe(0);
    indexOf(calls, "iptables -A SHIPIT-SSH -d 192.168.1.20 -p tcp --dport 2222 -j ACCEPT");
    indexOf(calls, "iptables -A SHIPIT-SSH -d 10.0.0.5 -p tcp --dport 22 -j ACCEPT");
    indexOf(calls, "ip6tables -A SHIPIT-SSH -d fd7a:115c:a1e0::20 -p tcp --dport 2222 -j ACCEPT");
    indexOf(calls, "ip6tables -A SHIPIT-SSH -d fd00::5 -p tcp --dport 22 -j ACCEPT");
    expect(calls.some((c) => c.startsWith("iptables -A SHIPIT-SSH") && !c.includes("--dport"))).toBe(false);
  });

  // A later network join could give the namespace IPv6, so the kernel decides, not today's addresses.
  it("fails when IPv6 rules fail on a kernel with IPv6", async () => {
    const { code } = await runScript(stubs, "init-firewall.sh", {
      EGRESS_POLICY: "open",
      STUB_IP6_FAIL: "1",
      EGRESS_IPV6_MARKER: stubs.log.replace(/calls\.log$/, "iptables"),
    });
    expect(code).not.toBe(0);
  });

  it("continues without IPv6 rules on a kernel without IPv6", async () => {
    const { code } = await runScript(stubs, "init-firewall.sh", {
      EGRESS_POLICY: "open",
      STUB_IP6_FAIL: "1",
      EGRESS_IPV6_MARKER: "/nonexistent/if_inet6",
    });
    expect(code).toBe(0);
  });

  it("fails its self-test when a blocked address is not refused locally", async () => {
    const { code, stdout } = await runScript(stubs, "init-firewall.sh", {
      EGRESS_POLICY: "open",
      STUB_SELFTEST_LEAKS: "1",
    });
    expect(code).not.toBe(0);
    expect(stdout).toContain("SELF-TEST FAILED");
  });

  it("refuses an unknown policy", async () => {
    const { code } = await runScript(stubs, "init-firewall.sh", { EGRESS_POLICY: "wide" });
    expect(code).not.toBe(0);
  });
});

describe("allow-subnet.sh — later network joins", () => {
  it("puts the gateway drop at the top of SHIPIT-LOCAL and appends the subnet", async () => {
    const { code, calls } = await runScript(stubs, "allow-subnet.sh", {
      STUB_CHAIN_EXISTS: "1",
      EGRESS_ALLOW_SUBNETS: "172.20.0.0/24",
      EGRESS_BLOCK_ADDRS: "172.20.0.1",
    });
    expect(code).toBe(0);
    const drop = indexOf(calls, "iptables -I SHIPIT-LOCAL 1 -d 172.20.0.1 -j DROP");
    const accept = indexOf(calls, "iptables -A SHIPIT-LOCAL -d 172.20.0.0/24 -j ACCEPT");
    expect(drop).toBeLessThan(accept);
    expect(calls.some((c) => c.startsWith("iptables -A OUTPUT"))).toBe(false);
  });

  it("replaces ShipIt's own address when asked, and only that chain", async () => {
    const { code, calls } = await runScript(stubs, "allow-subnet.sh", {
      STUB_CHAIN_EXISTS: "1",
      EGRESS_LOCAL_TCP: "172.18.0.3/32:4123",
    });
    expect(code).toBe(0);
    const flush = indexOf(calls, "iptables -F SHIPIT-CORE");
    expect(indexOf(calls, "iptables -A SHIPIT-CORE -d 172.18.0.3/32 -p tcp --dport 4123 -j ACCEPT")).toBeGreaterThan(flush);
    expect(calls.some((c) => c.includes("-F OUTPUT") || c.includes("SHIPIT-LOCAL"))).toBe(false);
  });

  it("tells the caller to reinstall when a namespace predates ShipIt's own chain", async () => {
    const { code } = await runScript(stubs, "allow-subnet.sh", { EGRESS_LOCAL_TCP: "172.18.0.3/32:4123" });
    expect(code).toBe(3);
  });

  // The service listed at 172.16.44.1 timed out: the drop dated from when that was a host gateway.
  describe("host drops older than the opened subnet", () => {
    const RULES = [
      "-N SHIPIT-LOCAL",
      "-A SHIPIT-LOCAL -m addrtype --dst-type BROADCAST -j DROP",
      "-A SHIPIT-LOCAL -d 203.0.113.7/32 -j DROP",
      "-A SHIPIT-LOCAL -d 172.16.44.1/32 -j DROP",
      "-A SHIPIT-LOCAL -d 172.16.44.9/32 -j DROP",
      "-A SHIPIT-LOCAL -d 172.16.45.1/32 -j DROP",
    ].join("\n");
    const removals = (calls: string[]) => calls.filter((c) => c.startsWith("iptables -D SHIPIT-LOCAL"));

    it("removes a drop inside the subnet for an address the host no longer holds, before the accept", async () => {
      const { code, calls } = await runScript(stubs, "allow-subnet.sh", {
        STUB_CHAIN_EXISTS: "1",
        STUB_LOCAL_RULES: RULES,
        EGRESS_ALLOW_SUBNETS: "172.16.44.0/24",
        EGRESS_HOST_ADDRS: "203.0.113.7 172.16.44.9",
      });
      expect(code).toBe(0);
      // 172.16.44.9 is still the host's; 172.16.45.1 is outside the subnet, where the block refuses it anyway.
      expect(removals(calls)).toEqual(["iptables -D SHIPIT-LOCAL -d 172.16.44.1/32 -j DROP"]);
      expect(indexOf(calls, "iptables -D SHIPIT-LOCAL -d 172.16.44.1/32 -j DROP"))
        .toBeLessThan(indexOf(calls, "iptables -A SHIPIT-LOCAL -d 172.16.44.0/24 -j ACCEPT"));
    });

    it("keeps the drop for the network's own gateway", async () => {
      const { calls } = await runScript(stubs, "allow-subnet.sh", {
        STUB_CHAIN_EXISTS: "1",
        STUB_LOCAL_RULES: RULES,
        EGRESS_ALLOW_SUBNETS: "172.16.44.0/24",
        EGRESS_BLOCK_ADDRS: "172.16.44.1",
        EGRESS_HOST_ADDRS: "203.0.113.7 172.16.44.9",
      });
      expect(removals(calls)).toEqual([]);
    });

    it("removes nothing when the caller did not read the host's addresses", async () => {
      const { code, calls } = await runScript(stubs, "allow-subnet.sh", {
        STUB_CHAIN_EXISTS: "1",
        STUB_LOCAL_RULES: RULES,
        EGRESS_ALLOW_SUBNETS: "172.16.44.0/24",
      });
      expect(code).toBe(0);
      expect(removals(calls)).toEqual([]);
    });
  });

  it("keeps the pre-docs/319 behaviour in a namespace without the chain", async () => {
    const { code, calls } = await runScript(stubs, "allow-subnet.sh", {
      EGRESS_ALLOW_SUBNETS: "172.20.0.0/24",
      EGRESS_BLOCK_ADDRS: "172.20.0.1",
    });
    expect(code).toBe(0);
    indexOf(calls, "iptables -A OUTPUT -d 172.20.0.0/24 -j ACCEPT");
  });
});

describe("probe-firewall.sh (docs/319 req 6)", () => {
  it("passes when the rule types the block uses install", async () => {
    const { code, stdout } = await runScript(stubs, "probe-firewall.sh", {});
    expect(code).toBe(0);
    expect(stdout).toContain("local block supported");
  });
});
