import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  _resetSshRateLimits,
  _resetSshScanState,
  listSshIdentities,
  signSshRequest,
  type SshServiceDeps,
  type SshSignRequest,
} from "./ssh.js";
import { ServiceError } from "./types.js";
import { generateSshHostKey, fingerprintOf } from "../ssh-hosts.js";
import type { SshHostKeyScanResult, SshHostKeyScanTarget } from "../ssh-keyscan.js";
import {
  buildSessionBind,
  buildUserauthData,
  fakeEd25519ServerKey,
  fakeRsaServerKey,
  type FakeServerKey,
} from "../ssh-test-helpers.js";
import type { SshHostPublic } from "../../shared/types.js";
import type { PersistedMessage } from "../chat-history.js";

const SESSION = "sess-1";
const SSH_SESSION_ID = Buffer.from("kex-exchange-hash");

interface Harness {
  deps: SshServiceDeps;
  host: SshHostPublic;
  privateKeyPem: string;
  server: FakeServerKey;
  appended: PersistedMessage[];
  recorded: () => string | undefined;
  /** One entry per `ssh-keyscan` the signer asked for (req 13). */
  scans: SshHostKeyScanTarget[];
  /** Edit the destination the way the Settings routes would, mid-flight. */
  editHost: (patch: Partial<SshHostPublic>) => void;
  deleteHost: () => void;
  setGranted: (ids: string[]) => void;
}

interface HarnessOpts {
  granted?: boolean;
  pinTo?: FakeServerKey;
  /**
   * What the address answers when the orchestrator scans it. The default is the
   * harness's own fake server, i.e. the honest case.
   */
  scan?: SshHostKeyScanResult | ((target: SshHostKeyScanTarget) => Promise<SshHostKeyScanResult>);
}

function harness(opts: HarnessOpts = {}): Harness {
  const generated = generateSshHostKey("shipit-prod");
  const server = fakeEd25519ServerKey();
  let hostKeyBlob: string | undefined = opts.pinTo?.blob;

  const host: SshHostPublic = {
    id: "ssh_1",
    label: "prod",
    address: "prod.example.com",
    port: 22,
    user: "deploy",
    publicKeyBlob: generated.publicKeyBlob,
    identityLine: generated.identityLine,
    authorizedKeysLine: generated.authorizedKeysLine,
    fingerprint: generated.fingerprint,
    createdAt: "2026-09-14T00:00:00.000Z",
  };
  const appended: PersistedMessage[] = [];
  const scans: SshHostKeyScanTarget[] = [];
  // The registry the signer reads, mutable so a test can edit a destination
  // while a scan is in flight — which is the only way to reach the re-read.
  let live: SshHostPublic | undefined = { ...host };
  let granted = opts.granted === false ? [] : [host.id];

  const deps: SshServiceDeps = {
    credentialStore: {
      listSshHosts: () => (live
        ? [{
            ...live,
            ...(hostKeyBlob ? { hostKeyFingerprint: fingerprintOf(hostKeyBlob), hostKeyType: "ssh-ed25519" } : {}),
          }]
        : []),
      getSshHostSigningKey: (id) =>
        id === live?.id
          ? { privateKeyPem: generated.privateKeyPem, ...(hostKeyBlob ? { hostKeyBlob } : {}) }
          : undefined,
      recordSshHostKey: (id, blob) => {
        if (id !== live?.id || hostKeyBlob) return undefined;
        hostKeyBlob = blob;
        return live;
      },
    },
    sessionManager: {
      get: (id) => (id === SESSION
        ? {
            id: SESSION,
            title: "test",
            createdAt: "2026-09-14T00:00:00.000Z",
            lastUsedAt: "2026-09-14T00:00:00.000Z",
            remoteUrl: "",
            sshHosts: granted,
          }
        : undefined),
    },
    chatHistoryManager: {
      append: (_sessionId, message) => { appended.push(message); return appended.length; },
      replaceInProgress: () => undefined,
      hasInProgress: () => false,
    },
    scanHostKey: async (target) => {
      scans.push(target);
      if (typeof opts.scan === "function") return opts.scan(target);
      return opts.scan ?? { keys: [server.blob] };
    },
  };

  return {
    deps,
    host,
    privateKeyPem: generated.privateKeyPem,
    server,
    appended,
    recorded: () => hostKeyBlob,
    scans,
    editHost: (patch) => { if (live) live = { ...live, ...patch }; },
    deleteHost: () => { live = undefined; },
    setGranted: (ids) => { granted = ids; },
  };
}

