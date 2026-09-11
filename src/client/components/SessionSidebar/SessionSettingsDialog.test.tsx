import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionSettingsDialog } from "./SessionSettingsDialog.js";
import { useSessionStore } from "../../stores/session-store.js";
import type {
  EgressAllowlistView,
  EgressEnforcementStatus,
  SessionCapabilities,
  SessionInfo,
} from "../../../server/shared/types.js";

function renderDialog(sessionId = "s1") {
  return render(<SessionSettingsDialog sessionId={sessionId} open onOpenChange={() => {}} />);
}

function stubFetch(opts: {
  initialOverride?: boolean | null;
  enforcementActive?: boolean;

  enforcementStatus?: EgressEnforcementStatus;
  startedContained?: boolean | null;
  pendingRestart?: boolean;
} = {}) {
  const { initialOverride = null, enforcementActive = true, startedContained = null } = opts;
  const enforcementStatus: EgressEnforcementStatus =
    opts.enforcementStatus ?? (enforcementActive ? "active" : "no-sidecar");
  let override = initialOverride;

  const effectiveContained = (): boolean => override ?? true;
  const pending = (): boolean => startedContained !== null && startedContained !== effectiveContained();
  const sessionView = () => ({
    sessionId: "s1",
    override,
    hosts: [],
    effectiveContained: effectiveContained(),
    globalEnabled: true,
    enforcementActive,
    enforcementStatus,
    startedContained,
    pendingRestart: pending(),
  });
  const view = (): EgressAllowlistView => ({
    entries: [],
    globalEnabled: true,
    enforcementActive,
    enforcementStatus,
    session: sessionView(),
    defaultsCustomized: false,
  });
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/egress/allowlist")) return { ok: true, status: 200, json: async () => view() } as Response;

    if (url.startsWith("/api/egress/session/") && init?.method !== "PUT") {
      return { ok: true, status: 200, json: async () => sessionView() } as Response;
    }
    if (url.startsWith("/api/egress/session/") && init?.method === "PUT") {
      override = (JSON.parse((init.body as string) ?? "{}").override ?? null) as boolean | null;
      return { ok: true, status: 200, json: async () => sessionView() } as Response;
    }
    if (url.includes("/container/restart") && init?.method === "POST") {
      return { ok: true, status: 200, json: async () => ({ ok: true, noContainer: false, newContainerState: "running", error: null }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
  vi.stubGlobal("fetch", impl);
  return impl;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useSessionStore.setState({ isLoading: false, sessions: [] });
});

describe("SessionSettingsDialog (docs/172)", () => {
  it("loads the session's current override and reflects it (open → 'Open' checked)", async () => {
    stubFetch({ initialOverride: false });                         
    renderDialog();
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Open" })).toHaveAttribute("aria-checked", "true"),
    );
  });

  it("defaults to Inherit when there's no override", async () => {
    stubFetch({ initialOverride: null });
    renderDialog();
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Inherit workspace" })).toHaveAttribute("aria-checked", "true"),
    );
  });

  it("warns when this session would be contained but the deployment can't enforce", async () => {
    stubFetch({ initialOverride: null, enforcementActive: false });                                               
    renderDialog();
    await waitFor(() =>
      expect(screen.getByTestId("session-settings-enforcement-warning")).toBeInTheDocument(),
    );
  });

  it("does NOT warn when this session is Open even if enforcement is inactive", async () => {
    stubFetch({ initialOverride: false, enforcementActive: false });                         
    renderDialog();
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Open" })).toHaveAttribute("aria-checked", "true"),
    );
    expect(screen.queryByTestId("session-settings-enforcement-warning")).not.toBeInTheDocument();
  });

  it("PUTs the chosen override for the session", async () => {
    const impl = stubFetch({ initialOverride: null });
    renderDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Contained" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("radio", { name: "Contained" }));
    await waitFor(() =>
      expect(
        impl.mock.calls.some(([url, init]) => {
          if (url !== "/api/egress/session/s1" || init?.method !== "PUT") return false;
          const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
          return body.override === true;
        }),
      ).toBe(true),
    );
  });

  it("does not fetch while closed", async () => {
    const impl = stubFetch({ initialOverride: null });
    render(<SessionSettingsDialog sessionId="s1" open={false} onOpenChange={() => {}} />);
    expect(impl).not.toHaveBeenCalled();
  });

  describe("pending-restart (mode differs from the live container)", () => {
    it("shows the pending indicator only on a real delta", async () => {

      stubFetch({ initialOverride: false, startedContained: true });
      renderDialog();
      await waitFor(() => expect(screen.getByTestId("session-settings-pending")).toBeInTheDocument());
      expect(screen.getByTestId("session-settings-restart")).toBeInTheDocument();
    });

    it("does NOT show the pending indicator when the live mode matches", async () => {

      stubFetch({ initialOverride: null, startedContained: true });
      renderDialog();
      await waitFor(() => expect(screen.getByRole("radio", { name: "Inherit workspace" })).toBeInTheDocument());
      expect(screen.queryByTestId("session-settings-pending")).not.toBeInTheDocument();
    });

    it("does NOT show pending when no container is running (startedContained null)", async () => {
      stubFetch({ initialOverride: false, startedContained: null });
      renderDialog();
      await waitFor(() => expect(screen.getByRole("radio", { name: "Open" })).toBeInTheDocument());
      expect(screen.queryByTestId("session-settings-pending")).not.toBeInTheDocument();
    });

    it("disables 'Restart to apply now' while an agent turn is running", async () => {
      useSessionStore.setState({ isLoading: true });
      stubFetch({ initialOverride: false, startedContained: true });
      renderDialog();
      await waitFor(() => expect(screen.getByTestId("session-settings-restart")).toBeInTheDocument());
      expect(screen.getByTestId("session-settings-restart")).toBeDisabled();
    });

    it("restart is enabled when no turn is running, and POSTs the existing restart route", async () => {
      const impl = stubFetch({ initialOverride: false, startedContained: true });
      renderDialog();
      await waitFor(() => expect(screen.getByTestId("session-settings-restart")).toBeEnabled());
      await userEvent.click(screen.getByTestId("session-settings-restart"));
      await waitFor(() =>
        expect(
          impl.mock.calls.some(([url, init]) =>
            url === "/api/sessions/s1/container/restart" && init?.method === "POST",
          ),
        ).toBe(true),
      );
    });

    it("never auto-restarts on mode selection (only the explicit button does)", async () => {
      const impl = stubFetch({ initialOverride: null, startedContained: true });
      renderDialog();
      await waitFor(() => expect(screen.getByRole("radio", { name: "Open" })).toBeInTheDocument());
      await userEvent.click(screen.getByRole("radio", { name: "Open" }));

      await waitFor(() =>
        expect(impl.mock.calls.some(([url, init]) => url === "/api/egress/session/s1" && init?.method === "PUT")).toBe(true),
      );
      // …but the restart route was never called by the toggle.
      expect(impl.mock.calls.some(([url]) => url.includes("/container/restart"))).toBe(false);
    });
  });
});

