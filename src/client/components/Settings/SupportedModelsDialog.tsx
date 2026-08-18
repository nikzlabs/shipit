/**
 * docs/252 reqs 23–24 — **what every service can run, in one place, before any
 * credential exists.**
 *
 * Req 19 moved a card's model ids off the card and into a hover list on its
 * `N models` control. That was right about the card and left the question badly
 * answered: "what can this service run" was reachable only for a service already
 * configured, and only as a column of raw ids with no window, no price and no
 * word about which harness could drive them. Someone deciding whether to pay for
 * OpenRouter could not see what they would get, because an unconfigured service
 * has no card to hover.
 *
 * So the answer is a dialog over the **whole catalogue**, reached two ways and
 * rendered once: from the control beside the panel's Services heading, and from a
 * card's `N models`, which now opens this scrolled to that service instead of
 * carrying a second, shorter list of its own.
 *
 * **The harness columns are every harness ShipIt integrates, not the installed
 * ones** (req 23). A tick for an absent harness is a true fact about the pairing
 * — the catalogue's join does not depend on what this image happened to install —
 * and dropping the column would silently answer a different question than the one
 * asked. So the column stays and is marked *not installed*, which is also what
 * stops a user reading a tick and going looking for a model this deployment
 * cannot offer. Contrast the *Add a service* support table
 * (`HarnessSupportCell`), which shows installed harnesses only: there the cell is
 * one step from a purchase, so an answer the user cannot act on is noise.
 *
 * **A model's support is a SET.** DeepSeek V4 Flash speaks a style all three
 * harnesses speak; Anthropic's subscription reaches only Claude Code, because
 * OpenCode cannot carry its token (`carriers`). One glyph per harness per row is
 * the only shape that can say that — a single "runs on" name per model cannot.
 *
 * Every answer comes from {@link eligibleEntriesForHarness} asked about a
 * credential that does not exist yet, which is exactly how `harnessSupportsMode`
 * asks the same question one level up. Never a second style join: the two clauses
 * (req 6's style overlap and req 8's credential shape) must be satisfied by the
 * SAME credential, and writing them independently is the bug `harnessCanCarry`'s
 * docstring records.
 */

