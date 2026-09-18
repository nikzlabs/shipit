/**
 * The first component two declarations share (docs/308-data-driven-settings
 * inventory.md P9, P13, reqs 3 and 4).
 *
 * What is under test is the decision this slice owns: **two settings at one
 * declared address are one request**, and the component that draws them names no
 * path, no method and no payload field. A test that asserted the URL string here
 * would be asserting the same literal the component would have had to hold, so
 * the expectations below are read off the declarations.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DeclaredSettings } from "../DeclaredSettings.js";
import { useSettingsStore } from "../../../stores/settings-store.js";
import { useUiStore } from "../../../stores/ui-store.js";
import { initialSettingValues, ownRouteOf } from "../../../stores/setting-values.js";
import { resetDeclaredSaves } from "../declared-setting.js";
import { settingCopy, settingOf } from "../setting-copy.js";
import type { SettingKey } from "../../../../server/shared/settings-catalogue/index.js";

const URL_KEY = "voice.webhook.url" as SettingKey;
const TOKEN_KEY = "voice.webhook.token" as SettingKey;
const ADDRESS = ownRouteOf(settingOf(URL_KEY))!;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetDeclaredSaves();
  fetchMock = vi.fn((_url: string, init?: { body?: string }) => Promise.resolve({
    ok: true,
    // The route trims and answers the STORED url, which is why the component
    // sends what was typed rather than normalising it first.
    json: () => Promise.resolve(
      init?.body ? { url: ((JSON.parse(init.body) as { url?: string }).url ?? "").trim() } : { url: "" },
    ),
  }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useSettingsStore.setState({ settingValues: initialSettingValues(), settingDrafts: {} });
  useUiStore.getState().setToast(null);
});

const urlBox = () => screen.getByLabelText(settingCopy(URL_KEY).label);
const tokenBox = () => screen.getByLabelText(settingCopy(TOKEN_KEY).label);
const saveButton = () => screen.getByRole("button", { name: "Save webhook" });
type Call = [string, { method: string; body: string }];
/** The key list on the same tab reads its own status, so only this address counts. */
const callsHere = () =>
  (fetchMock.mock.calls as Call[]).filter(([url]) => url === ADDRESS.path);

function seedUrl(url: string) {
  useSettingsStore.getState().setSettingValue(URL_KEY, url);
}

