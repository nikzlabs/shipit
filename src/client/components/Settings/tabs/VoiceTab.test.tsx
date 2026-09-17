import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VoiceTab } from "./VoiceTab.js";
import { useSettingsStore } from "../../../stores/settings-store.js";
import { useUiStore } from "../../../stores/ui-store.js";
import { settingCopy, settingOptions } from "../setting-copy.js";
import { useVoiceKeyStatus } from "../../../voice/voice-key-status.js";

/**
 * The cleanup status line and the voice-key adoption offer
 * (docs/299-direct-provider-calls req 5, and req 6 for what a user sees when
 * nothing can clean). One test per state the tab renders, including the state
 * where cleanup cannot run at all — which is where the offer lives.
 */

interface CleanupModel {
  serviceName: string;
  modelId: string;
  modelLabel: string;
  execution: "direct" | "harness";
  harnessName?: string;
}

let cleanupBody: { model: CleanupModel | null; adoptableVoiceKey: unknown };
let fetchCalls: { url: string; method: string; body: unknown }[] = [];
let adoptResponse: { ok: boolean; status: number; body: unknown } = { ok: true, status: 200, body: {} };
/** Which providers have a key stored, as the key list reads it on mount. */
let configuredKeys: string[] = [];

const OFFER = { providerId: "openai", providerLabel: "OpenAI", serviceName: "OpenAI" };

function stubFetch() {
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    fetchCalls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    if (url === "/api/voice/cleanup/status") {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(cleanupBody) });
    }
    if (url === "/api/voice/credentials/status") {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ configured: configuredKeys }) });
    }
    if (url === "/api/credential-routes/adopt-voice-key") {
      return Promise.resolve({
        ok: adoptResponse.ok,
        status: adoptResponse.status,
        json: () => Promise.resolve(adoptResponse.body),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  });
}

async function renderTab() {
  render(<VoiceTab />);
  await waitFor(() => {
    const settled = screen.queryByTestId("voice-cleanup-status")
      ?? screen.queryByTestId("voice-key-adoption-offer");
    expect(settled).toBeTruthy();
  });
}

beforeEach(() => {
  fetchCalls = [];
  configuredKeys = [];
  cleanupBody = { model: null, adoptableVoiceKey: null };
  adoptResponse = { ok: true, status: 200, body: {} };
  useSettingsStore.getState().setSettingValue("voice.cleanupEnabled", true);
  useUiStore.getState().setToast(null);
  useUiStore.getState().setSettingsTab("voice");
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useVoiceKeyStatus.setState({ configured: [] });
});

describe("VoiceTab cleanup status", () => {
  it("names the background-work model and says a direct call is quick", async () => {
    cleanupBody = {
      model: { serviceName: "Anthropic", modelId: "haiku", modelLabel: "Haiku 4.5", execution: "direct" },
      adoptableVoiceKey: null,
    };
    await renderTab();

    const line = screen.getByTestId("voice-cleanup-status");
    expect(line.textContent).toContain("Cleaned by Haiku 4.5");
    expect(line.textContent).toContain("Background work");
    expect(line.textContent).toContain("Called directly, so it is quick.");
  });

  // A dictation is the one place where several seconds of silence reads as a
  // fault, so the harness case has to say the wait out loud.
  it("warns that a harness run takes a few seconds, and names what would fix it", async () => {
    cleanupBody = {
      model: {
        serviceName: "GLM (Z.ai)",
        modelId: "glm-5.3",
        modelLabel: "GLM-5.3",
        execution: "harness",
        harnessName: "Claude Code",
      },
      adoptableVoiceKey: null,
    };
    await renderTab();

    const line = screen.getByTestId("voice-cleanup-status");
    expect(line.textContent).toContain("Cleaned by GLM-5.3");
    expect(line.textContent).toContain("Runs through Claude Code, so it takes a few seconds.");
    expect(line.textContent).toContain("An API key for a model provider would make it quick.");
  });

  it("says cleanup cannot run, and offers nothing, where there is no key to adopt", async () => {
    await renderTab();

    expect(screen.getByTestId("voice-cleanup-status").textContent).toContain("cleanup can't run");
    expect(screen.queryByTestId("voice-key-adoption-offer")).toBeNull();
  });

  it("links the named model to the setting that chose it", async () => {
    cleanupBody = {
      model: { serviceName: "Anthropic", modelId: "haiku", modelLabel: "Haiku 4.5", execution: "direct" },
      adoptableVoiceKey: null,
    };
    await renderTab();

    await userEvent.click(screen.getByTestId("voice-cleanup-background-work-link"));

    expect(useUiStore.getState().settingsTab).toBe("services");
  });
});

