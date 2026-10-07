// eslint-disable-next-line no-restricted-imports -- useEffect: read the SSH destination registry when the editor opens (external system sync)
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { BrainIcon, CheckSquareIcon, SquareIcon, WarningIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../../design-tokens.js";
import { Button } from "../../ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../ui/dialog.js";
import { Picker, PickerOption } from "../../pickers/Picker.js";
import { ModelGroupHeader } from "../../ModelPicker.js";
import { RoleSelector, useRolePickerState } from "../../MessageInput/RoleSelector.js";
import { PermissionModeSelector } from "../../PermissionModeSelector.js";
import { SandboxCapabilityToggles } from "../../SandboxCapabilityToggles.js";
import { ToggleSwitch } from "../ToggleSwitch.js";
import { eligibleModelsOf, harnessesForModel, serviceKeyOf } from "../../pickers/model-choice.js";
import { modeFromOverride, overrideFromMode, useComposerNetworkMode } from "../../../hooks/useSessionNetworkMode.js";
import { useUiStore } from "../../../stores/ui-store.js";
import { useRepoStore } from "../../../stores/repo-store.js";
import { saveSchedule } from "../../../stores/schedule-store.js";
import { parseRepoLabel } from "../../../utils/repo-label.js";
import { nextRuns, timingProblem, timingToCron } from "../../../../server/shared/schedule-timing.js";
import { START_PARAM_LABELS } from "../../../../server/shared/session-start-labels.js";
import { reasoningOptionsFor } from "../../../../server/shared/catalogue/index.js";
import {
  DEFAULT_SANDBOX_CAPABILITIES,
  type AgentId,
  type ScheduleTiming,
  type ScheduleView,
  type SessionCapabilities,
  type SessionStartParams,
  type SessionStartTarget,
  type SshHostPublic,
} from "../../../../server/shared/types.js";
import type { AgentOption, EligibleModelOption } from "../../../agent-types.js";
import { WEEKDAYS, browserTimeZone, formatRunTime } from "./schedule-format.js";

/**
 * docs/324-scheduled-sessions reqs 11, 19 — everything a schedule holds, edited in one place.
 *
 * The session-start choices are the composer's own controls where those take a value
 * (`RoleSelector`, `PermissionModeSelector` with its network section) and the shared
 * `Picker`s the role editor uses where the composer's are bound to the open session. The
 * sandbox grants are `SandboxCapabilityToggles`, as in the Sandbox dialog. A parameter left
 * unset is the default a session started by hand gets. An edit applies from the next run.
 */

const SANDBOX = "__sandbox__";
const NEXT_RUNS_SHOWN = 3;
const INPUT_CLASS =
  "rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) px-3 py-1.5 text-sm "
  + "text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none "
  + "focus:border-(--color-border-focus)";

/** Network containment and auto-merge belong to a repository session; a sandbox has its own grants. */
const REPO_ONLY_PARAMS = ["networkMode", "armAutoMerge"] as const satisfies readonly (keyof SessionStartParams)[];

const TIMING_KINDS: { kind: ScheduleTiming["kind"]; label: string }[] = [
  { kind: "hourly", label: "Every hour" },
  { kind: "daily", label: "Every day" },
  { kind: "weekdays", label: "Weekdays" },
  { kind: "weekly", label: "Every week" },
  { kind: "cron", label: "Cron expression" },
];

const pad = (n: number) => String(n).padStart(2, "0");

let zoneList: string[] | undefined;
/** The browser's list leaves out UTC, which a schedule may well use. */
function timeZones(): string[] {
  const named = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  zoneList ??= ["UTC", ...named.filter((zone) => zone !== "UTC")];
  return zoneList;
}

function withTimingKind(prev: ScheduleTiming, kind: ScheduleTiming["kind"]): ScheduleTiming {
  const hour = "hour" in prev ? prev.hour : 9;
  const minute = "minute" in prev ? prev.minute : 0;
  switch (kind) {
    case "hourly":
      return { kind, minute };
    case "daily":
    case "weekdays":
      return { kind, hour, minute };
    case "weekly":
      return { kind, weekday: prev.kind === "weekly" ? prev.weekday : 1, hour, minute };
    case "cron":
      return { kind, expression: timingToCron(prev) };
  }
}

function selectionOf(params: SessionStartParams) {
  return params.model && params.serviceId && params.billingMode
    ? { serviceId: params.serviceId, billingMode: params.billingMode, modelId: params.model }
    : undefined;
}

/** The harness the run's model and level resolve against: the chosen one, or the one that runs the model. */
function effectiveHarness(params: SessionStartParams, agents: AgentOption[]): string | undefined {
  if (params.agent) return params.agent;
  const selection = selectionOf(params);
  return selection ? harnessesForModel(agents, selection)[0]?.id : undefined;
}

function levelsFor(params: SessionStartParams, agents: AgentOption[]): { value: string; label: string }[] {
  const harness = effectiveHarness(params, agents);
  return harness ? reasoningOptionsFor(harness as AgentId, selectionOf(params)) : [];
}

/** A level the new selection does not honour would be dropped at the start; drop it here, where it shows. */
function keepHonouredLevel(params: SessionStartParams, agents: AgentOption[]): SessionStartParams {
  if (!params.reasoning || !effectiveHarness(params, agents)) return params;
  if (levelsFor(params, agents).some((level) => level.value === params.reasoning)) return params;
  const { reasoning: _dropped, ...rest } = params;
  return rest;
}

/** The parameters as the schedule stores them: unset keys and keys the target does not take are left out. */
function paramsToSave(params: SessionStartParams, target: SessionStartTarget): SessionStartParams {
  const saved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (target.kind === "sandbox" && (REPO_ONLY_PARAMS as readonly string[]).includes(key)) continue;
    saved[key] = value;
  }
  return saved;
}

