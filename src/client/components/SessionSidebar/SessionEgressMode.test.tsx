import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionEgressMode } from "./SessionEgressMode.js";
import { DropdownMenu, DropdownMenuContent } from "../ui/dropdown-menu.js";
import type { EgressAllowlistView } from "../../../server/shared/types.js";

/** Render the override control inside an open menu (Radix radios need the menu context). */
function renderInMenu(sessionId = "s1") {
  return render(
    <DropdownMenu open modal={false}>
      <DropdownMenuContent portaled={false}>
        <SessionEgressMode sessionId={sessionId} />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
}

function stubFetch(initialOverride: boolean | null = null, enforcementActive = true) {
  let override = initialOverride;
  const view = (): EgressAllowlistView => ({
    entries: [],
    globalEnabled: true,
    enforcementActive,
    session: {
      sessionId: "s1",
      override,
      hosts: [],
      effectiveContained: override ?? true,
      globalEnabled: true,
      enforcementActive,
    },
    defaultsCustomized: false,
  });
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/egress/allowlist")) return { ok: true, status: 200, json: async () => view() } as Response;
    if (url.startsWith("/api/egress/session/") && init?.method === "PUT") {
      override = (JSON.parse((init.body as string) ?? "{}").override ?? null) as boolean | null;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
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
});

describe("SessionEgressMode (docs/172)", () => {
  it("loads the session's current override and reflects it (open → 'Open' checked)", async () => {
    stubFetch(false); // override=false → Open
    renderInMenu();
    await waitFor(() =>
      expect(screen.getByRole("menuitemradio", { name: "Open" })).toHaveAttribute("aria-checked", "true"),
    );
  });

  it("defaults to Inherit when there's no override", async () => {
    stubFetch(null);
    renderInMenu();
    await waitFor(() =>
      expect(screen.getByRole("menuitemradio", { name: "Inherit global" })).toHaveAttribute("aria-checked", "true"),
    );
  });

  it("warns when this session would be contained but the deployment can't enforce", async () => {
    stubFetch(null, false); // inherit → global Contained, but enforcement inactive
    renderInMenu();
    await waitFor(() =>
      expect(screen.getByTestId("session-egress-enforcement-warning")).toBeInTheDocument(),
    );
  });

  it("does NOT warn when enforcement is active", async () => {
    stubFetch(null, true);
    renderInMenu();
    await waitFor(() =>
      expect(screen.getByRole("menuitemradio", { name: "Inherit global" })).toHaveAttribute("aria-checked", "true"),
    );
    expect(screen.queryByTestId("session-egress-enforcement-warning")).not.toBeInTheDocument();
  });

  it("does NOT warn when this session is Open even if enforcement is inactive", async () => {
    stubFetch(false, false); // override=false → Open
    renderInMenu();
    await waitFor(() =>
      expect(screen.getByRole("menuitemradio", { name: "Open" })).toHaveAttribute("aria-checked", "true"),
    );
    expect(screen.queryByTestId("session-egress-enforcement-warning")).not.toBeInTheDocument();
  });

  it("PUTs the chosen override for the session", async () => {
    const impl = stubFetch(null);
    renderInMenu();
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: "Contained" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Contained" }));
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
});
