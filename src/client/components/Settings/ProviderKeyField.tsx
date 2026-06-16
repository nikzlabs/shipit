import { useState } from "react";
import { Button } from "../ui/button.js";
import type { VoiceProviderInfo } from "../../../server/shared/voice-catalog.js";
import { inputClass } from "./shared.js";

/**
 * One server-side API key for a single voice provider. The key is POSTed to
 * /api/voice/credentials and never read back — status is a boolean derived
 * from the `configured` provider-id list. Mirrors the threat model: paid keys
 * live only on the server.
 */
export function ProviderKeyField({
  provider,
  configured,
  onChanged,
}: {
  provider: VoiceProviderInfo;
  configured: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const apiKey = draft.trim();
    if (!apiKey) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/voice/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: provider.id, apiKey }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setDraft("");
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save key");
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/voice/credentials", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: provider.id }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't clear key");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-sm text-(--color-text-primary)">{provider.label}</span>
        <span
          className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs ${
            configured
              ? "bg-(--color-success)/10 text-(--color-success)"
              : "bg-(--color-bg-hover) text-(--color-text-tertiary)"
          }`}
          data-testid={`voice-key-status-${provider.id}`}
        >
          {configured ? "Key configured ✓" : "Not set"}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="password"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={provider.keyPlaceholder ?? "API key"}
          className={inputClass}
          data-testid={`voice-key-input-${provider.id}`}
          autoComplete="off"
        />
        <Button variant="primary" size="md" disabled={!draft.trim() || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </Button>
        {configured && (
          <Button
            variant="ghost"
            size="md"
            disabled={saving}
            onClick={() => void clear()}
            className="text-(--color-error) hover:text-(--color-error)"
          >
            Clear
          </Button>
        )}
      </div>
      {error && <p className="text-xs text-(--color-error)">{error}</p>}
    </div>
  );
}
