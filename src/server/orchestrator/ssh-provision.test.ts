import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SSH_AGENT_SOCKET_PATH,
  aliasSshHosts,
  provisionSessionSshFromGrant,
  renderKnownHosts,
  renderSshConfig,
} from "./ssh-provision.js";
import { generateSshHostKey } from "./ssh-hosts.js";
import { fakeEd25519ServerKey } from "./ssh-test-helpers.js";
import type { SshHostPublic } from "../shared/types.js";

function host(id: string, label: string, over: Partial<SshHostPublic> = {}): SshHostPublic {
  const key = generateSshHostKey(`shipit-${label}`);
  return {
    id,
    label,
    address: `${label}.example.com`,
    port: 22,
    user: "deploy",
    publicKeyBlob: key.publicKeyBlob,
    identityLine: key.identityLine,
    authorizedKeysLine: key.authorizedKeysLine,
    fingerprint: key.fingerprint,
    createdAt: "2026-09-14T00:00:00.000Z",
    ...over,
  };
}

let root: string;
let sshDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-provision-"));
  sshDir = path.join(root, "sessions", "sess-1", ".ssh");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function provision(hosts: SshHostPublic[], granted: string[], keys: Record<string, string> = {}): void {
  provisionSessionSshFromGrant(
    {
      credentialsDir: root,
      credentialStore: {
        listSshHosts: () => hosts,
        getSshHostKeyBlob: (id) => keys[id],
      },
      sessionManager: { get: () => ({ sshHosts: granted }) },
    },
    "sess-1",
  );
}

describe("aliasSshHosts", () => {
  it("derives an alias from the label and deduplicates in registry order", () => {
    const entries = aliasSshHosts(
      [host("a", "Prod Web"), host("b", "prod web"), host("c", "  ")],
      new Map(),
    );
    expect(entries.map((e) => e.alias)).toEqual(["prod-web", "prod-web-2", "c"]);
  });
});

describe("renderSshConfig", () => {
  it("points the identity at the agent socket and offers only granted keys", () => {
    const config = renderSshConfig(aliasSshHosts([host("a", "prod")], new Map()));
    expect(config).toContain("Host prod");
    expect(config).toContain("  HostName prod.example.com");
    expect(config).toContain("  User deploy");
    expect(config).toContain(`  IdentityAgent ${SSH_AGENT_SOCKET_PATH}`);
    expect(config).toContain("  IdentityFile ~/.ssh/prod.pub");
    expect(config).toContain("  IdentitiesOnly yes");
    expect(config).toContain("  ForwardAgent no");
  });

  it("says so when nothing is granted, rather than writing an empty file", () => {
    expect(renderSshConfig([])).toContain("No SSH destinations are granted");
  });
});

describe("renderKnownHosts", () => {
  it("writes a line only for a destination whose key has been recorded", () => {
    const key = fakeEd25519ServerKey();
    const entries = aliasSshHosts(
      [host("a", "prod"), host("b", "staging")],
      new Map([["a", key.blob]]),
    );
    const lines = renderKnownHosts(entries).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`prod.example.com ssh-ed25519 ${key.blob}`);
  });
});