describe("the voice webhook is one write at one declared address", () => {
  it("renders once for the two declarations that name it", () => {
    render(<DeclaredSettings tab="voice" />);

    expect(screen.getAllByRole("button", { name: "Save webhook" })).toHaveLength(1);
    // Both finders are `getBy…`, so each throws on a second box as well as on none.
    expect(urlBox()).toBeInTheDocument();
    expect(tokenBox()).toBeInTheDocument();
  });

  it("sends both halves in one request, each under its declared body field", async () => {
    render(<DeclaredSettings tab="voice" />);

    fireEvent.change(urlBox(), { target: { value: "https://hook.example/notes" } });
    fireEvent.change(tokenBox(), { target: { value: "s3cret" } });
    await userEvent.click(saveButton());

    await waitFor(() => { expect(callsHere()).toHaveLength(1); });
    const [, init] = callsHere()[0]!;
    expect(init.method).toBe(ADDRESS.method);
    expect(JSON.parse(init.body)).toEqual({ url: "https://hook.example/notes", token: "s3cret" });
  });

  // The record takes what the server echoed, and the server echoes no token —
  // so the box empties because nothing is stored for it, not because the
  // component cleared it by hand.
  it("keeps the stored url and holds no token afterwards", async () => {
    render(<DeclaredSettings tab="voice" />);

    fireEvent.change(urlBox(), { target: { value: "https://hook.example/notes" } });
    fireEvent.change(tokenBox(), { target: { value: "s3cret" } });
    await userEvent.click(saveButton());

    await waitFor(() => {
      expect(useSettingsStore.getState().settingValues[URL_KEY]).toBe("https://hook.example/notes");
    });
    expect(useSettingsStore.getState().settingValues[TOKEN_KEY]).toBe("");
    expect(urlBox()).toHaveValue("https://hook.example/notes");
    expect(tokenBox()).toHaveValue("");
  });

  it("keeps both drafts when the write does not land", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: () => Promise.resolve({}) });
    render(<DeclaredSettings tab="voice" />);

    fireEvent.change(urlBox(), { target: { value: "https://hook.example/notes" } });
    fireEvent.change(tokenBox(), { target: { value: "s3cret" } });
    await userEvent.click(saveButton());

    await waitFor(() => { expect(useUiStore.getState().toast).not.toBeNull(); });
    expect(urlBox()).toHaveValue("https://hook.example/notes");
    expect(tokenBox()).toHaveValue("s3cret");
    expect(useSettingsStore.getState().settingValues[URL_KEY]).toBe("");
  });

  it("removes the webhook at the same address, and drops the edit with it", async () => {
    seedUrl("https://hook.example/notes");
    render(<DeclaredSettings tab="voice" />);
    fireEvent.change(tokenBox(), { target: { value: "typed-but-unsaved" } });

    await userEvent.click(screen.getByRole("button", { name: "Remove the voice note webhook" }));

    await waitFor(() => {
      expect(useSettingsStore.getState().settingValues[URL_KEY]).toBe("");
    });
    expect(callsHere()).toHaveLength(1);
    expect(callsHere()[0]![1].method).toBe("DELETE");
    expect(urlBox()).toHaveValue("");
    expect(tokenBox()).toHaveValue("");
  });

  /*
    The route trims and the record takes what it echoed, so the draft has to
    settle against the value that was SENT. Trimming in the component sent
    `"secret"` while the draft still held `" secret "`, and settling read that as
    typing since the save — leaving a stored credential in a password box that
    the next save would send again instead of the blank that keeps it.
  */
  it("clears a token that needed trimming, and stores the trimmed url", async () => {
    render(<DeclaredSettings tab="voice" />);

    fireEvent.change(urlBox(), { target: { value: "  https://hook.example/notes  " } });
    fireEvent.change(tokenBox(), { target: { value: "  s3cret  " } });
    await userEvent.click(saveButton());

    await waitFor(() => {
      expect(useSettingsStore.getState().settingValues[URL_KEY]).toBe("https://hook.example/notes");
    });
    expect(tokenBox()).toHaveValue("");
    expect(urlBox()).toHaveValue("https://hook.example/notes");
  });

  /*
    The Save is disabled while it writes, and that is not enough on its own: the
    button's state belongs to a component, and switching tabs re-mounts it
    enabled while the request is still out. So two saves overlap, and the older
    answer must not put the older url in the record with the server holding the
    newer.
  */
  it("ignores an older save's answer when a newer one has already gone out", async () => {
    const settle: ((url: string) => void)[] = [];
    fetchMock.mockImplementation((url: string) =>
      url === ADDRESS.path
        ? new Promise((resolve) => {
            settle.push((stored) => {
              resolve({ ok: true, json: () => Promise.resolve({ url: stored }) });
            });
          })
        : Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
    render(<DeclaredSettings tab="voice" />);

    fireEvent.change(urlBox(), { target: { value: "https://hook.example/first" } });
    await userEvent.click(saveButton());
    cleanup();                       // the tab switch: the button's state goes
    render(<DeclaredSettings tab="voice" />);
    fireEvent.change(urlBox(), { target: { value: "https://hook.example/second" } });
    await userEvent.click(saveButton());
    await waitFor(() => { expect(settle).toHaveLength(2); });

    // The newer request answers first, then the older one.
    settle[1]!("https://hook.example/second");
    settle[0]!("https://hook.example/first");
    await waitFor(() => {
      expect(useSettingsStore.getState().settingValues[URL_KEY])
        .toBe("https://hook.example/second");
    });
    expect(useSettingsStore.getState().settingValues[URL_KEY])
      .toBe("https://hook.example/second");
  });

  // A removal is a round trip, and typing does not stop for it: what was on
  // screen when Remove was pressed goes, and what was typed since stays.
  it("keeps a replacement typed while the removal was in flight", async () => {
    seedUrl("https://hook.example/notes");
    let finish: (() => void) | undefined;
    fetchMock.mockImplementation((url: string) =>
      url === ADDRESS.path
        ? new Promise((resolve) => {
            finish = () => { resolve({ ok: true, json: () => Promise.resolve({ url: "" }) }); };
          })
        : Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
    render(<DeclaredSettings tab="voice" />);

    await userEvent.click(screen.getByRole("button", { name: "Remove the voice note webhook" }));
    fireEvent.change(urlBox(), { target: { value: "https://hook.example/replacement" } });
    finish!();

    await waitFor(() => {
      expect(useSettingsStore.getState().settingValues[URL_KEY]).toBe("");
    });
    expect(urlBox()).toHaveValue("https://hook.example/replacement");
  });

  it("offers no Remove while nothing is stored", () => {
    render(<DeclaredSettings tab="voice" />);

    expect(screen.queryByRole("button", { name: "Remove the voice note webhook" })).toBeNull();
  });

  /*
    req 4 / P13 — it used to render only when delivery was external or both,
    which hid the thing that has to be configured before either mode does
    anything.
  */
  it("is on screen whatever the delivery mode is", () => {
    useSettingsStore.getState().setSettingValue("voice.deliveryMode" as SettingKey, "native");
    render(<DeclaredSettings tab="voice" />);

    expect(urlBox()).toBeTruthy();
    expect(tokenBox()).toBeTruthy();
  });
});
