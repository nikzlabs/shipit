import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionSshHostGrants } from "./SessionSshHostGrants.js";
import type { SessionSshHostsView, SshHostPublic } from "../../server/shared/types.js";

function host(id: string, label: string, over: Partial<SshHostPublic> = {}): SshHostPublic {
  return {
    id,
    label,
    address: `${label}.example.com`,
    port: 22,
    user: "deploy",
    publicKeyBlob: "AAAA",
    identityLine: "ssh-ed25519 AAAA",
    authorizedKeysLine: "no-agent-forwarding ssh-ed25519 AAAA",
    fingerprint: "SHA256:abc",
    createdAt: "2026-09-14T00:00:00.000Z",
    ...over,
  };
}

function stubFetch(view: unknown, onPut?: (granted: string[]) => void) {
  const puts: string[][] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const granted = (JSON.parse(init.body as string) as { granted: string[] }).granted;
      puts.push(granted);
      onPut?.(granted);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ...(view as SessionSshHostsView), granted }),
      } as Response;
    }
    return { ok: true, status: 200, json: async () => view } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { puts, fetchMock };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SessionSshHostGrants (docs/305 req 6)", () => {
  it("lists every destination and marks the granted ones", async () => {
    stubFetch({ sessionId: "s1", hosts: [host("a", "prod"), host("b", "staging")], granted: ["a"] });
    render(<SessionSshHostGrants sessionId="s1" open />);

    await waitFor(() => expect(screen.getByTestId("session-ssh-hosts")).toBeTruthy());
    expect(screen.getByRole("checkbox", { name: "prod" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("checkbox", { name: "staging" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("deploy@prod.example.com")).toBeTruthy();
  });

  it("shows a non-default port, which is part of addressing the destination", async () => {
    stubFetch({ sessionId: "s1", hosts: [host("a", "prod", { port: 2222 })], granted: [] });
    render(<SessionSshHostGrants sessionId="s1" open />);
    await waitFor(() => expect(screen.getByText("deploy@prod.example.com:2222")).toBeTruthy());
  });

  it("PUTs the whole grant set when a destination is toggled", async () => {
    const view = { sessionId: "s1", hosts: [host("a", "prod"), host("b", "staging")], granted: ["a"] };
    const { puts } = stubFetch(view);
    render(<SessionSshHostGrants sessionId="s1" open />);
    await waitFor(() => expect(screen.getByTestId("session-ssh-hosts")).toBeTruthy());

    await userEvent.click(screen.getByRole("checkbox", { name: "staging" }));
    await waitFor(() => expect(puts).toEqual([["a", "b"]]));

    await userEvent.click(screen.getByRole("checkbox", { name: "prod" }));
    await waitFor(() => expect(puts[1]).toEqual(["b"]));
  });

  it("reverts the toggle when the write fails", async () => {
    const view = { sessionId: "s1", hosts: [host("a", "prod")], granted: [] };
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "PUT"
        ? ({ ok: false, status: 500, json: async () => ({}) } as Response)
        : ({ ok: true, status: 200, json: async () => view } as Response)));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<SessionSshHostGrants sessionId="s1" open />);
    await waitFor(() => expect(screen.getByTestId("session-ssh-hosts")).toBeTruthy());

    await userEvent.click(screen.getByRole("checkbox", { name: "prod" }));
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "prod" }).getAttribute("aria-checked")).toBe("false"));
  });

  it("renders nothing when the registry is empty, rather than an empty heading", async () => {
    stubFetch({ sessionId: "s1", hosts: [], granted: [] });
    render(<SessionSshHostGrants sessionId="s1" open />);
    await waitFor(() => expect(screen.queryByTestId("session-ssh-hosts")).toBeNull());
  });

  // It shares a dialog with two other sections; a throw here would take all of
  // them down with it.
  it("renders nothing, and does not throw, on a response of the wrong shape", async () => {
    stubFetch({ unexpected: true });
    render(<SessionSshHostGrants sessionId="s1" open />);
    await waitFor(() => expect(screen.queryByTestId("session-ssh-hosts")).toBeNull());
  });

  it("does not read anything while the dialog is closed", () => {
    const { fetchMock } = stubFetch({ sessionId: "s1", hosts: [host("a", "prod")], granted: [] });
    render(<SessionSshHostGrants sessionId="s1" open={false} />);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