function validRequest(h: Harness, server?: FakeServerKey): SshSignRequest {
  const key = server ?? h.server;
  return {
    keyBlob: h.host.publicKeyBlob,
    data: buildUserauthData({
      sessionId: SSH_SESSION_ID,
      user: h.host.user,
      publicKeyBlob: h.host.publicKeyBlob,
    }),
    bind: buildSessionBind(key, SSH_SESSION_ID),
  };
}

async function refusalOf(pending: Promise<unknown>): Promise<ServiceError> {
  try {
    await pending;
  } catch (err) {
    if (err instanceof ServiceError) return err;
    throw err;
  }
  throw new Error("expected a refusal, but the signer signed");
}

beforeEach(() => {
  _resetSshRateLimits();
  _resetSshScanState();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listSshIdentities", () => {
  it("answers only the destinations this session is granted", () => {
    const h = harness();
    expect(listSshIdentities(h.deps, SESSION)).toEqual([
      { publicKeyBlob: h.host.publicKeyBlob, comment: "prod (deploy@prod.example.com)" },
    ]);
    expect(listSshIdentities(harness({ granted: false }).deps, SESSION)).toEqual([]);
    expect(listSshIdentities(h.deps, "other-session")).toEqual([]);
  });
});

describe("the signer contract", () => {
  it("signs a complete, bound, correctly-shaped request", async () => {
    const h = harness();
    const { signature } = await signSshRequest(h.deps, SESSION, validRequest(h));
    expect(Buffer.from(signature, "base64").length).toBeGreaterThan(0);
  });

  // Rule 1 — the grant gate.
  it("refuses a key the session is not granted", async () => {
    const h = harness({ granted: false });
    expect((await refusalOf(signSshRequest(h.deps, SESSION, validRequest(h)))).statusCode).toBe(403);
  });

  it("refuses a key blob that is not this destination's", async () => {
    const h = harness();
    const stranger = generateSshHostKey("someone-else");
    await expect(
      signSshRequest(h.deps, SESSION, { ...validRequest(h), keyBlob: stranger.publicKeyBlob }),
    ).rejects.toThrow(/not granted an SSH destination/);
  });

  // Rule 2 — a real key exchange, not a forwarded agent.
  it("refuses when no session binding is present", async () => {
    const h = harness();
    const { bind: _omitted, ...unbound } = validRequest(h);
    await expect(signSshRequest(h.deps, SESSION, unbound))
      .rejects.toThrow(/bound to its server's host key/);
  });

  it("refuses a forwarded agent connection", async () => {
    const h = harness();
    const request = {
      ...validRequest(h),
      bind: buildSessionBind(h.server, SSH_SESSION_ID, { isForwarding: true }),
    };
    await expect(signSshRequest(h.deps, SESSION, request)).rejects.toThrow(/forwarded agent/);
  });

  it("refuses a binding whose host-key signature does not verify", async () => {
    const h = harness();
    const impostor = fakeEd25519ServerKey();
    const request = {
      ...validRequest(h),
      // The blob claims one server; the signature is another's. Only the real
      // host private key can produce this pair, which is what a relay lacks.
      bind: buildSessionBind(h.server, SSH_SESSION_ID, { signature: impostor.sign(SSH_SESSION_ID) }),
    };
    await expect(signSshRequest(h.deps, SESSION, request)).rejects.toThrow(/did not verify/);
  });

  it("refuses a malformed binding", async () => {
    const h = harness();
    await expect(signSshRequest(h.deps, SESSION, { ...validRequest(h), bind: "Zm9v" }))
      .rejects.toThrow(/well-formed session-bind/);
  });

  // Rule 3 — the orchestrator's own scan decides the first recording, then pinned.
  it("records the host key the address itself answers with, and shows its fingerprint", async () => {
    const h = harness();
    expect(h.recorded()).toBeUndefined();
    await signSshRequest(h.deps, SESSION, validRequest(h));
    expect(h.recorded()).toBe(h.server.blob);
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0].sshHostKey).toMatchObject({
      kind: "recorded",
      hostId: "ssh_1",
      fingerprint: fingerprintOf(h.server.blob),
      keyType: "ssh-ed25519",
    });
  });

  /**
   * The pin is account-wide and permanent, so a request that is about to be
   * refused must not be able to set it. Otherwise a granted session mints its
   * own "server" key, posts that bind with junk to sign, and every later
   * legitimate connection from every granted session fails against its pin.
   */
  it("does not record a pin from a request it refuses", async () => {
    const h = harness();
    const attacker = fakeEd25519ServerKey();
    await expect(signSshRequest(h.deps, SESSION, {
      keyBlob: h.host.publicKeyBlob,
      data: Buffer.from("not a userauth request at all").toString("base64"),
      bind: buildSessionBind(attacker, SSH_SESSION_ID),
    })).rejects.toThrow();

    expect(h.recorded()).toBeUndefined();
    expect(h.appended).toEqual([]);
    // A request refused before the recording step costs no scan at all.
    expect(h.scans).toEqual([]);
    // The real server's first connection still gets to set it.
    await signSshRequest(h.deps, SESSION, validRequest(h));
    expect(h.recorded()).toBe(h.server.blob);
  });

  it("refuses a host key that differs from the recorded one, with a warning card", async () => {
    const h = harness();
    await signSshRequest(h.deps, SESSION, validRequest(h));
    h.appended.length = 0;

    const rebuilt = fakeEd25519ServerKey();
    await expect(signSshRequest(h.deps, SESSION, validRequest(h, rebuilt)))
      .rejects.toThrow(/does not match the one ShipIt recorded/);
    expect(h.appended[0].sshHostKey).toMatchObject({
      kind: "mismatch",
      fingerprint: fingerprintOf(rebuilt.blob),
      recordedFingerprint: fingerprintOf(h.server.blob),
    });
    // The pin does not move on a mismatch; the original key still authenticates.
    expect(h.recorded()).toBe(h.server.blob);
    await expect(signSshRequest(h.deps, SESSION, validRequest(h))).resolves.toBeDefined();
  });

  /**
   * OpenSSH 8.9+ prefers `publickey-hostbound-v00@openssh.com` whenever the
   * server advertises it, which every sshd of that vintage does — so this, not
   * plain `publickey`, is what a real connection sends.
   */
  it("signs the host-bound form a modern OpenSSH client actually sends", async () => {
    const h = harness();
    const request = {
      ...validRequest(h),
      data: buildUserauthData({
        sessionId: SSH_SESSION_ID,
        user: h.host.user,
        publicKeyBlob: h.host.publicKeyBlob,
        serverHostKeyBlob: h.server.blob,
      }),
    };
    await expect(signSshRequest(h.deps, SESSION, request)).resolves.toBeDefined();
  });

  it("refuses a host-bound request naming a server other than the bound one", async () => {
    const h = harness();
    const request = {
      ...validRequest(h),
      data: buildUserauthData({
        sessionId: SSH_SESSION_ID,
        user: h.host.user,
        publicKeyBlob: h.host.publicKeyBlob,
        serverHostKeyBlob: fakeEd25519ServerKey().blob,
      }),
    };
    await expect(signSshRequest(h.deps, SESSION, request)).rejects.toThrow(/different server/);
  });

  // An unchecked field is free space inside what we sign, and the destination's
  // key is always ed25519 so no other name can be a valid request for it.
  it("refuses an arbitrary algorithm field", async () => {
    const h = harness();
    const request = {
      ...validRequest(h),
      data: buildUserauthData({
        sessionId: SSH_SESSION_ID,
        user: h.host.user,
        publicKeyBlob: h.host.publicKeyBlob,
        algorithm: "not-an-ssh-algorithm arbitrary-attacker-content",
      }),
    };
    await expect(signSshRequest(h.deps, SESSION, request)).rejects.toThrow(/only ssh-ed25519/);
  });

  // Rule 4 — userauth only, this connection, this user.
  it("refuses data that is not a userauth publickey request", async () => {
    const h = harness();
    const request = {
      ...validRequest(h),
      data: Buffer.from("sign this arbitrary challenge").toString("base64"),
    };
    await expect(signSshRequest(h.deps, SESSION, request)).rejects.toThrow(/only an SSH publickey/);
  });

  it("refuses a userauth request for a different service or method", async () => {
    const h = harness();
    for (const override of [{ service: "ssh-userauth" }, { method: "password" }]) {
      const request = {
        ...validRequest(h),
        data: buildUserauthData({
          sessionId: SSH_SESSION_ID,
          user: h.host.user,
          publicKeyBlob: h.host.publicKeyBlob,
          ...override,
        }),
      };
      await expect(signSshRequest(h.deps, SESSION, request)).rejects.toThrow(/only an SSH publickey/);
    }
  });

  it("refuses a request that advertises a different public key", async () => {
    const h = harness();
    const stranger = generateSshHostKey("someone-else");
    const request = {
      ...validRequest(h),
      data: buildUserauthData({
        sessionId: SSH_SESSION_ID,
        user: h.host.user,
        publicKeyBlob: stranger.publicKeyBlob,
      }),
    };
    await expect(signSshRequest(h.deps, SESSION, request)).rejects.toThrow(/only an SSH publickey/);
  });

  it("refuses a request belonging to a different SSH connection", async () => {
    const h = harness();
    const request = {
      ...validRequest(h),
      data: buildUserauthData({
        sessionId: Buffer.from("a different connection's exchange hash"),
        user: h.host.user,
        publicKeyBlob: h.host.publicKeyBlob,
      }),
    };
    await expect(signSshRequest(h.deps, SESSION, request)).rejects.toThrow(/different SSH connection/);
  });

  it("refuses a request that authenticates as another user", async () => {
    const h = harness();
    const request = {
      ...validRequest(h),
      data: buildUserauthData({
        sessionId: SSH_SESSION_ID,
        user: "root",
        publicKeyBlob: h.host.publicKeyBlob,
      }),
    };
    await expect(signSshRequest(h.deps, SESSION, request))
      .rejects.toThrow(/authenticates as deploy, not root/);
  });

  // Rule 5 — the per-session bound.
  it("refuses once the per-session attempt rate is exceeded", async () => {
    const h = harness();
    const request = validRequest(h);
    for (let i = 0; i < 60; i++) await signSshRequest(h.deps, SESSION, request);
    await expect(signSshRequest(h.deps, SESSION, request))
      .rejects.toThrow(/Too many SSH authentication/);
  });

  /**
   * The slot has to be taken BEFORE the scan suspends, not after it returns:
   * the scan is what a flood would otherwise queue behind, and a bound that
   * only counts completed attempts holds none of them back.
   */
  it("bounds requests that are all still waiting on a scan", async () => {
    const h = harness();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    h.deps.scanHostKey = async () => { await gate; return { keys: [h.server.blob] }; };

    const inFlight = Array.from({ length: 60 }, () =>
      signSshRequest(h.deps, SESSION, validRequest(h)).catch(() => undefined));
    await expect(signSshRequest(h.deps, SESSION, validRequest(h)))
      .rejects.toThrow(/Too many SSH authentication/);

    release?.();
    await Promise.all(inFlight);
  });

  it("lets the rate window pass", async () => {
    const h = harness();
    const request = validRequest(h);
    let now = 1_000_000;
    const timed: SshServiceDeps = { ...h.deps, now: () => now };
    for (let i = 0; i < 60; i++) await signSshRequest(timed, SESSION, request);
    await expect(signSshRequest(timed, SESSION, request)).rejects.toThrow(/Too many SSH authentication/);
    now += 61_000;
    await expect(signSshRequest(timed, SESSION, request)).resolves.toBeDefined();
  });
});

