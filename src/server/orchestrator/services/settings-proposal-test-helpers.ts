import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentInfo } from "../../shared/agent-registry.js";
import type { WsServerMessage } from "../../shared/types.js";
import { DatabaseManager } from "../../shared/database.js";
import { ChatHistoryManager } from "../chat-history.js";
import { CredentialStore } from "../credential-store.js";
import { EgressAllowlistStore } from "../egress-allowlist-store.js";
import { ProviderAccountManager } from "../provider-account-manager.js";
import { RepoStore } from "../repo-store.js";
import { SessionManager } from "../sessions.js";
import type { SessionRunnerInterface, SessionRunnerRegistry } from "../session-runner.js";
import { SettingsProposalStore } from "../settings-proposal-store.js";
import { settingsProposalDeps } from "./settings-proposal-deps.js";
import type { SettingsProposeDeps } from "./settings-propose.js";
import type { SettingsDecisionDeps } from "./settings-decision.js";

/**
 * One install, for the propose and decide tests
 * (docs/299-agent-settings-access req 4).
 *
 * It builds the REAL stores against an in-memory database rather than fakes,
 * because most of what these tests are about is what the stores do: a claim that
 * two clicks cannot both win, a baseline taken over stored bytes a projection
 * drops, a phase that has to land in the transcript and the private row
 * together. A fake store would answer whatever the test wanted.
 */

export interface ProposalFixture {
  sessionId: string;
  tmpDir: string;
  dbManager: DatabaseManager;
  sessions: SessionManager;
  history: ChatHistoryManager;
  proposals: SettingsProposalStore;
  credentialStore: CredentialStore;
  egressAllowlistStore: EgressAllowlistStore;
  repoStore: RepoStore;
  runner: SessionRunnerInterface;
  emitted: WsServerMessage[];
  broadcasts: { event: string; data: unknown }[];
  deps: SettingsProposeDeps & SettingsDecisionDeps;
  /** Drop the runner, as a container reclaimed hours after the turn would. */
  loseRunner(): void;
  close(): void;
}

export const FIXTURE_SESSION = "sess-1";

function fakeRunner(emitted: WsServerMessage[]): SessionRunnerInterface {
  const buffer: WsServerMessage[] = [];
  return {
    emitMessage: (m: WsServerMessage) => {
      emitted.push(m);
      buffer.push(m);
    },
    running: true,
    chatMessageGroups: [{ text: "I cannot start the review.", toolUse: [] }],
    recordedCards: [],
    steeredMessages: [],
    getTurnEventBuffer: () => [...buffer],
    lastPersistedBufferIndex: 0,
  } as unknown as SessionRunnerInterface;
}

export interface FixtureOptions {
  /** The session's repository binding, for the per-repository settings. */
  remoteUrl?: string;
  agents?: AgentInfo[];
  /** Opt-in: without it the install has no provider accounts, as most tests want. */
  providerAccounts?: boolean;
}

export function proposalFixture(opts: FixtureOptions = {}): ProposalFixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-settings-propose-"));
  const dbManager = new DatabaseManager(":memory:");
  const sessions = new SessionManager(dbManager);
  const history = new ChatHistoryManager(dbManager);
  const proposals = new SettingsProposalStore(dbManager);
  const credentialStore = new CredentialStore(path.join(tmpDir, "credentials"));
  const egressAllowlistStore = new EgressAllowlistStore(dbManager);
  const providerAccountManager = opts.providerAccounts
    ? new ProviderAccountManager({ credentialsDir: path.join(tmpDir, "credentials"), credentialStore })
    : undefined;
  const repoStore = new RepoStore(dbManager);
  const emitted: WsServerMessage[] = [];
  const broadcasts: { event: string; data: unknown }[] = [];
  const runner = fakeRunner(emitted);
  let attached: SessionRunnerInterface | undefined = runner;

  sessions.track(FIXTURE_SESSION, "A session");
  if (opts.remoteUrl) {
    repoStore.add(opts.remoteUrl);
    sessions.setRemoteUrl(FIXTURE_SESSION, opts.remoteUrl);
  }

  const deps = settingsProposalDeps({
    sseBroadcast: (event, data) => broadcasts.push({ event, data }),
    workspaceDir: tmpDir,
    // Enough of the registry for a settings SAVE, which builds the agent list
    // and picks a preview agent on its way out; `list` alone gets a save as far
    // as an "uncertain" outcome that has nothing to do with the write.
    agentRegistry: {
      list: () => opts.agents ?? [],
      available: () => (opts.agents ?? []).filter((a) => a.installed),
      get: (id: string) => (opts.agents ?? []).find((a) => a.id === id),
      refreshAuth: () => undefined,
    } as unknown as Parameters<typeof settingsProposalDeps>[0]["agentRegistry"],
    sessionManager: sessions,
    chatHistoryManager: history,
    settingsProposals: proposals,
    credentialStore,
    providerAccountManager,
    egressAllowlistStore,
    repoStore,
    getRunnerRegistry: () =>
      ({ get: (id: string) => (id === FIXTURE_SESSION ? attached : undefined) }) as unknown as SessionRunnerRegistry,
  });
  if (!deps) throw new Error("the fixture supplies a proposal store, so this cannot be null");
  // The release channel is the host checkout's on a real install; a test must
  // not read it, and a baseline that says "unreadable" refuses every proposal.
  deps.baseline.readReleaseChannel = async () => "stable";
  deps.read.readReleaseChannel = async () => "stable";

  return {
    sessionId: FIXTURE_SESSION,
    tmpDir,
    dbManager,
    sessions,
    history,
    proposals,
    credentialStore,
    egressAllowlistStore,
    repoStore,
    runner,
    emitted,
    broadcasts,
    deps,
    loseRunner: () => {
      attached = undefined;
    },
    close: () => {
      dbManager.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}