describe("provisionSessionSshFromGrant", () => {
  it("writes config, known_hosts and a .pub per granted destination", () => {
    const key = fakeEd25519ServerKey();
    const hosts = [host("a", "prod"), host("b", "staging")];
    provision(hosts, ["a", "b"], { a: key.blob });

    expect(fs.readdirSync(sshDir).sort()).toEqual(["config", "known_hosts", "prod.pub", "staging.pub"]);
    expect(fs.readFileSync(path.join(sshDir, "prod.pub"), "utf8")).toBe(`${hosts[0].identityLine}\n`);
    expect(fs.readFileSync(path.join(sshDir, "known_hosts"), "utf8")).toContain(key.blob);
  });

  // A `.pub` left behind after a grant is removed would keep `ssh <alias>`
  // looking configured, so the rewrite is total rather than a patch.
  it("removes what a previous grant left behind", () => {
    const hosts = [host("a", "prod"), host("b", "staging")];
    provision(hosts, ["a", "b"]);
    expect(fs.existsSync(path.join(sshDir, "staging.pub"))).toBe(true);

    provision(hosts, ["a"]);
    expect(fs.readdirSync(sshDir).sort()).toEqual(["config", "known_hosts", "prod.pub"]);
    expect(fs.readFileSync(path.join(sshDir, "config"), "utf8")).not.toContain("staging");
  });

  it("leaves nothing but config and known_hosts when every grant is revoked", () => {
    provision([host("a", "prod")], ["a"]);
    provision([host("a", "prod")], []);
    expect(fs.readdirSync(sshDir).sort()).toEqual(["config", "known_hosts"]);
    expect(fs.readFileSync(path.join(sshDir, "known_hosts"), "utf8")).toBe("");
  });

  // It runs at every turn, so an unchanged grant must not rewrite anything —
  // a rewrite re-chowns the credentials subtree each time.
  it("touches nothing when the grant has not changed", () => {
    const hosts = [host("a", "prod")];
    provision(hosts, ["a"]);
    const before = Object.fromEntries(
      fs.readdirSync(sshDir).map((f) => [f, fs.statSync(path.join(sshDir, f)).mtimeMs]),
    );
    provision(hosts, ["a"]);
    for (const [file, mtime] of Object.entries(before)) {
      expect(fs.statSync(path.join(sshDir, file)).mtimeMs, file).toBe(mtime);
    }
  });

  /**
   * It runs inside a turn's environment preparation. A throw there would fail
   * the turn over a feature the session may not even use, so every read is
   * inside the guard too — not just the filesystem write.
   */
  it("does not throw when the store cannot answer", () => {
    const broken = {
      credentialsDir: root,
      credentialStore: {
        listSshHosts: () => { throw new Error("store unavailable"); },
        getSshHostKeyBlob: () => undefined,
      },
      sessionManager: { get: () => ({ sshHosts: ["a"] }) },
    };
    expect(() => provisionSessionSshFromGrant(broken, "sess-1")).not.toThrow();
  });

  it("picks up a host key recorded after the grant was made", () => {
    const key = fakeEd25519ServerKey();
    const hosts = [host("a", "prod")];
    provision(hosts, ["a"]);
    expect(fs.readFileSync(path.join(sshDir, "known_hosts"), "utf8")).toBe("");
    provision(hosts, ["a"], { a: key.blob });
    expect(fs.readFileSync(path.join(sshDir, "known_hosts"), "utf8")).toContain(key.blob);
  });

  /**
   * `~/.ssh` is inside the subtree the container mounts, so the agent owns it
   * and can replace any of it with a symlink. Provisioning runs as the
   * orchestrator and both writes AND deletes in there — pointed out of the
   * subtree, its sweep would remove another session's credentials.
   */
  it("refuses to follow a symlink planted where the directory should be", () => {
    const outside = path.join(root, "sessions");
    fs.mkdirSync(path.join(outside, "OTHER-SESSION"), { recursive: true });
    fs.writeFileSync(path.join(outside, "OTHER-SESSION", "token.json"), "another session's token");
    fs.mkdirSync(path.dirname(sshDir), { recursive: true });
    fs.symlinkSync("..", sshDir);

    provision([host("a", "prod")], ["a"]);

    expect(fs.existsSync(path.join(outside, "OTHER-SESSION", "token.json"))).toBe(true);
    expect(fs.lstatSync(sshDir).isSymbolicLink()).toBe(false);
    expect(fs.readdirSync(sshDir).sort()).toEqual(["config", "known_hosts", "prod.pub"]);
  });

  it("refuses to follow a symlink planted at one of the files", () => {
    const decoy = path.join(root, "decoy.txt");
    fs.writeFileSync(decoy, "untouched");
    provision([host("a", "prod")], ["a"]);
    fs.rmSync(path.join(sshDir, "config"));
    fs.symlinkSync(decoy, path.join(sshDir, "config"));

    provision([host("a", "prod"), host("b", "staging")], ["a", "b"]);

    expect(fs.readFileSync(decoy, "utf8")).toBe("untouched");
    expect(fs.readFileSync(path.join(sshDir, "config"), "utf8")).toContain("Host staging");
  });

  /**
   * req 3 — `~/.ssh` is mounted into the session container, so anything written
   * here is readable by the agent. Only public material may land in it.
   */
  it("writes no private key material into the mounted subtree", () => {
    const generated = generateSshHostKey("shipit-prod");
    const only = host("a", "prod", {
      publicKeyBlob: generated.publicKeyBlob,
      identityLine: generated.identityLine,
      authorizedKeysLine: generated.authorizedKeysLine,
      fingerprint: generated.fingerprint,
    });
    provision([only], ["a"]);
    const secretBody = generated.privateKeyPem.replace(/-----[A-Z ]+-----|\s/g, "");
    for (const file of fs.readdirSync(sshDir)) {
      const contents = fs.readFileSync(path.join(sshDir, file), "utf8");
      expect(contents).not.toContain("PRIVATE KEY");
      expect(contents).not.toContain(secretBody);
    }
  });
});
