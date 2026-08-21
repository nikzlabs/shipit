/**
 * docs/279 — the capability edit service: the durable write, its gating, and the
 * transcript card that records it.
 *
 * Uses a real `SessionManager` over a temp DB so the `capabilities` column and
 * its `fromRow` normalization are exercised end to end — the sub-grant rule in
 * particular has to survive the round-trip, not just the in-memory coercion.
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";
import { ServiceError } from "./types.js";
import {
  readSandboxCapabilities,
  updateSandboxCapabilities,
  emitSessionSettingsChangeCard,
  type SessionSettingsDeps,
} from "./session-settings.js";
import type { PersistedMessage } from "../chat-history.js";
import type { SessionCapabilities } from "../../shared/types.js";

describe("sandbox capability editing", () => {
  const tmpDirs: string[] = [];
  let dbManager: DatabaseManager | null = null;

  afterEach(() => {
    dbManager?.close();
    dbManager = null;
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  function setup(opts: { kind?: "sandbox" | "ops"; atStart?: SessionCapabilities | null } = {}) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-settings-"));
    tmpDirs.push(tmpDir);
    dbManager = new DatabaseManager(path.join(tmpDir, "test.db"));
    const sessionManager = new SessionManager(dbManager);
    sessionManager.track("s1", "Sandbox session", tmpDir);
    const kind = opts.kind ?? "sandbox";
    sessionManager.setKind("s1", kind);
    if (kind === "sandbox") {
      sessionManager.setCapabilities("s1", {
        git: false, docker: false, network: true, dangerousGitHubOps: false,
      });
    }

    const appended: PersistedMessage[] = [];
    const broadcasts: string[] = [];
    const deps = {
      sessionManager,
      // No runner attached — the common shape for a settings change made while
      // nothing is running. `emitSessionSettingsChangeCard` must still persist.
      runnerRegistry: { get: () => undefined },
      chatHistoryManager: {
        append: (_id: string, m: PersistedMessage) => { appended.push(m); },
      },
      containerManager: {
        capabilitiesAtStart: () => opts.atStart ?? null,
      },
      sseBroadcast: (event: string) => { broadcasts.push(event); },
    } as unknown as SessionSettingsDeps;

    return { deps, sessionManager, appended, broadcasts };
  }

  const full = (over: Partial<SessionCapabilities> = {}): SessionCapabilities => ({
    git: false, docker: false, network: true, dangerousGitHubOps: false, ...over,
  });

  it("persists the new grants and reports them back", () => {
    const { deps, sessionManager } = setup();

    const view = updateSandboxCapabilities(deps, "s1", full({ git: true, docker: true }));

    expect(view.capabilities).toEqual(full({ git: true, docker: true }));
    // Durable, not just returned: re-read through `fromRow`.
    expect(sessionManager.get("s1")?.capabilities).toEqual(full({ git: true, docker: true }));
  });

  it("clears the merge sub-grant when GitHub access is off, whatever the caller sent", () => {
    // The payload is untrusted, and the client's own clearing is not the
    // enforcement — `normalizeCapabilities` is.
    const { deps, sessionManager } = setup();

    const view = updateSandboxCapabilities(deps, "s1", { ...full(), dangerousGitHubOps: true });

    expect(view.capabilities.dangerousGitHubOps).toBe(false);
    expect(sessionManager.get("s1")?.capabilities?.dangerousGitHubOps).toBe(false);
  });

  it("merges a partial payload over the current set instead of resetting omitted grants", () => {
    // A body that never mentions `git` must not revoke it. `normalizeCapabilities`
    // alone would substitute the CREATION DEFAULTS for everything missing, so
    // `{ docker: true }` used to turn Network on and silently drop GitHub access.
    const { deps, sessionManager } = setup();
    sessionManager.setCapabilities("s1", full({ git: true, network: false }));

    const view = updateSandboxCapabilities(deps, "s1", { docker: true });

    expect(view.capabilities).toEqual(full({ git: true, network: false, docker: true }));
  });

  it("still revokes on an explicit false — only absence means 'leave it alone'", () => {
    const { deps } = setup();
    const view = updateSandboxCapabilities(deps, "s1", { network: false });
    expect(view.capabilities.network).toBe(false);
  });

  it("clears the merge sub-grant when a partial payload revokes GitHub access alone", () => {
    // The sub-grant rule runs on the MERGED result, so revoking its parent takes
    // it with it even though the body never named it.
    const { deps, sessionManager } = setup();
    sessionManager.setCapabilities("s1", full({ git: true, dangerousGitHubOps: true }));

    const view = updateSandboxCapabilities(deps, "s1", { git: false });

    expect(view.capabilities.dangerousGitHubOps).toBe(false);
  });

  it("refuses a session that is not a sandbox", () => {
    const { deps } = setup({ kind: "ops" });
    expect(() => updateSandboxCapabilities(deps, "s1", full({ docker: true })))
      .toThrow(ServiceError);
  });

  it("refuses an unknown session", () => {
    const { deps } = setup();
    expect(() => updateSandboxCapabilities(deps, "nope", full())).toThrow(ServiceError);
  });

  it("writes a transcript card naming what moved, and broadcasts the session list", () => {
    const { deps, appended, broadcasts } = setup();

    updateSandboxCapabilities(deps, "s1", full({ docker: true }));

    expect(broadcasts).toContain("session_list");
    expect(appended).toHaveLength(1);
    const card = appended[0].sessionSettingsChange;
    expect(card?.scope).toBe("sandbox-capabilities");
    expect(card?.changes).toEqual([
      { label: "Docker access", from: "off", to: "on", granted: true },
    ]);
  });

  it("writes nothing at all when the submitted set matches the current one", () => {
    const { deps, appended, broadcasts } = setup();

    const view = updateSandboxCapabilities(deps, "s1", full());

    expect(view.capabilities).toEqual(full());
    expect(appended).toEqual([]);
    expect(broadcasts).toEqual([]);
  });

  it("reports pendingRestart against what the live container started with", () => {
    const { deps, appended } = setup({ atStart: full() });

    const view = updateSandboxCapabilities(deps, "s1", full({ docker: true }));

    expect(view.capabilitiesAtStart).toEqual(full());
    expect(view.pendingRestart).toBe(true);
    // The card records the pending state as it was at the moment of the change.
    expect(appended[0].sessionSettingsChange?.pendingRestart).toBe(true);
  });

  it("does not report pendingRestart for a broker-side grant", () => {
    const { deps } = setup({ atStart: full() });

    const view = updateSandboxCapabilities(deps, "s1", full({ git: true }));

    expect(view.pendingRestart).toBe(false);
  });

  it("reads the current grants plus the pending verdict", () => {
    const { deps, sessionManager } = setup({ atStart: full() });
    sessionManager.setCapabilities("s1", full({ network: false }));

    const view = readSandboxCapabilities(deps, "s1");

    expect(view.capabilities).toEqual(full({ network: false }));
    expect(view.pendingRestart).toBe(true);
  });

  it("persists a card even with no runner attached", () => {
    // The durable record is the point of requirement 7, and "nobody is watching
    // right now" is the case it most needs to survive.
    const { deps, appended } = setup();

    emitSessionSettingsChangeCard(
      deps, "s1", "network-mode",
      [{ label: "Network containment", from: "Inherit global", to: "Open" }],
      true,
    );

    expect(appended).toHaveLength(1);
    expect(appended[0].sessionSettingsChange?.scope).toBe("network-mode");
    expect(appended[0].text).toBe("");
  });

  it("writes no card for an empty change list", () => {
    const { deps, appended } = setup();
    emitSessionSettingsChangeCard(deps, "s1", "network-mode", [], false);
    expect(appended).toEqual([]);
  });
});
