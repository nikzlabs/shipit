import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { parseKeyscanOutput, scanSshHostKey } from "./ssh-keyscan.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const spawnMock = vi.mocked(spawn);

class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn(() => true);
  exitCode: number | null = null;
  signalCode: string | null = null;
}

function stageChild(): FakeChild {
  const child = new FakeChild();
  spawnMock.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return child;
}

beforeEach(() => {
  spawnMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("parseKeyscanOutput", () => {
  it("keeps the blob of each answer line and drops comments", () => {
    const out = [
      "# prod.example.com:22 SSH-2.0-OpenSSH_9.2p1",
      "prod.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIblob",
      "",
      "[prod.example.com]:2222 ssh-ed25519 AAAAsecondblob",
    ].join("\n");
    expect(parseKeyscanOutput(out)).toEqual([
      "AAAAC3NzaC1lZDI1NTE5AAAAIblob",
      "AAAAsecondblob",
    ]);
  });

  it("yields nothing for output with no key field", () => {
    expect(parseKeyscanOutput("prod.example.com ssh-ed25519\n")).toEqual([]);
    expect(parseKeyscanOutput("")).toEqual([]);
  });
});

describe("scanSshHostKey", () => {
  /**
   * `ssh-keyscan -t` names a key family, not a blob type. OpenSSH 9.x happens
   * to accept `ssh-ed25519` too; older ones answer "Unknown key type" and the
   * destination would never pin.
   */
  it("asks for the address and port it was given, with the family name of the key type", async () => {
    const child = stageChild();
    const pending = scanSshHostKey({ address: "prod.example.com", port: 2222, keyType: "ssh-ed25519" });
    child.stdout.emit("data", Buffer.from("[prod.example.com]:2222 ssh-ed25519 AAAAblob\n"));
    child.emit("close", 0);

    await expect(pending).resolves.toEqual({ keys: ["AAAAblob"] });
    expect(spawnMock).toHaveBeenCalledWith(
      "ssh-keyscan",
      ["-p", "2222", "-T", "5", "-t", "ed25519", "prod.example.com"],
      expect.anything(),
    );
  });

  it.each([
    ["ssh-rsa", "rsa"],
    ["rsa-sha2-512", "rsa"],
    ["ecdsa-sha2-nistp384", "ecdsa"],
  ])("maps %s to the -t family %s", async (blobType, family) => {
    const child = stageChild();
    const pending = scanSshHostKey({ address: "h", port: 22, keyType: blobType });
    child.emit("close", 0);
    await pending;
    expect(spawnMock.mock.calls[0][1]).toContain(family);
  });

  it("refuses to scan for a key type it cannot name, rather than passing it to argv", async () => {
    await expect(scanSshHostKey({ address: "h", port: 22, keyType: "ssh-dss" }))
      .resolves.toEqual({ keys: [], failure: "unsupported-type" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("reports no answer when the scan produces no key", async () => {
    const child = stageChild();
    const pending = scanSshHostKey({ address: "h", port: 22, keyType: "ssh-ed25519" });
    child.stderr.emit("data", Buffer.from("# h:22 Connection refused\n"));
    child.emit("close", 1);
    await expect(pending).resolves.toEqual({ keys: [], failure: "no-answer" });
  });

  // A missing binary — local mode has no openssh-client — lands on `error`.
  it("reports a failure when the binary is not there", async () => {
    const child = stageChild();
    const pending = scanSshHostKey({ address: "h", port: 22, keyType: "ssh-ed25519" });
    child.emit("error", new Error("spawn ssh-keyscan ENOENT"));
    await expect(pending).resolves.toEqual({ keys: [], failure: "scan-failed" });
  });

  it("reports a failure when the spawn throws outright", async () => {
    spawnMock.mockImplementation(() => { throw new Error("EAGAIN"); });
    await expect(scanSshHostKey({ address: "h", port: 22, keyType: "ssh-ed25519" }))
      .resolves.toEqual({ keys: [], failure: "scan-failed" });
  });

  /**
   * `-T 5` bounds one connection attempt, not the process. A hung child would
   * otherwise hold a sign request open for as long as it liked.
   */
  it("kills a hung scan and reports a timeout", async () => {
    vi.useFakeTimers();
    const child = stageChild();
    const pending = scanSshHostKey({ address: "h", port: 22, keyType: "ssh-ed25519" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("close", null);
    await expect(pending).resolves.toEqual({ keys: [], failure: "timeout" });
  });

  /**
   * `killChild`, not `child.kill()`: a spawn that never exec'd has no pid, and
   * `child.kill()` on it signals an arbitrary unrelated process
   * (`shared/kill-child.ts`). The timeout test above cannot see the difference,
   * because its fake always has one.
   */
  it("does not signal a child that never got a pid", async () => {
    vi.useFakeTimers();
    const child = stageChild();
    (child as { pid?: number }).pid = undefined;
    const pending = scanSshHostKey({ address: "h", port: 22, keyType: "ssh-ed25519" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.kill).not.toHaveBeenCalled();
    child.emit("close", null);
    await expect(pending).resolves.toEqual({ keys: [], failure: "timeout" });
  });
});