export function ScheduleEditor({ schedule, onClose }: { schedule: ScheduleView; onClose: () => void }) {
  const [name, setName] = useState(schedule.name);
  const [timing, setTiming] = useState<ScheduleTiming>(schedule.timing);
  const [timeZone, setTimeZone] = useState(schedule.timeZone);
  const [target, setTarget] = useState<SessionStartTarget>(
    schedule.spec?.target ?? { kind: "sandbox", capabilities: DEFAULT_SANDBOX_CAPABILITIES },
  );
  const [lastCapabilities, setLastCapabilities] = useState<SessionCapabilities>(
    target.kind === "sandbox" ? target.capabilities : DEFAULT_SANDBOX_CAPABILITIES,
  );
  const [params, setParams] = useState<SessionStartParams>(schedule.spec?.params ?? {});
  const [prompt, setPrompt] = useState(schedule.spec?.prompt ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const problem = useMemo(() => timingProblem(timing, timeZone), [timing, timeZone]);
  const upcoming = useMemo(() => {
    if (problem) return [];
    try {
      return nextRuns(timing, timeZone, NEXT_RUNS_SHOWN);
    } catch {
      return [];
    }
  }, [timing, timeZone, problem]);

  const canSave = !busy && !!name.trim() && !!prompt.trim() && !problem;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(undefined);
    try {
      await saveSchedule(schedule.id, {
        name: name.trim(),
        timing,
        timeZone,
        spec: { target, params: paramsToSave(params, target), prompt: prompt.trim() },
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save the schedule");
    } finally {
      setBusy(false);
    }
  };

  const changeTarget = (value: string) => {
    if (target.kind === "sandbox") setLastCapabilities(target.capabilities);
    setTarget(value === SANDBOX ? { kind: "sandbox", capabilities: lastCapabilities } : { kind: "repo", repoUrl: value });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="rounded-lg border-(--color-border-secondary) max-w-2xl w-full md:mx-4 max-h-[88vh] flex flex-col"
        data-testid="schedule-editor"
      >
        <DialogHeader>
          <DialogTitle>Edit {schedule.name}</DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 pt-4 pb-1">
          {!schedule.spec && (
            <p className="flex items-start gap-1.5 text-xs text-(--color-warning)" data-testid="schedule-editor-unreadable">
              <WarningIcon size={ICON_SIZE.XS} className="mt-0.5 shrink-0" />
              ShipIt cannot read what this schedule starts. Set the target, the parameters and the
              prompt again.
            </p>
          )}

          <Field label="Name">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Name"
              className={`${INPUT_CLASS} w-full`}
              data-testid="schedule-editor-name"
            />
          </Field>

          <Field label="When" hint="Runs come at least an hour apart. An edit applies from the next run.">
            <TimingFields timing={timing} onChange={setTiming} />
            <div className="mt-2 flex items-center gap-2">
              <span className="text-xs text-(--color-text-tertiary)">Time zone</span>
              <select
                value={timeZone}
                onChange={(e) => setTimeZone(e.target.value)}
                aria-label="Time zone"
                className={INPUT_CLASS}
                data-testid="schedule-editor-time-zone"
              >
                {(timeZones().includes(timeZone) ? timeZones() : [timeZone, ...timeZones()]).map((zone) => (
                  <option key={zone} value={zone}>{zone}</option>
                ))}
              </select>
            </div>
            {problem ? (
              <p className="mt-1.5 text-xs text-(--color-error)" data-testid="schedule-editor-timing-problem">{problem}</p>
            ) : (
              <p className="mt-1.5 text-xs text-(--color-text-tertiary)" data-testid="schedule-editor-next-runs">
                Next runs: {upcoming.map((d) => formatRunTime(d)).join(" · ") || "none"}
                {timeZone !== browserTimeZone() && " (your time)"}
              </p>
            )}
          </Field>

          <Field label="Target">
            <TargetSelect target={target} onChange={changeTarget} />
            {target.kind === "sandbox" && (
              <div className="mt-2 rounded-lg border border-(--color-border-secondary) px-3">
                <SandboxCapabilityToggles
                  capabilities={target.capabilities}
                  onChange={(capabilities) => setTarget({ kind: "sandbox", capabilities })}
                  disabled={busy}
                />
              </div>
            )}
          </Field>

          <Field label="Runs as">
            <StartParamsFields params={params} onChange={setParams} target={target} />
          </Field>

          <SshHostsField
            selected={params.sshHosts ?? []}
            onChange={(sshHosts) => setParams((p) => ({ ...p, sshHosts }))}
          />

          <Field label="Prompt" hint="The task for each run.">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={5}
              aria-label="Prompt"
              className={`${INPUT_CLASS} w-full resize-y`}
              data-testid="schedule-editor-prompt"
            />
          </Field>

          {error && (
            <p className="flex items-start gap-1.5 text-xs text-(--color-error)" data-testid="schedule-editor-error">
              <WarningIcon size={ICON_SIZE.XS} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </p>
          )}
        </div>

        <DialogFooter className="mt-3 gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} data-testid="schedule-editor-cancel">
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!canSave}
            onClick={() => void save()}
            data-testid="schedule-editor-save"
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-(--color-text-primary)">
        {label}
        {hint && <span className="ml-1.5 font-normal text-(--color-text-tertiary)">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function TimingFields({ timing, onChange }: { timing: ScheduleTiming; onChange: (timing: ScheduleTiming) => void }) {
  const time = (t: { hour: number; minute: number }) => (
    <input
      type="time"
      value={`${pad(t.hour)}:${pad(t.minute)}`}
      onChange={(e) => {
        const [hour, minute] = e.target.value.split(":").map(Number);
        if (Number.isInteger(hour) && Number.isInteger(minute)) onChange({ ...timing, hour, minute } as ScheduleTiming);
      }}
      aria-label="Time"
      className={INPUT_CLASS}
      data-testid="schedule-editor-time"
    />
  );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={timing.kind}
        onChange={(e) => onChange(withTimingKind(timing, e.target.value as ScheduleTiming["kind"]))}
        aria-label="Repeats"
        className={INPUT_CLASS}
        data-testid="schedule-editor-repeats"
      >
        {TIMING_KINDS.map(({ kind, label }) => <option key={kind} value={kind}>{label}</option>)}
      </select>
      {timing.kind === "hourly" && (
        <label className="flex items-center gap-1.5 text-xs text-(--color-text-tertiary)">
          at minute
          <input
            type="number"
            min={0}
            max={59}
            value={timing.minute}
            onChange={(e) => onChange({ kind: "hourly", minute: Number(e.target.value) })}
            aria-label="Minute"
            className={`${INPUT_CLASS} w-20`}
            data-testid="schedule-editor-minute"
          />
        </label>
      )}
      {timing.kind === "weekly" && (
        <select
          value={timing.weekday}
          onChange={(e) => onChange({ ...timing, weekday: Number(e.target.value) })}
          aria-label="Weekday"
          className={INPUT_CLASS}
          data-testid="schedule-editor-weekday"
        >
          {WEEKDAYS.map((day, i) => <option key={day} value={i}>{day}</option>)}
        </select>
      )}
      {(timing.kind === "daily" || timing.kind === "weekdays" || timing.kind === "weekly") && (
        <>
          <span className="text-xs text-(--color-text-tertiary)">at</span>
          {time(timing)}
        </>
      )}
      {timing.kind === "cron" && (
        <input
          type="text"
          value={timing.expression}
          onChange={(e) => onChange({ kind: "cron", expression: e.target.value })}
          placeholder="0 9 * * 1-5"
          aria-label="Cron expression"
          className={`${INPUT_CLASS} font-mono`}
          data-testid="schedule-editor-cron"
        />
      )}
    </div>
  );
}

function TargetSelect({ target, onChange }: { target: SessionStartTarget; onChange: (value: string) => void }) {
  const repos = useRepoStore((s) => s.repos);
  const current = target.kind === "repo" ? target.repoUrl : SANDBOX;
  const missing = target.kind === "repo" && !repos.some((repo) => repo.url === target.repoUrl);
  return (
    <select
      value={current}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Target"
      className={INPUT_CLASS}
      data-testid="schedule-editor-target"
    >
      <option value={SANDBOX}>Sandbox</option>
      {repos.map((repo) => <option key={repo.url} value={repo.url}>{parseRepoLabel(repo.url)}</option>)}
      {missing && <option value={target.repoUrl}>{parseRepoLabel(target.repoUrl)} (not added)</option>}
    </select>
  );
}

/** The role, harness, model, level, permission mode, network mode and auto-merge (req 4). */
function StartParamsFields({
  params,
  onChange,
  target,
}: {
  params: SessionStartParams;
  onChange: (update: (prev: SessionStartParams) => SessionStartParams) => void;
  target: SessionStartTarget;
}) {
  const agents = useUiStore((s) => s.agentList);
  const defaultAgentId = useUiStore((s) => s.activeAgentId);
  const { roles } = useRolePickerState();
  const network = useComposerNetworkMode(null);

  const role = roles.find((r) => r.name === params.role);
  // What the run starts on decides which permission modes it can take; a role names its own.
  const harnessId = (role?.resolved?.harnessId ?? effectiveHarness(params, agents) ?? defaultAgentId) as AgentId;
  const model = role ? role.resolved?.modelId : params.model;

  const selectRole = (roleName: string | undefined) =>
    onChange((p) => {
      // A role replaces the harness, model and level, as in the composer.
      const { role: _role, agent: _agent, model: _model, serviceId: _service, billingMode: _billing, reasoning: _level, ...rest } = p;
      return roleName ? { ...rest, role: roleName } : rest;
    });

  return (
    <div className="flex flex-col gap-2">
      <div
        className="flex flex-wrap items-center gap-1.5 rounded-lg border border-(--color-border-secondary) p-1.5"
        data-testid="schedule-editor-runs-as"
      >
        <RoleSelector roles={roles} selectedRole={params.role} onSelectRole={selectRole} />
        {!params.role && <ModelFields params={params} onChange={onChange} agents={agents} />}
        <PermissionModeSelector
          mode={params.permissionMode ?? "auto"}
          onChange={(permissionMode) => onChange((p) => ({ ...p, permissionMode }))}
          agents={agents}
          activeAgentId={harnessId}
          modelInfo={model ? { model, contextWindowTokens: 0 } : null}
          network={target.kind === "repo"
            ? {
                mode: modeFromOverride(params.networkMode ?? null),
                onChange: (mode) => onChange((p) => ({ ...p, networkMode: overrideFromMode(mode) })),
                globalEnabled: network.globalEnabled,
                enforcementStatus: network.enforcementStatus,
                pendingRestart: false,
                beforeFirstTurn: false,
                loaded: network.loaded,
              }
            : undefined}
        />
      </div>
      {target.kind === "repo" && (
        <label className="flex items-center gap-2 text-xs text-(--color-text-secondary)">
          <ToggleSwitch
            enabled={!!params.armAutoMerge}
            onToggle={(armAutoMerge) => onChange((p) => ({ ...p, armAutoMerge }))}
            label={START_PARAM_LABELS.armAutoMerge.label}
            testId="schedule-editor-auto-merge"
          />
          {START_PARAM_LABELS.armAutoMerge.label}
        </label>
      )}
    </div>
  );
}

function ModelFields({
  params,
  onChange,
  agents,
}: {
  params: SessionStartParams;
  onChange: (update: (prev: SessionStartParams) => SessionStartParams) => void;
  agents: AgentOption[];
}) {
  const harnesses = agents.filter((a) => a.installed);
  const harness = agents.find((a) => a.id === params.agent);
  const models = harness ? (harness.eligibleModels ?? []) : eligibleModelsOf(agents);
  const groups = groupByService(models);
  const selection = selectionOf(params);
  const levels = levelsFor(params, agents);
  const levelHarness = agents.find((a) => a.id === effectiveHarness(params, agents));

  const modelLabel = params.model
    ? (models.find((m) => m.modelId === params.model && m.serviceId === params.serviceId)?.label
      ?? START_PARAM_LABELS.model.describe(params.model))
    : "Default model";

  const pickHarness = (agentId: string | undefined) =>
    onChange((p) => {
      const next: SessionStartParams = { ...p };
      if (agentId) next.agent = agentId as AgentId;
      else delete next.agent;
      const current = selectionOf(next);
      if (agentId && current && !harnessesForModel(agents, current).some((h) => h.id === agentId)) {
        delete next.model;
        delete next.serviceId;
        delete next.billingMode;
      }
      return keepHonouredLevel(next, agents);
    });

  const pickModel = (model: EligibleModelOption | undefined) =>
    onChange((p) => {
      const next: SessionStartParams = { ...p };
      if (model) {
        next.model = model.modelId;
        next.serviceId = model.serviceId;
        next.billingMode = model.billingMode;
        const runners = harnessesForModel(agents, model);
        if (next.agent && !runners.some((h) => h.id === next.agent)) next.agent = runners[0]?.id as AgentId | undefined;
      } else {
        delete next.model;
        delete next.serviceId;
        delete next.billingMode;
      }
      return keepHonouredLevel(next, agents);
    });

  return (
    <>
      <Picker
        label={harness?.name ?? (params.agent ? START_PARAM_LABELS.agent.describe(params.agent) : "Default harness")}
        ariaLabel="Harness for each run"
        triggerTestId="schedule-editor-harness-trigger"
        menuTestId="schedule-editor-harness-menu"
        menuLabel="Runs under"
        menuWidth="w-56"
      >
        <PickerOption
          label="Default"
          detail="The harness a new session starts on"
          selected={!params.agent}
          onSelect={() => pickHarness(undefined)}
          testId="schedule-editor-harness-option-default"
        />
        {harnesses.map((agent) => (
          <PickerOption
            key={agent.id}
            label={agent.name}
            selected={agent.id === params.agent}
            disabled={!agent.hasRunnableModels}
            onSelect={() => pickHarness(agent.id)}
            testId={`schedule-editor-harness-option-${agent.id}`}
          />
        ))}
      </Picker>
      <Picker
        label={modelLabel}
        ariaLabel="Model for each run"
        triggerTestId="schedule-editor-model-trigger"
        menuTestId="schedule-editor-model-menu"
        menuWidth="w-72"
      >
        <PickerOption
          label="Default"
          detail="The model a new session starts on"
          selected={!params.model}
          onSelect={() => pickModel(undefined)}
          testId="schedule-editor-model-option-default"
        />
        {groups.map((group) => (
          <div key={group.key}>
            <ModelGroupHeader serviceId={group.serviceId} serviceName={group.serviceName} billingMode={group.billingMode} />
            {group.models.map((model) => (
              <PickerOption
                key={`${group.key}|${model.modelId}`}
                label={model.label}
                selected={!!selection && serviceKeyOf(selection) === group.key && selection.modelId === model.modelId}
                onSelect={() => pickModel(model)}
                testId={`schedule-editor-model-option-${model.modelId}`}
                indent
              />
            ))}
          </div>
        ))}
      </Picker>
      {(levels.length > 0 || params.reasoning) && (
        <Picker
          label={levels.find((l) => l.value === params.reasoning)?.label
            ?? (params.reasoning ? START_PARAM_LABELS.reasoning.describe(params.reasoning) : "Default")}
          icon={<BrainIcon size={ICON_SIZE.XS} className="text-(--color-text-tertiary)" />}
          ariaLabel={`${levelHarness?.reasoning?.label ?? "Reasoning"} for each run`}
          triggerTestId="schedule-editor-reasoning-trigger"
          menuTestId="schedule-editor-reasoning-menu"
          menuLabel={levelHarness?.reasoning?.label ?? "Reasoning"}
          menuWidth="w-48"
        >
          {[{ value: undefined as string | undefined, label: "Default" }, ...levels].map((level) => (
            <PickerOption
              key={level.value ?? "__default__"}
              label={level.label}
              selected={level.value === params.reasoning}
              onSelect={() =>
                onChange((p) => {
                  const next = { ...p };
                  if (level.value) next.reasoning = level.value;
                  else delete next.reasoning;
                  return next;
                })
              }
              testId={`schedule-editor-reasoning-option-${level.value ?? "default"}`}
              indent
            />
          ))}
        </Picker>
      )}
    </>
  );
}

function groupByService(models: EligibleModelOption[]) {
  const groups: { key: string; serviceId: string; serviceName: string; billingMode: "sub" | "key"; models: EligibleModelOption[] }[] = [];
  for (const model of models) {
    const key = serviceKeyOf(model);
    let group = groups.find((g) => g.key === key);
    if (!group) {
      group = { key, serviceId: model.serviceId, serviceName: model.serviceName, billingMode: model.billingMode, models: [] };
      groups.push(group);
    }
    group.models.push(model);
  }
  return groups;
}

/** As Session settings grants them (docs/305-ssh-hosts); shown only when the registry has any. */
function SshHostsField({ selected, onChange }: { selected: string[]; onChange: (ids: string[]) => void }) {
  const [hosts, setHosts] = useState<SshHostPublic[] | null>(null);

  // eslint-disable-next-line no-restricted-syntax -- external system sync: read the registry when the editor opens
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/ssh-hosts");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { hosts: SshHostPublic[] };
        if (!cancelled) setHosts(body.hosts);
      } catch (err) {
        console.error("[schedules] failed to read the SSH destinations:", err);
        if (!cancelled) setHosts([]);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // A destination removed from the registry stays listed, so the user can take it off.
  const unknown = hosts ? selected.filter((id) => !hosts.some((host) => host.id === id)) : [];
  if (!hosts || hosts.length + unknown.length === 0) return null;
  const rows = [
    ...hosts.map((host) => ({ id: host.id, label: host.label, detail: `${host.user}@${host.address}` })),
    ...unknown.map((id) => ({ id, label: id, detail: "No longer in Settings → Integrations" })),
  ];
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  return (
    <Field label={START_PARAM_LABELS.sshHosts.label}>
      <div className="flex flex-col gap-1" data-testid="schedule-editor-ssh-hosts">
        {rows.map((row) => {
          const granted = selected.includes(row.id);
          return (
            <button
              key={row.id}
              type="button"
              role="checkbox"
              aria-checked={granted}
              aria-label={row.label}
              onClick={() => toggle(row.id)}
              data-testid={`schedule-editor-ssh-host-${row.id}`}
              className={`flex w-full items-center gap-3 rounded-lg border px-3 py-1.5 text-left transition-colors ${
                granted
                  ? "border-(--color-accent) bg-(--color-accent-subtle)"
                  : "border-(--color-border-secondary) bg-(--color-bg-secondary) hover:bg-(--color-bg-hover)"
              }`}
            >
              <span className={`shrink-0 ${granted ? "text-(--color-accent)" : "text-(--color-text-tertiary)"}`}>
                {granted ? <CheckSquareIcon size={ICON_SIZE.SM} weight="fill" /> : <SquareIcon size={ICON_SIZE.SM} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold text-(--color-text-primary)">{row.label}</span>
                <span className="block font-mono text-xs text-(--color-text-secondary)">{row.detail}</span>
              </span>
            </button>
          );
        })}
      </div>
    </Field>
  );
}
