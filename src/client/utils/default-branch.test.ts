import { describe, it, expect, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import {
  findRepoByUrl,
  resolveDefaultBranch,
  useSessionDefaultBranch,
  useSessionHasBaseBranch,
  FALLBACK_DEFAULT_BRANCH,
} from "./default-branch.js";
import { useRepoStore } from "../stores/repo-store.js";
import { useSessionStore } from "../stores/session-store.js";
import type { RepoInfo, SessionInfo } from "../../server/shared/types.js";

function repo(url: string, defaultBranch?: string): RepoInfo {
  return {
    url,
    addedAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
    status: "ready",
    ...(defaultBranch ? { defaultBranch } : {}),
  };
}

function session(id: string, remoteUrl: string): SessionInfo {
  return {
    id,
    title: id,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
    remoteUrl,
  } as SessionInfo;
}

const MASTER_REPO = "https://github.com/owner/legacy.git";

afterEach(() => {
  cleanup();
  useRepoStore.setState({ repos: [] });
  useSessionStore.setState({ sessions: [] });
});

describe("findRepoByUrl", () => {
  const repos = [repo(MASTER_REPO, "master")];

  it("matches exactly", () => {
    expect(findRepoByUrl(repos, MASTER_REPO)?.defaultBranch).toBe("master");
  });

  it("matches across .git-suffix and trailing-slash variance", () => {
    expect(findRepoByUrl(repos, "https://github.com/owner/legacy")?.defaultBranch).toBe("master");
    expect(findRepoByUrl(repos, "https://github.com/owner/legacy/")?.defaultBranch).toBe("master");
  });

  it("returns undefined for a blank or unknown url", () => {
    expect(findRepoByUrl(repos, undefined)).toBeUndefined();
    expect(findRepoByUrl(repos, "   ")).toBeUndefined();
    expect(findRepoByUrl(repos, "https://github.com/owner/other.git")).toBeUndefined();
  });
});

describe("resolveDefaultBranch", () => {
  it("returns the repo's real default branch", () => {
    expect(resolveDefaultBranch([repo(MASTER_REPO, "master")], MASTER_REPO)).toBe("master");
  });

  it("falls back to main when the repo is unknown or not yet resolved", () => {
    expect(resolveDefaultBranch([], MASTER_REPO)).toBe(FALLBACK_DEFAULT_BRANCH);
    expect(resolveDefaultBranch([repo(MASTER_REPO)], MASTER_REPO)).toBe(FALLBACK_DEFAULT_BRANCH);
  });

  it("falls back to main for a session with no remote", () => {
    expect(resolveDefaultBranch([repo(MASTER_REPO, "master")], undefined)).toBe(FALLBACK_DEFAULT_BRANCH);
    expect(resolveDefaultBranch([repo(MASTER_REPO, "master")], "")).toBe(FALLBACK_DEFAULT_BRANCH);
  });
});

describe("useSessionDefaultBranch", () => {
  it("maps a session to its repo's default branch", () => {
    useSessionStore.setState({ sessions: [session("s1", MASTER_REPO)] });
    useRepoStore.setState({ repos: [repo(MASTER_REPO, "master")] });

    const { result } = renderHook(() => useSessionDefaultBranch("s1"));
    expect(result.current).toBe("master");
  });

  it("falls back to main before the repo list hydrates", () => {
    useSessionStore.setState({ sessions: [session("s1", MASTER_REPO)] });

    const { result } = renderHook(() => useSessionDefaultBranch("s1"));
    expect(result.current).toBe(FALLBACK_DEFAULT_BRANCH);
  });

  it("settles onto the real branch once the repo list arrives", () => {
    useSessionStore.setState({ sessions: [session("s1", MASTER_REPO)] });

    const { result, rerender } = renderHook(() => useSessionDefaultBranch("s1"));
    expect(result.current).toBe(FALLBACK_DEFAULT_BRANCH);

    useRepoStore.setState({ repos: [repo(MASTER_REPO, "trunk")] });
    rerender();
    expect(result.current).toBe("trunk");
  });

  it("tolerates an undefined / unknown session id", () => {
    useRepoStore.setState({ repos: [repo(MASTER_REPO, "master")] });

    expect(renderHook(() => useSessionDefaultBranch(undefined)).result.current)
      .toBe(FALLBACK_DEFAULT_BRANCH);
    expect(renderHook(() => useSessionDefaultBranch("nope")).result.current)
      .toBe(FALLBACK_DEFAULT_BRANCH);
  });
});

describe("useSessionHasBaseBranch", () => {
  function kindSession(id: string, kind?: "ops" | "sandbox", remoteUrl?: string): SessionInfo {
    return {
      id,
      title: id,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      ...(remoteUrl ? { remoteUrl } : {}),
      ...(kind ? { kind } : {}),
    } as SessionInfo;
  }

  it("is true for a repo-backed session", () => {
    useSessionStore.setState({ sessions: [kindSession("s1", undefined, MASTER_REPO)] });
    expect(renderHook(() => useSessionHasBaseBranch("s1")).result.current).toBe(true);
  });

  it("is false without a remote", () => {
    useSessionStore.setState({ sessions: [kindSession("s1")] });
    expect(renderHook(() => useSessionHasBaseBranch("s1")).result.current).toBe(false);
  });

  it("is false for ops and sandbox sessions even with a remote", () => {
    useSessionStore.setState({
      sessions: [kindSession("s1", "ops", MASTER_REPO), kindSession("s2", "sandbox", MASTER_REPO)],
    });
    expect(renderHook(() => useSessionHasBaseBranch("s1")).result.current).toBe(false);
    expect(renderHook(() => useSessionHasBaseBranch("s2")).result.current).toBe(false);
  });

  it("fails closed for an undefined / unhydrated session", () => {
    expect(renderHook(() => useSessionHasBaseBranch(undefined)).result.current).toBe(false);
    expect(renderHook(() => useSessionHasBaseBranch("nope")).result.current).toBe(false);
  });
});