/**
 * req 13 — a `session-bind` proves a key exchange with whoever holds the
 * supplied host key, NOT that the key is what answers at the configured
 * address. Without this gate a granted session mints its own server key and
 * pins it as the destination's. So the orchestrator scans the address itself
 * and records only an exact blob match.
 */
describe("the first-use scan (req 13)", () => {
  it("scans the registry's address and port, never anything the session supplied", async () => {
    const h = harness();
    await signSshRequest(h.deps, SESSION, validRequest(h));
    expect(h.scans).toEqual([
      { address: "prod.example.com", port: 22, keyType: "ssh-ed25519" },
    ]);
  });

  it("refuses and records nothing when the address answers with a different key", async () => {
    const impostor = fakeEd25519ServerKey();
    // The address answers with the real server's key; the session presents its own.
    const h = harness({ scan: { keys: [fakeEd25519ServerKey().blob] } });
    const refusal = await refusalOf(
      signSshRequest(h.deps, SESSION, validRequest(h, impostor)),
    );
    expect(refusal.message).toMatch(/could not observe that host key at prod\.example\.com:22/);
    expect(h.recorded()).toBeUndefined();
    expect(h.scans).toHaveLength(1);
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0].sshHostKey).toMatchObject({
      kind: "unverified",
      fingerprint: fingerprintOf(impostor.blob),
      keyType: "ssh-ed25519",
    });
    // The card names what the scan saw, so a wrong address is visible without logs.
    expect(h.appended[0].sshHostKey?.scannedFingerprint).toBeTruthy();
    expect(h.appended[0].sshHostKey?.scannedFingerprint)
      .not.toBe(h.appended[0].sshHostKey?.fingerprint);
  });

  it("refuses and records nothing when nothing answers at the address", async () => {
    const h = harness({ scan: { keys: [], failure: "no-answer" } });
    await expect(signSshRequest(h.deps, SESSION, validRequest(h)))
      .rejects.toThrow(/could not observe that host key/);
    expect(h.recorded()).toBeUndefined();
    expect(h.appended[0].sshHostKey).toMatchObject({
      kind: "unverified",
      scanFailure: "no-answer",
    });
    expect(h.appended[0].sshHostKey?.scannedFingerprint).toBeUndefined();
  });

  it("refuses and records nothing when the scan times out", async () => {
    const h = harness({ scan: { keys: [], failure: "timeout" } });
    await expect(signSshRequest(h.deps, SESSION, validRequest(h)))
      .rejects.toThrow(/could not observe that host key/);
    expect(h.recorded()).toBeUndefined();
    expect(h.appended[0].sshHostKey).toMatchObject({ kind: "unverified", scanFailure: "timeout" });
  });

  // Local mode has no `ssh-keyscan`; a scanner that throws must not sign.
  it("refuses and records nothing when the scan cannot run at all", async () => {
    const h = harness({ scan: () => Promise.reject(new Error("spawn ENOENT")) });
    await expect(signSshRequest(h.deps, SESSION, validRequest(h)))
      .rejects.toThrow(/could not observe that host key/);
    expect(h.recorded()).toBeUndefined();
    expect(h.appended[0].sshHostKey).toMatchObject({ kind: "unverified", scanFailure: "scan-failed" });
  });

  /**
   * The scan exists to decide the FIRST recording. Running it again per
   * connection would be a process per `ssh`, and would let an unreachable
   * moment break a destination that is already pinned.
   */
  it("never scans once a key is recorded", async () => {
    const pinned = fakeEd25519ServerKey();
    const h = harness({ pinTo: pinned });
    await signSshRequest(h.deps, SESSION, validRequest(h, pinned));
    await signSshRequest(h.deps, SESSION, validRequest(h, pinned));
    expect(h.scans).toEqual([]);

    // And the same harness DOES scan when nothing is recorded — otherwise the
    // assertion above would pass for a fake that simply never records a scan.
    const fresh = harness();
    await signSshRequest(fresh.deps, SESSION, validRequest(fresh));
    expect(fresh.scans).toHaveLength(1);
  });

  /**
   * A scan asks for ONE key family, so two connections that negotiated
   * different host-key algorithms cannot share an answer: the second would be
   * compared against keys of the wrong family and refused for no reason.
   */
  it("does not share one scan between connections that bound different key types", async () => {
    const ed = fakeEd25519ServerKey();
    const rsa = fakeRsaServerKey("rsa-sha2-512");
    const h = harness({
      scan: (target) => Promise.resolve({
        keys: [target.keyType === "ssh-rsa" ? rsa.blob : ed.blob],
      }),
    });

    const first = signSshRequest(h.deps, SESSION, validRequest(h, ed));
    const second = signSshRequest(h.deps, SESSION, validRequest(h, rsa));
    await first;
    const refusal = await refusalOf(second);

    expect(h.scans.map((s) => s.keyType).sort()).toEqual(["ssh-ed25519", "ssh-rsa"]);
    // The address really does answer with that RSA key; what refuses the second
    // request is the pin the first one set, not a scan of the wrong family.
    expect(refusal.message).toMatch(/does not match the one ShipIt recorded/);
    expect(h.recorded()).toBe(ed.blob);
  });

  /**
   * The scan is the only step that suspends, and every rule before it read
   * state the user can change while it waits. A key observed at the OLD
   * endpoint says nothing about the new one, so it must not be pinned against
   * it — and the same goes for a grant revoked or a user changed mid-flight.
   */
  describe("state edited while the scan is in flight", () => {
    /** Fires a first-use request and hands back a release for its scan. */
    function gated(h: Harness, request = validRequest(h)) {
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      h.deps.scanHostKey = async (target) => {
        h.scans.push(target);
        await gate;
        return { keys: [h.server.blob] };
      };
      const pending = signSshRequest(h.deps, SESSION, request);
      return { pending, release: () => release?.() };
    }

    it("refuses when the destination's address changed, and pins nothing", async () => {
      const h = harness();
      const { pending, release } = gated(h);
      h.editHost({ address: "someone-elses.example.com" });
      release();

      expect((await refusalOf(pending)).message).toMatch(/address changed while ShipIt was verifying/);
      expect(h.recorded()).toBeUndefined();
    });

    it("refuses when only the port changed, and pins nothing", async () => {
      const h = harness();
      const { pending, release } = gated(h);
      h.editHost({ port: 2222 });
      release();

      expect((await refusalOf(pending)).message).toMatch(/address changed while ShipIt was verifying/);
      expect(h.recorded()).toBeUndefined();
    });

    // A scan is an answer about one endpoint. A request that starts AFTER the
    // edit must not be handed the answer about the endpoint before it.
    it("does not hand a request started after an edit the old endpoint's scan", async () => {
      const h = harness();
      const { pending, release } = gated(h);
      h.editHost({ address: "moved.example.com" });
      const second = signSshRequest(h.deps, SESSION, validRequest(h));
      release();

      await refusalOf(pending);
      await refusalOf(second).catch(() => undefined);
      expect(h.scans.map((s) => s.address)).toEqual(["prod.example.com", "moved.example.com"]);
    });

    it("refuses when the grant was revoked, and pins nothing", async () => {
      const h = harness();
      const { pending, release } = gated(h);
      h.setGranted([]);
      release();

      expect((await refusalOf(pending)).message).toMatch(/no longer granted to this session/);
      expect(h.recorded()).toBeUndefined();
    });

    it("refuses when the destination was deleted, and pins nothing", async () => {
      const h = harness();
      const { pending, release } = gated(h);
      h.deleteHost();
      release();

      expect((await refusalOf(pending)).message).toMatch(/no longer granted to this session/);
      expect(h.recorded()).toBeUndefined();
    });

    // Rule 4 compared the request's user against the configured one before the
    // scan; signing after the user was narrowed would authenticate as the
    // account the user just took away.
    it("refuses when the configured user changed, and pins nothing", async () => {
      const h = harness();
      const { pending, release } = gated(h);
      h.editHost({ user: "restricted" });
      release();

      expect((await refusalOf(pending)).message).toMatch(/changed while ShipIt was verifying/);
      expect(h.recorded()).toBeUndefined();
    });
  });

  it("scans once for the destination, not once per concurrent first connection", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness({
      scan: async () => {
        await gate;
        return { keys: [h.server.blob] };
      },
    });
    const first = signSshRequest(h.deps, SESSION, validRequest(h));
    const second = signSshRequest(h.deps, SESSION, validRequest(h));
    release?.();
    await Promise.all([first, second]);

    expect(h.scans).toHaveLength(1);
    expect(h.recorded()).toBe(h.server.blob);
    // One recording, so one card: the second request sees the pin already set.
    expect(h.appended).toHaveLength(1);
  });
});

