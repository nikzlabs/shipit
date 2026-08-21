/**
 * docs/264 phase 2 (reqs 5, 8, 9, 17, 18) — **Settings is the only way a role is
 * created.**
 *
 * Choosing a role's params means choosing among the services, models, harnesses
 * and levels *this install* offers, and the UI is the only surface that can show
 * that set (req 5). So this tab is where roles come from.
 *
 * **Two parts, not one list**, and the split is honest rather than untidy. Every
 * other role is one pinned tuple, while the reviewer's params are docs/261's
 * **two ranked candidate slots** (req 2) — no single row of controls can
 * configure that, and the reviewer can be neither renamed nor deleted. So the
 * pinned roles come first as a list, and the Reviewer follows in its own section
 * with the two slot cards exactly as docs/261 ships them — the roles a user
 * creates lead, and the one special case sits after them. Uniformity holds where
 * it is true (one store, one lookup, one refusal) and stops at the screen.
 *
 * **A row is a summary, never a control** (req 17): the name, what it is for, and
 * what it resolves to, plus open and delete. Editing all of it happens in the
 * {@link RoleEditor}, in one write.
 *
 * **Nothing is optimistic.** The server resolves every role against one
 * credential snapshot and the response replaces the list — a local guess would
 * have to reimplement which harness can carry which model, which is exactly the
 * second implementation this feature keeps out of the browser.
 */

import { useState } from "react";
import {
  BaseballCapIcon,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../../../design-tokens.js";
import { Badge } from "../../ui/badge.js";
import { Button } from "../../ui/button.js";
import { BillingModePill } from "../../BillingModePill.js";
import { useSettingsStore } from "../../../stores/settings-store.js";
import { useUiStore } from "../../../stores/ui-store.js";
import { ReviewerSection } from "./ReviewerSection.js";
import { RoleEditor } from "../roles/RoleEditor.js";
import type { AgentOption } from "../../../agent-types.js";
import type { RoleView, RoleWrite } from "../../../../server/shared/types/agent-types.js";

/**
 * Re-read the roles from the server.
 *
 * Used only after an ambiguous write failure — a dropped connection cannot say
 * whether the server committed — exactly as `ReviewerSection` does. Failing
 * quietly is right: this runs behind an error the user can already see, and a
 * second message about the reconciliation would name a symptom rather than a
 * cause.
 */
async function refetchRoles(): Promise<void> {
  try {
    const res = await fetch("/api/bootstrap");
    if (!res.ok) return;
    const data = (await res.json()) as { settings?: { roles?: RoleView[] } };
    if (data.settings?.roles) useSettingsStore.getState().setRoles(data.settings.roles);
  } catch {
    // Still offline. The next `agent_list` push or reload reconciles.
  }
}

/** Which role the editor is open on: an existing one, or a role being created. */
interface EditorTarget {
  role: RoleView | undefined;
}

export function RolesTab({ agentList = [] }: { agentList?: AgentOption[] }) {
  const roles = useSettingsStore((s) => s.roles);
  const [editing, setEditing] = useState<EditorTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const reviewer = roles.find((role) => role.reserved);
  const pinned = roles.filter((role) => !role.reserved);

  /**
   * One write of the whole role (req 17), through the existing settings mutation
   * surface — not a route of its own.
   *
   * The response carries every role back, resolved, and replaces the list. A
   * refusal stays in the editor rather than becoming a toast the dialog covers:
   * it names the parameter that is wrong (req 6), which is only useful beside
   * the control that sets it.
   */
  const save = async (name: string, write: RoleWrite | null): Promise<boolean> => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roles: { [name]: write } }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const result = (await res.json()) as { roles?: RoleView[] };
      if (result.roles) useSettingsStore.getState().setRoles(result.roles);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save the role";
      // A delete has no dialog to report into, so it reports where the user is.
      if (write === null) useUiStore.getState().setToast({ message });
      else setError(message);
      console.error("[settings] save role failed:", err);
      // A failure is AMBIGUOUS — the connection can drop after the server
      // committed — so the list is not left holding a guess. Re-read what the
      // server actually has, the way `ReviewerSection` does after its own
      // failed write. It matters more here: a rename that committed and lost
      // its response would leave the editor offering to retry under a
      // `previousName` the server no longer knows, which is refused, and the
      // user would need a reload to find out why.
      void refetchRoles();
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-5 py-4 flex flex-col gap-5 overflow-y-auto h-full" data-testid="roles-tab">
      <section className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {/* docs/272-user-selectable-roles req 16 — the SAME mark the composer shows, beside
                the word it stands for. That is the whole reason it is here: in
                the composer the mark is unlabelled, and a mark nobody has seen
                is a puzzle. Roles are created here, so this is where a user
                meets it with its name — neither half of the rule works alone. */}
            <h3 className="flex items-center gap-1.5 text-sm font-medium text-(--color-text-primary)">
              <BaseballCapIcon
                size={ICON_SIZE.SM}
                className="shrink-0 text-(--color-text-tertiary)"
                aria-hidden
              />
              Roles
            </h3>
            <p className="mt-0.5 text-xs text-(--color-text-tertiary)">
              Named units of agent work — each one naming the harness that runs it, the model it
              runs, the reasoning level, and optionally what the job is. Pick one in the composer
              to start a session on it, or name it to an agent.
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0"
            onClick={() => { setError(undefined); setEditing({ role: undefined }); }}
            data-testid="role-new"
          >
            <PlusIcon size={ICON_SIZE.XS} />
            New role
          </Button>
        </div>

        {pinned.length === 0 ? (
          <p
            className="rounded-md border border-dashed border-(--color-border-secondary) p-6 text-center text-sm text-(--color-text-secondary)"
            data-testid="roles-empty"
          >
            No roles yet. The reviewer below is always available; add a role for any other job you
            start an agent for.
          </p>
        ) : (
          pinned.map((role) => (
            <RoleRow
              key={role.name}
              role={role}
              busy={busy}
              onOpen={() => { setError(undefined); setEditing({ role }); }}
              onDelete={() => void save(role.name, null)}
            />
          ))
        )}
      </section>

      {/* The reviewer follows the roles it is one of. The divider is applied
          here rather than inside `ReviewerSection`, so the section stays a
          block that does not know what precedes it. */}
      <div className="border-t border-(--color-border-secondary) pt-4">
        <ReviewerSection
          agentList={agentList}
          metadata={
            reviewer && (
              <RoleMetadata
                role={reviewer}
                onEdit={() => { setError(undefined); setEditing({ role: reviewer }); }}
              />
            )
          }
        />
      </div>

      {editing && (
        <RoleEditor
          // Remounts on target change, so the draft never carries a previous
          // role's fields into the next one.
          key={editing.role?.name ?? "__new__"}
          role={editing.role}
          agentList={agentList}
          busy={busy}
          error={error}
          onCancel={() => { setEditing(null); setError(undefined); }}
          onSave={(name, write) => {
            void (async () => {
              if (await save(name, write)) setEditing(null);
            })();
          }}
        />
      )}
    </div>
  );
}

