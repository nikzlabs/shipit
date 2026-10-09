// eslint-disable-next-line no-restricted-imports -- useEffect: a mount counter is what this file asserts on
import { createRef, useEffect, useRef } from "react";
import { describe, it, expect, afterEach } from "vitest";
import { renderHook, render, screen, cleanup, act } from "@testing-library/react";
import { AppLayout, statusGroupBreakpoint } from "./AppLayout.js";
import { useSubscriptionPillCount } from "./components/SubscriptionLimitsBadge.js";
import { useSettingsStore } from "./stores/settings-store.js";
import { useUiStore } from "./stores/ui-store.js";
import type { SubscriptionLimitsMap } from "../server/shared/types.js";

afterEach(() => {
  cleanup();
  useSettingsStore.getState().setProviderAccounts([]);
  useUiStore.setState({ hostCpu: null });
});

describe("statusGroupBreakpoint", () => {
  it("keeps a single pill inline from sm", () => {
    expect(statusGroupBreakpoint(1)).toEqual({
      statusInline: "hidden sm:contents",
      statusCollapsed: "sm:hidden",
    });
    expect(statusGroupBreakpoint(0)).toEqual(statusGroupBreakpoint(1));
  });

  it("raises the inline threshold as pills are added", () => {
    expect(statusGroupBreakpoint(2)).toEqual({
      statusInline: "hidden lg:contents",
      statusCollapsed: "lg:hidden",
    });
    expect(statusGroupBreakpoint(3)).toEqual(statusGroupBreakpoint(2));
    expect(statusGroupBreakpoint(4)).toEqual({
      statusInline: "hidden xl:contents",
      statusCollapsed: "xl:hidden",
    });
  });

  it("does not escalate past xl — beyond four pills, truncation carries it", () => {
    expect(statusGroupBreakpoint(9)).toEqual(statusGroupBreakpoint(4));
  });

  it("pairs each inline breakpoint with its own collapse breakpoint", () => {
    for (const count of [0, 1, 2, 3, 4, 5]) {
      const { statusInline, statusCollapsed } = statusGroupBreakpoint(count);
      expect(statusInline).toBe(`hidden ${statusCollapsed.replace(":hidden", "")}:contents`);
    }
  });
});

/**
 * Counts its own mounts, because `data-chat-panel` can be reused while the
 * subtree holding the transcript's state is rebuilt beneath it.
 */
function CountingChatPanel({ mounts }: { mounts: { count: number } }) {
  const scroller = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line no-restricted-syntax -- counting mounts is the assertion
  useEffect(() => {
    mounts.count += 1;
  }, [mounts]);
  return (
    <div ref={scroller} data-testid="transcript-scroller" style={{ overflowY: "scroll", height: 100 }}>
      <div style={{ height: 1000 }}>transcript</div>
    </div>
  );
}

function layoutProps(over: Partial<Parameters<typeof AppLayout>[0]>): Parameters<typeof AppLayout>[0] {
  return {
    theme: "dark",
    onSelectTheme: () => {},
    onSettingsOpen: () => {},
    onShortcutsOpen: () => {},
    hasSystemPrompt: false,
    githubAuthenticated: false,
    dockerMemory: null,
    processStartedAt: null,
    subscriptionLimits: {},
    onNavigateHome: () => {},
    onOpenSessions: () => {},
    showConnectionBanner: false,
    connectionStatus: "open",
    reconnectAttempt: 0,
    onReconnect: () => {},
    isMobile: false,
    showHomeScreen: false,
    showNewSessionView: false,
    mobilePanel: "chat",
    onMobilePanelChange: () => {},
    onMobileNewSession: () => {},
    onMobileQuickSession: () => {},
    onMobileVoiceSession: () => {},
    onQuickSessionCreated: () => {},
    chatPanel: null,
    rightPanel: <div>workspace</div>,
    fraction: 0.5,
    isDragging: false,
    onMouseDown: () => {},
    onTouchStart: () => {},
    containerRef: createRef<HTMLDivElement>(),
    currentSessionId: "s1",
    activeNewSessionRepoUrl: undefined,
    sidebarCollapsed: false,
    mobileSidebarOpen: false,
    onCloseMobileSidebar: () => {},
    onResumeSession: () => {},
    onArchiveSession: async () => {},
    onNewSessionForRepo: () => {},
    onToggleSidebarCollapse: () => {},
    repos: [],
    onAddRepo: () => {},
    onCreateNewRepo: () => {},
    toast: null,
    ...over,
  };
}

/**
 * Every route the breakpoint can be crossed on. `showHomeScreen` decides whether
 * the desktop tree carries a workspace column at all, and the other two decide
 * which mobile column is in front — so each combination is a different set of
 * occupied child slots for reconciliation to walk.
 */
const breakpointStates = [false, true].flatMap((showHomeScreen) =>
  [false, true].flatMap((showNewSessionView) =>
    (["chat", "preview"] as const).map((mobilePanel) => ({
      showHomeScreen,
      showNewSessionView,
      mobilePanel,
    })),
  ),
);