describe("the audit line", () => {
  it("records one line per attempt with the outcome, and no signing input", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const h = harness();
    const request = validRequest(h);
    await signSshRequest(h.deps, SESSION, request);
    await expect(signSshRequest(harness({ granted: false }).deps, SESSION, request)).rejects.toThrow();

    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[ssh-sign]"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`session=${SESSION}`);
    expect(lines[0]).toContain("destination=prod[ssh_1]");
    expect(lines[0]).toContain("address=prod.example.com:22");
    expect(lines[0]).toContain("user=deploy");
    expect(lines[0]).toContain("outcome=signed");
    expect(lines[1]).toContain("outcome=refused");
    expect(lines[1]).toContain("reason=not-granted");

    // A signature, a key blob or the data being signed in a log line is exactly
    // the leak this design exists to prevent.
    for (const line of lines) {
      expect(line).not.toContain(request.data);
      expect(line).not.toContain(request.keyBlob);
      expect(line).not.toContain(request.bind);
      expect(line).not.toContain(h.privateKeyPem.split("\n")[1]);
    }
  });

  // req 10 — one line per attempt, carrying the reason. The scan refusal is the
  // one refusal whose cause is outside the request entirely, so the line has to
  // say which it was.
  it("names the unverified host key as the refusal reason", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const h = harness({ scan: { keys: [], failure: "timeout" } });
    await expect(signSshRequest(h.deps, SESSION, validRequest(h))).rejects.toThrow();

    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[ssh-sign]"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("outcome=refused");
    expect(lines[0]).toContain("reason=host-key-unverified");
    expect(lines[0]).toContain("detail=scan=timeout");
  });

  /**
   * The line is whitespace-delimited and the refused `user` comes off the wire,
   * so an unescaped newline would forge a second entry in the only record of
   * why ShipIt refused.
   */
  it("cannot be split into a second line by a user name off the wire", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const h = harness();
    await expect(signSshRequest(h.deps, SESSION, {
      ...validRequest(h),
      data: buildUserauthData({
        sessionId: SSH_SESSION_ID,
        user: "root\n[ssh-sign] session=sess-1 outcome=signed",
        publicKeyBlob: h.host.publicKeyBlob,
      }),
    })).rejects.toThrow(/authenticates as deploy/);

    // One line, and one ` outcome=` field on it: whitespace is what separates a
    // field and a line, so escaping it is what keeps the forgery inside `user=`.
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[ssh-sign]"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    expect(lines[0].split(" outcome=")).toHaveLength(2);
    expect(lines[0]).toContain(" outcome=refused");
    expect(lines[0]).toContain("reason=user-mismatch");
  });
});