describe("SessionSettingsDialog — sandbox capabilities (docs/279)", () => {
  const CAPS: SessionCapabilities = {
    git: false, docker: false, network: true, dangerousGitHubOps: false,
  };

  function asSandbox() {
    useSessionStore.setState({
      sessions: [{ id: "s1", kind: "sandbox", capabilities: CAPS } as unknown as SessionInfo],
    });
  }

  function stubCapabilityFetch(opts: { pendingRestart?: boolean } = {}) {
    let caps: SessionCapabilities = { ...CAPS };
    const view = () => ({
      sessionId: "s1",
      capabilities: caps,
      capabilitiesAtStart: CAPS,
      pendingRestart: opts.pendingRestart ?? false,
    });
    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/sessions/s1/capabilities" && init?.method === "PUT") {
        const sent = JSON.parse((init.body as string) ?? "{}").capabilities as SessionCapabilities;

        caps = { ...sent, dangerousGitHubOps: sent.git && sent.dangerousGitHubOps };
        return { ok: true, status: 200, json: async () => view() } as Response;
      }
      if (url === "/api/sessions/s1/capabilities") {
        return { ok: true, status: 200, json: async () => view() } as Response;
      }
      if (url.includes("/container/restart") && init?.method === "POST") {
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    vi.stubGlobal("fetch", impl);
    return impl;
  }

  it("renders the capability toggles and no containment radio group", async () => {
    asSandbox();
    stubCapabilityFetch();
    renderDialog();
    await waitFor(() => expect(screen.getByTestId("session-settings-capabilities")).toBeInTheDocument());
    expect(screen.getByRole("switch", { name: "GitHub access" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Contained" })).not.toBeInTheDocument();
  });

  it("never reads the egress allowlist for a sandbox", async () => {
    asSandbox();
    const impl = stubCapabilityFetch();
    renderDialog();
    await waitFor(() => expect(screen.getByTestId("session-settings-capabilities")).toBeInTheDocument());
    expect(impl.mock.calls.some(([url]) => url.startsWith("/api/egress/"))).toBe(false);
  });

  it("PUTs the whole set when a toggle is flipped", async () => {
    asSandbox();
    const impl = stubCapabilityFetch();
    renderDialog();
    await waitFor(() => expect(screen.getByRole("switch", { name: "Docker access" })).toBeEnabled());
    await userEvent.click(screen.getByRole("switch", { name: "Docker access" }));
    await waitFor(() =>
      expect(
        impl.mock.calls.some(([url, init]) =>
          url === "/api/sessions/s1/capabilities"
          && init?.method === "PUT"
          && JSON.parse((init.body as string) ?? "{}").capabilities.docker === true,
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Docker access" })).toHaveAttribute("aria-checked", "true"),
    );
  });

  it("shows the server's pending verdict with a restart action, and never auto-restarts", async () => {
    asSandbox();
    const impl = stubCapabilityFetch({ pendingRestart: true });
    renderDialog();
    await waitFor(() => expect(screen.getByTestId("session-settings-pending")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("switch", { name: "Docker access" }));
    await waitFor(() =>
      expect(impl.mock.calls.some(([url, init]) => url === "/api/sessions/s1/capabilities" && init?.method === "PUT")).toBe(true),
    );
    // The toggle itself must never restart the container — only the button does.
    expect(impl.mock.calls.some(([url]) => url.includes("/container/restart"))).toBe(false);

    await userEvent.click(screen.getByTestId("session-settings-restart"));
    await waitFor(() =>
      expect(impl.mock.calls.some(([url, init]) =>
        url === "/api/sessions/s1/container/restart" && init?.method === "POST")).toBe(true),
    );
  });

  it("refuses the restart while an agent turn is running", async () => {
    asSandbox();
    stubCapabilityFetch({ pendingRestart: true });
    useSessionStore.setState({ isLoading: true });
    renderDialog();
    await waitFor(() => expect(screen.getByTestId("session-settings-restart")).toBeDisabled());
  });

  it("keeps the merge sub-grant disabled until GitHub access is on", async () => {
    asSandbox();
    stubCapabilityFetch();
    renderDialog();
    await waitFor(() => expect(screen.getByRole("switch", { name: "GitHub access" })).toBeEnabled());
    expect(screen.getByRole("switch", { name: "Allow merging PRs" })).toBeDisabled();

    await userEvent.click(screen.getByRole("switch", { name: "GitHub access" }));
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Allow merging PRs" })).toBeEnabled(),
    );
  });
});