describe("AppLayout across the mobile breakpoint", () => {
  // `isMobile` is a media query, so it flips several times during one drag of a
  // window edge. A Fragment against a div here rebuilt the chat column each time.
  it.each(breakpointStates)(
    "reuses the chat column instead of remounting it (home $showHomeScreen, new $showNewSessionView, panel $mobilePanel)",
    (state) => {
      const mounts = { count: 0 };
      const chatPanel = <CountingChatPanel mounts={mounts} />;
      const at = (isMobile: boolean) => <AppLayout {...layoutProps({ ...state, isMobile, chatPanel })} />;
      const { rerender } = render(at(false));

      // A counter that can never report a mount reports zero for free.
      expect(mounts.count).toBe(1);
      const scroller = screen.getByTestId("transcript-scroller");
      scroller.scrollTop = 240;

      rerender(at(true));
      expect(mounts.count).toBe(1);
      expect(screen.getByTestId("transcript-scroller")).toBe(scroller);
      expect(scroller.scrollTop).toBe(240);

      rerender(at(false));
      expect(mounts.count).toBe(1);
      expect(screen.getByTestId("transcript-scroller")).toBe(scroller);
      expect(scroller.scrollTop).toBe(240);
    },
  );

  it("still swaps the mobile chrome in and out around it", () => {
    const drawer = '[role="dialog"][aria-label="Sessions"]';
    const { rerender, container } = render(
      <AppLayout {...layoutProps({ isMobile: false, chatPanel: <div>chat</div> })} />,
    );
    expect(container.querySelector(drawer)).toBeNull();

    rerender(<AppLayout {...layoutProps({ isMobile: true, chatPanel: <div>chat</div> })} />);
    expect(container.querySelector(drawer)).not.toBeNull();

    rerender(<AppLayout {...layoutProps({ isMobile: false, chatPanel: <div>chat</div> })} />);
    expect(container.querySelector(drawer)).toBeNull();
  });
});

describe("AppLayout host CPU pill", () => {
  const cpu = { usedPercent: 15, cores: 16 };

  it("sits directly before the Docker memory pill", () => {
    useUiStore.setState({ hostCpu: cpu });
    render(
      <AppLayout {...layoutProps({ dockerMemory: { usedBytes: 2 * 1024 ** 3, totalBytes: 8 * 1024 ** 3 } })} />,
    );

    expect(screen.getByText("CPU 15% / 16 cores").nextElementSibling).toHaveTextContent("2.0 GB / 8.0 GB");
  });

  it("is absent until the server has sent a reading", () => {
    render(<AppLayout {...layoutProps({ processStartedAt: Date.now() })} />);

    expect(screen.queryByText(/^CPU /)).toBeNull();
  });

  it("offers the collapsed status button when it is the only status there is", () => {
    render(<AppLayout {...layoutProps({})} />);
    expect(screen.queryByRole("button", { name: "Status" })).toBeNull();

    act(() => useUiStore.setState({ hostCpu: cpu }));
    expect(screen.getByRole("button", { name: "Status" })).toBeInTheDocument();
  });

  it("takes a pill's worth of room, so one account beside it goes inline from lg, not sm", () => {
    const now = Date.now();
    useSettingsStore.getState().setProviderAccounts([
      { id: "acct-work", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Work", isPrimary: true, status: "ready", createdAt: now, updatedAt: now },
    ]);
    const inlineGroupOf = (text: RegExp) => screen.getByText(text).parentElement!.className;

    const { unmount } = render(<AppLayout {...layoutProps({ processStartedAt: now })} />);
    expect(inlineGroupOf(/^\d+m$/)).toBe(statusGroupBreakpoint(1).statusInline);
    unmount();

    useUiStore.setState({ hostCpu: cpu });
    render(<AppLayout {...layoutProps({ processStartedAt: now })} />);
    expect(inlineGroupOf(/^CPU /)).toBe(statusGroupBreakpoint(2).statusInline);
  });
});

describe("useSubscriptionPillCount", () => {
  const now = Date.now();

  it("counts connected accounts, including ones that have never reported usage", () => {
    useSettingsStore.getState().setProviderAccounts([
      { id: "acct-work", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Work", isPrimary: true, status: "ready", createdAt: now, updatedAt: now },
      { id: "acct-personal", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Personal", isPrimary: false, status: "ready", createdAt: now, updatedAt: now },
    ]);

    const { result } = renderHook(() => useSubscriptionPillCount({}));
    expect(result.current).toBe(2);
  });

  it("counts a reserved route that only the snapshot map knows about", () => {
    const limits: SubscriptionLimitsMap = {
      "anthropic:sub": {
        "claude-env-oauth": {
          serviceId: "anthropic",
          billingMode: "sub",
          routeId: "claude-env-oauth",
          plan: null,
          session: null,
          weekly: null,
          fetchedAt: now,
        },
      },
    };

    const { result } = renderHook(() => useSubscriptionPillCount(limits));
    expect(result.current).toBe(1);
  });

  it("is zero with nothing connected, which leaves the header untouched", () => {
    const { result } = renderHook(() => useSubscriptionPillCount({}));
    expect(result.current).toBe(0);
  });
});