/**
 * The description and standing instructions of a role, above its params.
 *
 * Shared by the Reviewer section, whose params are the two slot cards — reqs 8
 * and 9 apply to it exactly as they do to any other role, and its metadata is
 * the half of it that IS editable.
 */
function RoleMetadata({ role, onEdit }: { role: RoleView; onEdit: () => void }) {
  return (
    <div className="flex items-start justify-between gap-2" data-testid="reviewer-metadata">
      <div className="min-w-0 text-xs text-(--color-text-secondary)">
        <p data-testid="reviewer-description">
          {role.description || <span className="text-(--color-text-tertiary)">No description</span>}
        </p>
        {role.prompt && (
          <p
            className="mt-1 line-clamp-2 whitespace-pre-wrap text-(--color-text-tertiary)"
            data-testid="reviewer-prompt"
          >
            {role.prompt}
          </p>
        )}
      </div>
      <Button variant="ghost" size="sm" className="shrink-0" onClick={onEdit} data-testid="reviewer-edit">
        <PencilSimpleIcon size={ICON_SIZE.XS} />
        Edit
      </Button>
    </div>
  );
}

/**
 * One pinned role, as a summary.
 *
 * **An unresolved role renders its raw stored tuple** and keeps both controls.
 * That is the case a picker-based list gets wrong by default: with no eligible
 * row to match, a resolution-only row would either disappear or show the first
 * available value, and a role the user cannot see is a role they cannot fix.
 * Which of the three unavailable states it is decides the sentence, because the
 * remedy differs in each — an edit, a reconnected service, or nothing at all.
 */
