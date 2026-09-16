/**
 * The voice-note webhook: one URL and one bearer token, saved together
 * (docs/308-data-driven-settings inventory.md P9, P13, reqs 3 and 4).
 *
 * **This is the first component two declarations share**, and it is what settled
 * how such a pair is written. The two halves are one credential stored by one
 * request, so neither could carry the Save and neither could carry the other's
 * field. The answer is the one the design already had, in two halves:
 *
 *  - The store became a machine-readable **address**, as `own-route` did for the
 *    release channel (P2). Two declarations name the same `path` and differ only
 *    in the `bodyField` they occupy — which is what says they share a write, in
 *    the declarations rather than in this file.
 *  - `commitSettings` takes its **destination from the declarations** rather than
 *    assuming `PUT /api/settings`. It already sent several settings in one
 *    request; all that changed is where that one request goes.
 *
 * So the Save here names two keys and no path, no method and no payload — the
 * same thing a per-row Save could not have done, and the reason requirement 3
 * holds: what is custom is the two boxes, the button that belongs to neither of
 * them, and the status line.
 *
 * It is **always visible** now (req 4, P13): it used to render only when delivery
 * was external or both, which hid the thing you have to configure BEFORE the
 * mode it belongs to can do anything.
 */

import { useState } from "react";
import { Button } from "../../ui/button.js";
import { useSettingsStore } from "../../../stores/settings-store.js";
import { useUiStore } from "../../../stores/ui-store.js";
import { ownRouteOf } from "../../../stores/setting-values.js";
import { commitSettings, useSettingDraft } from "../declared-setting.js";
import { bindSetting, settingCopy, settingOf } from "../setting-binding.js";
import { inputClass } from "../shared.js";
import type { SettingKey } from "../../../../server/shared/settings-catalogue/index.js";

const URL_KEY = "voice.webhook.url" as SettingKey;
const TOKEN_KEY = "voice.webhook.token" as SettingKey;

/** The address both halves declare — the same one `commitSettings` writes to. */
const WEBHOOK_PATH = ownRouteOf(settingOf(URL_KEY))?.path ?? "";

function Field({
  settingKey,
  id,
  type,
  value,
  placeholder,
  onChange,
}: {
  settingKey: SettingKey;
  id: string;
  type: string;
  value: string;
  placeholder: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <label
        className="block text-xs text-(--color-text-secondary)"
        htmlFor={id}
        data-setting-label={settingKey}
      >
        {settingCopy(settingKey).label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => { onChange(e.target.value); }}
        placeholder={placeholder}
        className={inputClass}
        data-testid={id}
        {...bindSetting(settingKey)}
      />
    </div>
  );
}

export function VoiceWebhook() {
  const url = useSettingDraft(URL_KEY);
  const token = useSettingDraft(TOKEN_KEY);
  const [writing, setWriting] = useState(false);

  const urlText = typeof url.value === "string" ? url.value : "";
  const tokenText = typeof token.value === "string" ? token.value : "";
  // A webhook exists exactly when a url is stored, which is why the read answers
  // one field: a second `configured` flag would be the same fact twice.
  const stored = useSettingsStore((s) => s.settingValues[URL_KEY]);
  const configured = typeof stored === "string" && stored.length > 0;

  /*
    The drafts go out **unnormalised**, and that is deliberate. The route trims,
    the record takes what it echoed, and a draft settles by matching the value
    that was SENT — so trimming here would send `"secret"` while the draft still
    held `" secret "`, and settling would read that as typing since the save and
    keep a stored credential in the box. Normalisation belongs to the writer.
  */
  const save = async () => {
    setWriting(true);
    try {
      await commitSettings([[URL_KEY, urlText], [TOKEN_KEY, tokenText]]);
    } finally {
      setWriting(false);
    }
  };

  /*
    Removing is an operation on the address rather than a value write — there is
    no empty url the route stores — so it is this component's, as a panel's
    remove is. What it must not leave behind is the edit that was on screen when
    it started: an unsaved url with nothing left to save it to would put the
    deleted webhook back in the box.

    It settles rather than dropping, for the reason every other write does: a
    removal is a round trip and typing does not stop for it, so a box typed in
    SINCE the click keeps what was typed. Dropping outright erased it.
  */
  const remove = async () => {
    setWriting(true);
    const discarded = [{ key: URL_KEY, value: urlText }, { key: TOKEN_KEY, value: tokenText }];
    try {
      const res = await fetch(WEBHOOK_PATH, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as Record<string, unknown>;
      const { setSettingValue, settleSettingDrafts } = useSettingsStore.getState();
      if (typeof body.url === "string") setSettingValue(URL_KEY, body.url);
      settleSettingDrafts(discarded);
    } catch (err) {
      useUiStore.getState().setToast({ message: "Failed to remove the voice note webhook" });
      console.error("[settings] removing the voice webhook failed:", err);
    } finally {
      setWriting(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-(--color-border-secondary) p-3">
      <div>
        <span className="text-sm text-(--color-text-primary)">Webhook</span>
        <p className="text-xs text-(--color-text-tertiary) mt-0.5" data-setting-description={URL_KEY}>
          {settingCopy(URL_KEY).description}
        </p>
        <p className="text-xs text-(--color-text-tertiary) mt-0.5" data-setting-description={TOKEN_KEY}>
          {settingCopy(TOKEN_KEY).description}
        </p>
      </div>

      <Field
        settingKey={URL_KEY}
        id="voice-webhook-url"
        type="url"
        value={urlText}
        placeholder="https://example.com/voice-notes"
        onChange={url.set}
      />
      <Field
        settingKey={TOKEN_KEY}
        id="voice-webhook-token"
        type="password"
        value={tokenText}
        placeholder={configured ? "•••••• (leave blank to keep)" : "token"}
        onChange={token.set}
      />

      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="md"
          disabled={writing || !urlText.trim()}
          onClick={() => { void save(); }}
          data-testid="voice-webhook-save"
          {...bindSetting(URL_KEY)}
        >
          {writing ? "Saving…" : "Save webhook"}
        </Button>
        {configured && (
          <Button
            variant="secondary"
            size="md"
            disabled={writing}
            onClick={() => { void remove(); }}
            data-testid="voice-webhook-clear"
            aria-label="Remove the voice note webhook"
            {...bindSetting(URL_KEY)}
          >
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}