describe("VoiceTab dictation languages", () => {
  // The agent reads the options off the declaration (docs/299 req 1), so what
  // the dialog offers has to be what the declaration says — this fails on a
  // divergence, and cannot speak to where the rendered list came from.
  it("offers exactly the declared options", async () => {
    await renderTab();

    const select = screen.getByRole("combobox", {
      name: settingCopy("voice.language").label,
    }) as HTMLSelectElement;
    const rendered = [...select.options].map((o) => ({ value: o.value, label: o.textContent }));

    expect(rendered).toEqual(
      settingOptions("voice.language").map((o) => ({ value: o.value, label: o.label })),
    );
    expect(rendered.length).toBeGreaterThan(1);
  });
});

describe("VoiceTab voice-key adoption offer", () => {
  beforeEach(() => {
    cleanupBody = { model: null, adoptableVoiceKey: OFFER };
  });

  // The offer already explains why cleanup cannot run, so the unavailable line
  // beside it would say the same thing twice.
  it("offers the key by name, and stands alone while it does", async () => {
    await renderTab();

    const offer = screen.getByTestId("voice-key-adoption-offer");
    expect(offer.textContent).toContain("Use your OpenAI key for cleanup too?");
    expect(screen.getByTestId("voice-key-adopt").textContent).toBe("Add it as a model provider");
    expect(screen.queryByTestId("voice-cleanup-status")).toBeNull();
  });

  it("adopts the key on request and re-reads what cleanup can now do", async () => {
    await renderTab();
    cleanupBody = {
      model: { serviceName: "OpenAI", modelId: "gpt-5.6-sol", modelLabel: "GPT-5.6 Sol", execution: "direct" },
      adoptableVoiceKey: null,
    };

    await userEvent.click(screen.getByTestId("voice-key-adopt"));

    await waitFor(() => {
      expect(screen.getByTestId("voice-cleanup-status").textContent).toContain("Cleaned by GPT-5.6 Sol");
    });
    const post = fetchCalls.find((c) => c.url === "/api/credential-routes/adopt-voice-key");
    expect(post?.method).toBe("POST");
    expect(post?.body).toEqual({ provider: "openai" });
    expect(screen.queryByTestId("voice-key-adoption-offer")).toBeNull();
  });

  /**
   * Declining writes nothing at all. Silently choosing a background-work model
   * on the user's behalf is what docs/252-custom-models req 9 reserves for
   * them, so the only thing "Not now" may do is leave cleanup unavailable — and
   * say so.
   */
  it("writes nothing when declined, and leaves the line saying cleanup can't run", async () => {
    await renderTab();

    await userEvent.click(screen.getByTestId("voice-key-adopt-decline"));

    expect(screen.queryByTestId("voice-key-adoption-offer")).toBeNull();
    expect(screen.getByTestId("voice-cleanup-status").textContent).toContain("cleanup can't run");
    expect(fetchCalls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("keeps the offer and reports the reason when adoption fails", async () => {
    adoptResponse = { ok: false, status: 409, body: { error: "There is no OpenAI voice key left to add as a model provider." } };
    await renderTab();

    await userEvent.click(screen.getByTestId("voice-key-adopt"));

    await waitFor(() => {
      expect(useUiStore.getState().toast?.message).toContain("no OpenAI voice key left");
    });
    expect(screen.getByTestId("voice-key-adoption-offer")).toBeTruthy();
  });
});

/**
 * Status a row carries rather than the tab (inventory.md P12). Both lines report
 * on the row above them, which a section note cannot do — it renders above the
 * whole group.
 */
describe("VoiceTab row status", () => {
  it("says which key the chosen dictation provider still needs", async () => {
    useSettingsStore.getState().setSettingValue("voice.sttProvider", "deepgram");
    await renderTab();

    expect(screen.getByText(/Add a Deepgram key above/)).toBeTruthy();
  });

  it("drops that line once the key is stored", async () => {
    useSettingsStore.getState().setSettingValue("voice.sttProvider", "deepgram");
    configuredKeys = ["deepgram"];
    await renderTab();

    await waitFor(() => {
      expect(screen.queryByText(/Add a Deepgram key above/)).toBeNull();
    });
  });

  it("puts the cleanup status under the cleanup toggle", async () => {
    cleanupBody = {
      model: { serviceName: "Anthropic", modelId: "haiku", modelLabel: "Haiku 4.5", execution: "direct" },
      adoptableVoiceKey: null,
    };
    await renderTab();

    const toggle = screen.getByRole("switch", { name: settingCopy("voice.cleanupEnabled").label });
    const status = screen.getByTestId("voice-cleanup-status");
    expect(toggle.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