function RoleRow({
  role,
  busy,
  onOpen,
  onDelete,
}: {
  role: RoleView;
  busy: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const { resolved } = role;
  const stored = role.params.kind === "pinned" ? role.params : undefined;
  return (
    <div
      className="shrink-0 overflow-hidden rounded-md border border-(--color-border-secondary) p-3"
      data-testid={`role-row-${role.name}`}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="truncate text-sm font-medium text-(--color-text-primary)">{role.name}</h4>
            {role.unavailableReason && (
              <Badge
                variant={role.unavailableReason === "stranded" ? "error" : "warning"}
                className="px-1.5 text-[10px]"
                data-testid={`role-state-${role.name}`}
              >
                {UNAVAILABLE_LABEL[role.unavailableReason]}
              </Badge>
            )}
          </div>
          {role.description && (
            <p className="mt-0.5 truncate text-xs text-(--color-text-secondary)">
              {role.description}
            </p>
          )}
          <div
            className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-(--color-text-tertiary)"
            data-testid={`role-resolution-${role.name}`}
          >
            {resolved ? (
              <>
                <span>{resolved.serviceName}</span>
                <BillingModePill billingMode={resolved.billingMode} />
                <span>
                  · {resolved.label}, running on {resolved.harnessName} at{" "}
                  {resolved.reasoningLabel ?? resolved.reasoningEffort ?? "Default"}
                </span>
              </>
            ) : (
              stored && (
                <>
                  {/*
                    The RAW stored tuple, ids and all — there is no resolution to
                    render, and a role that vanished from the list because its
                    model was retired could never be repaired.
                  */}
                  <span data-testid={`role-stored-${role.name}`}>
                    {stored.serviceId}
                  </span>
                  <BillingModePill billingMode={stored.billingMode} />
                  <span>
                    · {stored.modelId}, on {stored.harnessId} at{" "}
                    {stored.reasoningEffort ?? "Default"}
                  </span>
                </>
              )
            )}
          </div>
          {role.unavailableReason && (
            <p
              className="mt-1 flex items-start gap-1.5 text-xs text-(--color-warning)"
              data-testid={`role-unavailable-${role.name}`}
            >
              <WarningIcon size={ICON_SIZE.XS} className="mt-0.5 shrink-0" />
              <span>{unavailableDetail(role)}</span>
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={onOpen}
            data-testid={`role-open-${role.name}`}
          >
            <PencilSimpleIcon size={ICON_SIZE.XS} />
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={onDelete}
            aria-label={`Delete ${role.name}`}
            className="text-(--color-error) hover:text-(--color-error)"
            data-testid={`role-delete-${role.name}`}
          >
            <TrashIcon size={ICON_SIZE.XS} />
          </Button>
        </div>
      </div>
    </div>
  );
}

const UNAVAILABLE_LABEL: Record<string, string> = {
  stranded: "Needs fixing",
  disconnected: "Service disconnected",
  quota_exhausted: "Quota spent",
};

/**
 * Why it cannot run, in the words of the remedy — three states, three different
 * places to go. Only `stranded` is the role's own fault; telling a user to edit
 * a perfectly good role because a subscription is spent would be wrong.
 */
function unavailableDetail(role: RoleView): string {
  switch (role.unavailableReason) {
    case "stranded":
      return role.invalidField
        ? `Its ${FIELD_LABEL[role.invalidField]} is no longer valid — edit the role to re-point it.`
        : "Part of what it names no longer exists — edit the role to re-point it.";
    case "disconnected":
      return "The service it names has no usable credential — reconnect it under Services. The role itself is fine.";
    case "quota_exhausted":
      return role.earliestResetAt
        ? `Its subscription is spent until ${new Date(role.earliestResetAt).toLocaleString()}. Nothing to fix.`
        : "Its subscription is spent and recovers when the quota resets. Nothing to fix.";
    default:
      return "";
  }
}

const FIELD_LABEL: Record<string, string> = {
  harnessId: "harness",
  service: "service",
  billingMode: "billing mode",
  model: "model",
  reasoningEffort: "reasoning level",
};
