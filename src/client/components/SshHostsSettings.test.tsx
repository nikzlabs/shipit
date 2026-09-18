import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { SshHostsSettings } from "./SshHostsSettings.js";
import { useUiStore } from "../stores/ui-store.js";
import type { SshHostPublic } from "../../server/shared/types.js";

/**
 * The edit affordance (docs/305-ssh-hosts req 14). The driving case is a Tailscale
 * peer added by a MagicDNS name that resolves nowhere ShipIt can reach it: the fix
 * is to change the address, and it must not disturb the grants.
 */
const host: SshHostPublic = {
  id: "ssh_1",
  label: "tailnet-box",
  address: "box.ts1234.ts.net",
  port: 22,
  user: "nik",
  publicKeyBlob: "AAAA",
  identityLine: "ssh-ed25519 AAAA shipit-tailnet-box",
  authorizedKeysLine: "restrict ssh-ed25519 AAAA shipit-tailnet-box",
  fingerprint: "SHA256:ourkey",
  createdAt: "2026-09-14T00:00:00.000Z",
  hostKeyFingerprint: "SHA256:serverkey",
  hostKeyType: "ssh-ed25519",
};

const originalFetch = globalThis.fetch;

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

const calls: Call[] = [];
let patchResponse: { status: number; body: unknown } = { status: 200, body: {} };
/** Set to hold the PATCH open, for the in-flight assertions. */
let pendingPatch: Promise<void> | null = null;

function installFetch(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    calls.push({ method, url, ...(body ? { body } : {}) });
    if (method === "GET") {
      return Promise.resolve(new Response(JSON.stringify({ hosts: [host] }), { status: 200 }));
    }
    if (method === "PATCH") {
      return (async () => {
        if (pendingPatch) await pendingPatch;
        return new Response(JSON.stringify(patchResponse.body), { status: patchResponse.status });
      })();
    }
    return Promise.resolve(new Response(JSON.stringify({ error: `unexpected ${method}` }), { status: 500 }));
  }) as typeof fetch;
}

async function openEditor(): Promise<void> {
  render(<SshHostsSettings />);
  await screen.findByText("tailnet-box");
  fireEvent.click(screen.getByTestId("ssh-host-edit"));
  await screen.findByLabelText("Address");
}

describe("SshHostsSettings — editing a destination", () => {
  beforeEach(() => {
    calls.length = 0;
    patchResponse = { status: 200, body: {} };
    pendingPatch = null;
    useUiStore.getState().setToast(null);
    installFetch();
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("patches the existing destination and shows the new endpoint", async () => {
    patchResponse = {
      status: 200,
      body: { host: { ...host, address: "100.64.0.7", hostKeyFingerprint: undefined, hostKeyType: undefined } },
    };
    await openEditor();

    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "100.64.0.7" } });
    fireEvent.click(screen.getByTestId("ssh-host-save"));

    await waitFor(() => expect(screen.getByText("nik@100.64.0.7")).toBeTruthy());
    const patch = calls.find((c) => c.method === "PATCH");
    // The id in the URL is what keeps every session's grant: a delete-and-re-add
    // would mint a new id and revoke the destination everywhere.
    expect(patch?.url).toBe("/api/ssh-hosts/ssh_1");
    expect(patch?.body).toEqual({ label: "tailnet-box", address: "100.64.0.7", user: "nik", port: "22" });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("keeps the failed draft and leaves the destination as it was", async () => {
    patchResponse = { status: 400, body: { error: "address must be a hostname or an IP address" } };
    await openEditor();

    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "not a host" } });
    fireEvent.click(screen.getByTestId("ssh-host-save"));

    await waitFor(() =>
      expect(useUiStore.getState().toast?.message).toContain("address must be a hostname or an IP address"),
    );
    // The rejected draft is still there to correct, not thrown away.
    expect((screen.getByLabelText("Address") as HTMLInputElement).value).toBe("not a host");

    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.getByText("nik@box.ts1234.ts.net")).toBeTruthy();
  });

  it("sends the port as typed, so the server rejects one it cannot use", async () => {
    patchResponse = { status: 400, body: { error: "port must be between 1 and 65535" } };
    await openEditor();

    fireEvent.change(screen.getByLabelText("Port"), { target: { value: "abc" } });
    fireEvent.click(screen.getByTestId("ssh-host-save"));

    await waitFor(() =>
      expect(useUiStore.getState().toast?.message).toContain("port must be between 1 and 65535"),
    );
    // Coercing here would have sent 22 — a silent move of the destination, and on an
    // edit that also forgets the key recorded for the port it really had.
    expect(calls.find((c) => c.method === "PATCH")?.body?.port).toBe("abc");
  });

  it("locks the fields while the save is in flight", async () => {
    let release: (() => void) | undefined;
    pendingPatch = new Promise<void>((resolve) => {
      release = resolve;
    });
    patchResponse = { status: 200, body: { host: { ...host, address: "100.64.0.7" } } };
    await openEditor();

    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "100.64.0.7" } });
    fireEvent.click(screen.getByTestId("ssh-host-save"));

    // An edit typed now is in no request, and the reset on success would drop it.
    await waitFor(() => expect((screen.getByLabelText("User") as HTMLInputElement).disabled).toBe(true));
    release?.();
    await waitFor(() => expect(screen.getByText("nik@100.64.0.7")).toBeTruthy());
  });

  it("says the recorded server key is forgotten once the endpoint differs", async () => {
    await openEditor();

    expect(screen.getByText(/Changing the address or port forgets the recorded server key/)).toBeTruthy();
    expect(screen.queryByText(/Saving forgets the recorded server key/)).toBeNull();

    fireEvent.change(screen.getByLabelText("Port"), { target: { value: "2222" } });

    await waitFor(() => expect(screen.getByText(/Saving forgets the recorded server key/)).toBeTruthy());
    expect(screen.queryByText(/Changing the address or port forgets/)).toBeNull();
  });
});
