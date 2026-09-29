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
  "-6 addr show scope global") [ -n "\${STUB_V6_ADDR:-}" ] && echo "inet6 \${STUB_V6_ADDR} scope global" ;;
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
  let stdout = "";
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
      EGRESS_LOCAL_TCP: "172.18.0.0/16:4123",
    });
    expect(code).toBe(0);
    expect(calls.some((c) => c.startsWith("ipset "))).toBe(false);
    // DROP before any flush, so a reinstall never runs without the block.
    expect(indexOf(calls, "iptables -P OUTPUT DROP")).toBeLessThan(indexOf(calls, "iptables -F OUTPUT"));
    const ssh = indexOf(calls, "iptables -A OUTPUT -j SHIPIT-SSH");
    const local = indexOf(calls, "iptables -A OUTPUT -j SHIPIT-LOCAL");
    const block = indexOf(calls, "iptables -A OUTPUT -j SHIPIT-BLOCK");
    expect(ssh).toBeLessThan(local);
    expect(local).toBeLessThan(block);
    expect(block).toBeLessThan(calls.lastIndexOf("iptables -P OUTPUT ACCEPT"));
    const hostDrop = indexOf(calls, "iptables -A SHIPIT-LOCAL -d 203.0.113.7 -j DROP");
    const gwDrop = indexOf(calls, "iptables -A SHIPIT-LOCAL -d 172.18.0.1 -j DROP");
    const orchestrator = indexOf(calls, "iptables -A SHIPIT-LOCAL -d 172.18.0.0/16 -p tcp --dport 4123 -j ACCEPT");
    expect(hostDrop).toBeLessThan(orchestrator);
    expect(gwDrop).toBeLessThan(orchestrator);
    for (const range of ["10.0.0.0/8", "100.64.0.0/10", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16"]) {
      indexOf(calls, `iptables -A SHIPIT-BLOCK -d ${range} -j DROP`);
    }
    for (const range of ["fc00::/7", "fe80::/10"]) indexOf(calls, `ip6tables -A SHIPIT-BLOCK -d ${range} -j DROP`);
    indexOf(calls, "ip6tables -A SHIPIT-LOCAL -d 2001:db8::7 -j DROP");
    expect(calls.lastIndexOf("ip6tables -P OUTPUT ACCEPT")).toBeGreaterThan(indexOf(calls, "ip6tables -A OUTPUT -j SHIPIT-BLOCK"));
    // No whole-subnet accept of the gateway's network: other sessions are on it.
    expect(calls.some((c) => c.includes("172.18.0.0/24"))).toBe(false);
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

  it("fails when IPv6 rules fail and the namespace can send IPv6", async () => {
    const { code } = await runScript(stubs, "init-firewall.sh", {
      EGRESS_POLICY: "open",
      STUB_IP6_FAIL: "1",
      STUB_V6_ADDR: "2001:db8::10/64",
    });
    expect(code).not.toBe(0);
  });

  it("continues without IPv6 rules when the namespace has no routable IPv6", async () => {
    const { code } = await runScript(stubs, "init-firewall.sh", { EGRESS_POLICY: "open", STUB_IP6_FAIL: "1" });
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
