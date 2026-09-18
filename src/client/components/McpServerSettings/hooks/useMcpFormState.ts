import { useState } from "react";
import { useMcpStore } from "../../../stores/mcp-store.js";
import {
  EMPTY_FORM,
  buildPayload,
  formFromServer,
  type FormState,
} from "../utils/payload.js";
import type { McpServerConfig } from "../../../../server/shared/types.js";

// The name becomes part of an environment-variable identifier.
const NAME_RE = /^[a-z][a-z0-9]*$/;

export function useMcpFormState() {
  const addServer = useMcpStore((s) => s.addServer);
  const updateServer = useMcpStore((s) => s.updateServer);

  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function startAdd() {
    setForm({ ...EMPTY_FORM });
    setFormError(null);
  }

  function startEdit(server: McpServerConfig) {
    setForm(formFromServer(server));
    setFormError(null);
  }

  function cancel() {
    setForm(null);
  }

  function updateForm(patch: Partial<FormState>) {
    setForm((f) => (f ? { ...f, ...patch } : f));
  }

  async function save() {
    if (!form) return;
    if (!NAME_RE.test(form.name)) {
      setFormError("Name must be lowercase alphanumeric, starting with a letter (no hyphens).");
      return;
    }
    if (form.type === "stdio" && !form.command.trim()) {
      setFormError("Command is required for stdio servers.");
      return;
    }
    if (form.type === "http" && !form.url.trim()) {
      setFormError("URL is required for HTTP servers.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const { config, secrets } = buildPayload(form);
      if (form.editingId) {
        await updateServer(form.editingId, config, secrets);
      } else {
        await addServer(config, secrets);
      }
      setForm(null);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return { form, formError, saving, startAdd, startEdit, cancel, updateForm, save };
}