import { useMemo, useRef, useState } from "react";
import { CheckIcon, MinusIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import type { AgentId } from "../../../server/shared/types.js";
import type { AgentOption } from "../../agent-types.js";
import {
  allHarnesses,
  allServices,
  eligibleEntriesForHarness,
  type BillingMode,
  type HarnessDef,
  type ModelDef,
  type ServiceDef,
} from "../../../server/shared/catalogue/index.js";
import { credentialModeKey } from "../../../server/shared/types/domain-types/credential-route.js";
import { Button } from "../ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog.js";
import { ServiceLogo } from "../ServiceLogo.js";
import { MODE_LABEL } from "./ServiceCard.js";

/** One row's identity: a `(service, mode, model)` triple flattened to a string. */
function rowKey(serviceId: string, billingMode: BillingMode, modelId: string): string {
  return `${credentialModeKey(serviceId, billingMode)}:${modelId}`;
}

/**
 * Which harnesses can run each row — the catalogue's own answer, asked about a
 * credential that does not exist yet.
 *
 * Computed once for the whole catalogue rather than per row, because the question
 * is asked 114 times on open (38 rows × 3 harnesses) and the underlying join
 * walks the catalogue each time it is asked. Pure over the catalogue, which is a
 * module constant, so the memo needs no dependencies.
 */
function buildSupport(): Map<string, Set<AgentId>> {
  const support = new Map<string, Set<AgentId>>();
  for (const harness of allHarnesses()) {
    for (const service of allServices()) {
      for (const mode of service.modes) {
        // Per accepted credential shape, `.some`-style — the same shape as
        // `harnessSupportsMode`, one level down. A mode that accepts an account
        // AND a string is supported if EITHER reaches the harness.
        for (const credential of mode.credentials) {
          for (const entry of eligibleEntriesForHarness(harness.id, [
            { serviceId: service.id, billingMode: mode.kind, via: credential.via },
          ])) {
            const key = rowKey(
              entry.selection.serviceId,
              entry.selection.billingMode,
              entry.selection.modelId,
            );
            const set = support.get(key) ?? new Set<AgentId>();
            set.add(harness.id);
            support.set(key, set);
          }
        }
      }
    }
  }
  return support;
}

/** `1M` / `200K` — the window as the user says it, never 1000000. */
function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1000)}K`;
}

/**
 * A USD-per-million rate. Sub-dollar rates keep their decimals (DeepSeek's
 * $0.14 is the whole point of the row); whole ones lose the `.00`.
 */
function formatPrice(rate: number): string {
  if (rate === 0) return "$0";
  if (rate < 1) return `$${Number(rate.toFixed(3))}`;
  return `$${Number(rate.toFixed(2))}`;
}

/**
 * The tick, the dimmed tick and the dash — and the words for all three.
 *
 * The answer is a glyph, so it is also said as `sr-only` TEXT rather than an
 * `aria-label`: review found the label unreliable on a generic-role element
 * (`HarnessSupportCell` carries the same note). Each cell **names both sides**,
 * because the cells sit in their own column away from the model names, so "runs"
 * alone would answer a question the listener cannot see.
 */
function SupportCell({
  harness,
  model,
  runs,
  installed,
}: {
  harness: HarnessDef;
  model: ModelDef;
  runs: boolean;
  installed: boolean;
}) {
  const answer = !runs
    ? `${harness.name} cannot run ${model.label}`
    : installed
      ? `${harness.name} runs ${model.label}`
      : `${harness.name} runs ${model.label}, but ${harness.name} is not installed here`;
  return (
    <td
      className="px-1 py-1.5 text-center"
      data-testid={`supported-models-cell-${model.id}-${harness.id}`}
      data-runs={runs ? "yes" : "no"}
    >
      <span className="sr-only">{answer}</span>
      {runs ? (
        <CheckIcon
          aria-hidden
          size={ICON_SIZE.SM}
          weight="bold"
          // A harness this deployment lacks keeps its answer at an opacity that
          // says it cannot be acted on here.
          className={`mx-auto text-(--color-success) ${installed ? "" : "opacity-40"}`}
        />
      ) : (
        <MinusIcon aria-hidden size={ICON_SIZE.SM} className="mx-auto text-(--color-text-tertiary)" />
      )}
    </td>
  );
}

/** One `(service, mode)` — the grid, headed by the mode it bills under. */
function ModeTable({
  service,
  billingMode,
  models,
  harnesses,
  installedIds,
  support,
  narrowedTo,
  onNarrow,
}: {
  service: ServiceDef;
  billingMode: BillingMode;
  models: ModelDef[];
  harnesses: readonly HarnessDef[];
  installedIds: Set<string>;
  support: Map<string, Set<AgentId>>;
  narrowedTo: AgentId | undefined;
  /** req 24 — the column head IS the control. See the head's own comment. */
  onNarrow: (harnessId: AgentId) => void;
}) {
  const visible = narrowedTo
    ? models.filter((m) => support.get(rowKey(service.id, billingMode, m.id))?.has(narrowedTo))
    : models;
  if (visible.length === 0) return null;

  return (
    <div className="mb-3" data-testid={`supported-models-mode-${credentialModeKey(service.id, billingMode)}`}>
      <div className="mb-1 flex items-center gap-2">
        <span className="rounded-full border border-(--color-border-secondary) bg-(--color-bg-secondary) px-1.5 py-px text-[10px] text-(--color-text-secondary)">
          {MODE_LABEL[billingMode]}
        </span>
        <span className="text-[10px] text-(--color-text-tertiary)">
          {visible.length} model{visible.length === 1 ? "" : "s"}
        </span>
      </div>
      {/* Narrow viewports scroll the grid rather than crushing the columns —
          the harness columns are the part that cannot usefully shrink. */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[30rem] border-collapse text-xs">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-(--color-text-tertiary)">
              <th className="border-b border-(--color-border-secondary) px-1 py-1 text-left font-medium">
                Model
              </th>
              <th className="border-b border-(--color-border-secondary) px-1 py-1 text-right font-medium">
                Context
              </th>
              <th className="border-b border-(--color-border-secondary) px-1 py-1 text-right font-medium">
                In / out per M
              </th>
              {harnesses.map((harness) => (
                <th
                  key={harness.id}
                  className="w-20 border-b border-(--color-border-secondary) px-1 py-1 text-center align-bottom font-medium"
                >
                  {/*
                    req 24 — **naming the harness narrows the list to it.** The
                    control is the column head because that is where the reader
                    already is when the question occurs to them: the ticks in this
                    column are what prompt "so what else can it run". Pressing the
                    selected one again clears, so the control is its own way back.
                    Every table repeats the head, which is what keeps one within
                    reach however far down the list the user has scrolled.
                  */}
                  <button
                    type="button"
                    onClick={() => onNarrow(harness.id)}
                    aria-pressed={narrowedTo === harness.id}
                    /*
                      **The name says what pressing it DOES, not just whose column
                      it is.** The visible text is the harness name and
                      `aria-pressed` carries the state, which together announce
                      "Codex, toggle button, not pressed" — true, and no answer to
                      "what happens if I press it". The purpose lived only in
                      `title`, which a screen reader commonly skips on a control
                      that already has text. It also names the SERVICE, because the
                      head is repeated per mode table: without it the tab order
                      holds up to 27 buttons reading "Codex".
                    */
                    aria-label={
                      narrowedTo === harness.id
                        ? "Show every model again"
                        : `Show only the models ${harness.name} can run — ${service.name}, ${MODE_LABEL[billingMode]}`
                    }
                    title={
                      narrowedTo === harness.id
                        ? "Show every model again"
                        : `Show only the models ${harness.name} can run`
                    }
                    className={`w-full rounded px-1 py-0.5 text-[10px] uppercase tracking-wider ${
                      narrowedTo === harness.id
                        ? "bg-(--color-bg-hover) text-(--color-text-primary) ring-1 ring-(--color-border-focus)"
                        : "hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)"
                    }`}
                    data-testid={`supported-models-narrow-${credentialModeKey(service.id, billingMode)}-${harness.id}`}
                  >
                    {harness.name}
                    {!installedIds.has(harness.id) && (
                      <span className="block text-[8.5px] normal-case tracking-normal text-(--color-text-tertiary)">
                        not installed
                      </span>
                    )}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((model) => (
              <tr
                key={model.id}
                className="hover:bg-(--color-bg-secondary)"
                data-testid={`supported-models-row-${credentialModeKey(service.id, billingMode)}-${model.id}`}
              >
                <td className="border-b border-(--color-border-secondary) px-1 py-1.5">
                  <div className="text-(--color-text-primary)">{model.label}</div>
                  <div className="font-mono text-[10px] text-(--color-text-tertiary)">{model.id}</div>
                </td>
                <td className="border-b border-(--color-border-secondary) px-1 py-1.5 text-right whitespace-nowrap text-(--color-text-secondary)">
                  {formatContext(model.contextWindow.default)}
                </td>
                <td className="border-b border-(--color-border-secondary) px-1 py-1.5 text-right whitespace-nowrap text-(--color-text-secondary)">
                  {formatPrice(model.price.input)}
                  <span className="text-(--color-text-tertiary)"> / </span>
                  {formatPrice(model.price.output)}
                </td>
                {harnesses.map((harness) => (
                  <SupportCell
                    key={harness.id}
                    harness={harness}
                    model={model}
                    runs={
                      support.get(rowKey(service.id, billingMode, model.id))?.has(harness.id) ?? false
                    }
                    installed={installedIds.has(harness.id)}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function SupportedModelsDialog({
  agentList = [],
  /**
   * The service to open on — a card's `N models` names itself, the panel's
   * header control names nothing and opens at the top.
   */
  initialServiceId,
  onClose,
}: {
  agentList?: AgentOption[];
  initialServiceId?: string;
  onClose: () => void;
}) {
  const services = allServices();
  const harnesses = allHarnesses();
  const support = useMemo(buildSupport, []);
  /**
   * Which harnesses this deployment installed. Read from the agent list the
   * panel already receives — the same feed `InstalledHarnesses` reads, so the two
   * statements about "what is here" cannot disagree.
   *
   * An empty list (the bootstrap has not landed) would mark every column *not
   * installed*, which is a claim rather than an absence of one — so with nothing
   * known yet, nothing is marked.
   */
  const installedIds = useMemo(
    () =>
      agentList.length === 0
        ? new Set(harnesses.map((h) => h.id as string))
        : new Set(agentList.filter((a) => a.installed).map((a) => a.id)),
    [agentList, harnesses],
  );
  /** req 24 — the harness the list is narrowed to, or nothing. */
  const [narrowedTo, setNarrowedTo] = useState<AgentId | undefined>(undefined);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  /**
   * The open-at-a-service scroll has happened.
   *
   * Load-bearing twice over. The ref callback below is an inline arrow, so React
   * detaches and re-attaches it on EVERY render — without this, narrowing to a
   * harness would yank the pane back to the service the dialog opened at, three
   * clicks after the user left it. And it is a `ref` rather than state because
   * setting it must not itself cause a render.
   */
  const landed = useRef(false);

  /**
   * Scroll a service to the top of the pane. Used by the nav, and once on open
   * when a card named the service to land on.
   *
   * Measured from the two boxes rather than from `offsetTop`, which would depend
   * on which ancestor happens to be the offset parent — the dialog is `fixed`, so
   * that is currently the dialog and not the pane, and it would silently change
   * if either grew a `relative`.
   */
  const scrollTo = (serviceId: string): void => {
    const section = sectionRefs.current[serviceId];
    const pane = paneRef.current;
    if (!section || !pane) return;
    pane.scrollTop += section.getBoundingClientRect().top - pane.getBoundingClientRect().top;
  };

  const rows = services.flatMap((service) =>
    service.modes.flatMap((mode) =>
      mode.models.map((model) => rowKey(service.id, mode.kind, model.id)),
    ),
  );
  const shown = narrowedTo
    ? rows.filter((key) => support.get(key)?.has(narrowedTo)).length
    : rows.length;
  const narrowedHarness = harnesses.find((h) => h.id === narrowedTo);

  /**
   * Does this service keep anything under the current narrowing? Asked so a
   * service that keeps nothing can say so **in place** (req 24) — a section that
   * simply vanished would leave the reader to work out whether the service is
   * gone or merely empty, and the whole list would read as a catalogue that had
   * shrunk.
   */
  const keepsSomething = (service: ServiceDef): boolean =>
    !narrowedTo
    || service.modes.some((mode) =>
      mode.models.some((model) => support.get(rowKey(service.id, mode.kind, model.id))?.has(narrowedTo)),
    );

  return (
    <Dialog open onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent
        className="flex max-h-[85vh] w-full max-w-[54rem] flex-col overflow-hidden p-0"
        data-testid="supported-models-dialog"
      >
        <div className="shrink-0 border-b border-(--color-border-secondary) p-4 pr-10">
          <DialogTitle className="text-sm font-semibold">Supported models</DialogTitle>
          {/*
            Three facts the rows cannot state for themselves: whose harnesses the
            columns are, what a marked column means, and that a subscription's
            price is a comparison rather than a charge (req 16 calls the figures
            estimates, so this must too).
          */}
          <p className="mt-1.5 text-xs text-(--color-text-secondary)">
            Every model ShipIt&rsquo;s catalogue offers, per service and billing mode. The harness
            columns are every harness ShipIt integrates &mdash; a model needs one that speaks its
            API style, and several may. A column marked <em>not installed</em> is a harness this
            deployment does not have. Prices are the service&rsquo;s own rate per million tokens and
            are estimates; under a subscription they are what the tokens would have cost, not an
            extra charge.
          </p>
          {/*
            **The narrowing says so, and says it where the list is** (req 24). A
            filter with no visible statement is how a user comes to believe the
            catalogue is smaller than it is — and the Clear here is the second way
            out, beside pressing the same column head again.
          */}
          {narrowedHarness && (
            <div
              className="mt-2.5 flex items-center gap-2 rounded-md border border-(--color-border-focus) bg-(--color-bg-secondary) px-2 py-1.5 text-xs text-(--color-text-primary)"
              data-testid="supported-models-narrowed"
            >
              <span>
                Showing only what <strong>{narrowedHarness.name}</strong> can run
              </span>
              <span className="text-(--color-text-tertiary)">
                {shown} of {rows.length} rows
              </span>
              <span className="flex-1" />
              <Button
                variant="ghost"
                size="sm"
                className="rounded"
                onClick={() => setNarrowedTo(undefined)}
                data-testid="supported-models-clear"
              >
                Clear
              </Button>
            </div>
          )}
        </div>

        <div className="flex min-h-0 flex-1">
          {/*
            The service nav. Hidden on a phone, where the dialog is fullscreen and
            186px of it would be a third of the width — the pane scrolls there,
            which is the same journey with one more gesture.
          */}
          <nav
            className="w-44 shrink-0 overflow-y-auto border-r border-(--color-border-secondary) bg-(--color-bg-secondary) p-2 max-md:hidden"
            data-testid="supported-models-nav"
          >
            <p className="px-1.5 pb-1.5 text-[10px] uppercase tracking-wider text-(--color-text-tertiary)">
              Services
            </p>
            {services.map((service) => (
              <button
                key={service.id}
                type="button"
                onClick={() => scrollTo(service.id)}
                // A service the narrowing empties stays listed, faded: the nav is
                // also the answer to "which services does this harness reach at
                // all", and removing the row would delete that answer.
                className={`flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-(--color-bg-hover) ${
                  keepsSomething(service)
                    ? "text-(--color-text-secondary)"
                    : "text-(--color-text-tertiary) opacity-50"
                }`}
                data-testid={`supported-models-nav-${service.id}`}
              >
                <span className="flex w-3 shrink-0 justify-center">
                  <ServiceLogo service={service} />
                </span>
                {/* Wraps inside the nav's fixed width rather than cutting: the
                    name is the whole row, so a clipped one is a row you cannot
                    read. */}
                <span className="min-w-0 break-words">{service.name}</span>
              </button>
            ))}
          </nav>

          <div
            className="min-w-0 flex-1 overflow-y-auto p-4"
            /**
             * **The scroll happens on the PANE's ref, not the section's** — which
             * is not a preference, it is the only one of the two that can work.
             * React attaches child refs before the parent's, so a section
             * callback that called `scrollTo` ran while `paneRef.current` was
             * still null: the dialog opened at the top of the catalogue however
             * it was opened, and the test asserting the section merely EXISTED
             * could not fail on it. By the time the parent's callback runs, every
             * section is registered.
             */
            ref={(el) => {
              paneRef.current = el;
              if (el && initialServiceId && !landed.current) {
                landed.current = true;
                scrollTo(initialServiceId);
              }
            }}
          >
            {services.map((service) => (
              <section
                key={service.id}
                ref={(el) => {
                  sectionRefs.current[service.id] = el;
                }}
                className="mb-4"
                data-testid={`supported-models-service-${service.id}`}
              >
                <h3 className="sticky top-0 z-10 mb-1.5 flex items-center gap-2 bg-(--color-bg-elevated) py-1 text-xs font-semibold text-(--color-text-primary)">
                  <span className="flex w-3 shrink-0 justify-center">
                    <ServiceLogo service={service} />
                  </span>
                  {service.name}
                  {/*
                    **No "you have this one" mark.** The prototype carried a dot
                    per configured service and it is deliberately not here: reqs
                    23–24 do not ask for it, and it makes the one surface whose
                    whole premise is being readable BEFORE any credential exists
                    depend on which credentials exist. The panel behind this dialog
                    is the list of what the user configured — that is its entire
                    job — so the fact was already on screen one layer out.
                  */}
                </h3>
                {keepsSomething(service) ? (
                  service.modes.map((mode) => (
                    <ModeTable
                      key={mode.kind}
                      service={service}
                      billingMode={mode.kind}
                      models={mode.models}
                      harnesses={harnesses}
                      installedIds={installedIds}
                      support={support}
                      narrowedTo={narrowedTo}
                      onNarrow={(harnessId) =>
                        setNarrowedTo((current) => (current === harnessId ? undefined : harnessId))
                      }
                    />
                  ))
                ) : (
                  <p
                    className="text-[11px] text-(--color-text-tertiary)"
                    data-testid={`supported-models-none-${service.id}`}
                  >
                    Nothing here for {narrowedHarness?.name}.
                  </p>
                )}
              </section>
            ))}
          </div>
        </div>

        {/*
          The legend. The three glyphs carry the whole grid's meaning and two of
          them are one glyph at two opacities, which is exactly the distinction a
          legend exists for.
        */}
        <div className="shrink-0 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-(--color-border-secondary) px-4 py-2 text-[11px] text-(--color-text-tertiary)">
          {/* Not "click": the column head is a button, so it is pressed by
              keyboard too, and naming one input method excludes the other. */}
          <span>Choose a harness column to show only what it runs</span>
          <span className="flex-1" />
          <span className="flex items-center gap-1">
            <CheckIcon aria-hidden size={ICON_SIZE.XS} weight="bold" className="text-(--color-success)" />
            runs it
          </span>
          <span className="flex items-center gap-1">
            <CheckIcon
              aria-hidden
              size={ICON_SIZE.XS}
              weight="bold"
              className="text-(--color-success) opacity-40"
            />
            not installed here
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
