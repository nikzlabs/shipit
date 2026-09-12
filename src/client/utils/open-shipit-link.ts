/**
 * The click action behind an agent-authored pointer (docs/258).
 *
 * **Resolve first, then reveal.** Every failure is decided before the user's
 * panel is touched, so a malformed pointer or a missing artifact cannot replace
 * whatever they were looking at and *then* apologise in a toast. The one thing
 * that reveals before it is finished is a stopped service (req 12) — that is
 * actionable, and revealing first is how the user watches it boot instead of
 * sitting through a blank pause.
 *
 * **Failure reporting is best effort (req 10).** What is here is the set of
 * failures ShipIt can determine locally; each names the missing thing, because
 * "couldn't open that" gives the user nothing to act on. A pointer that appears
 * to open is treated as having opened — a route that loads the app's own "not
 * found" screen is indistinguishable from one that worked, and telling them
 * apart would need a correlated request/result protocol built to preserve a
 * phrase.
 */

import { usePreviewStore } from "../stores/preview-store.js";
import { usePresentStore } from "../stores/present-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { revealWorkspaceTab } from "./reveal-workspace-tab.js";
import type { ShipitLink } from "./shipit-link.js";

let clickCounter = 0;

export function nextShipitLinkClickId(): number {
  return ++clickCounter;
}

function reportUnopenable(message: string): void {
  useUiStore.getState().setToast({ message, variant: "error" });
}

/**
 * Open the destination an agent-authored pointer names. Safe to call for every
 * outcome including `invalid` — a pointer always accepts a click, and one that
 * cannot be opened says why rather than doing nothing.
 */
export function openShipitLink(link: ShipitLink, owningSession?: string | null): void {
  // The pointer was rendered in one session's transcript and must not act on

  if (owningSession && owningSession !== useSessionStore.getState().sessionId) return;

  if (link.kind === "invalid") {
    reportUnopenable(`That link can't be opened — ${link.reason}.`);
    return;
  }
  if (link.kind === "present") openPresentLink(link);
  else openPreviewLink(link);
}

function openPresentLink(link: Extract<ShipitLink, { kind: "present" }>): void {
  const present = usePresentStore.getState();
  // Matching only ever selects an already-presented entry; a pointer never

  const found = present.presentations.some(
    (p) => (p.filePath.startsWith("./") ? p.filePath.slice(2) : p.filePath) === link.filePath,
  );
  if (!found) {
    reportUnopenable(`Nothing has been presented from ${link.filePath}.`);
    return;
  }

  revealWorkspaceTab("present");
  const entry = present.focusByPath(link.filePath);
  if (!entry) return;                                                          
  present.setLinkTarget({
    presentId: entry.presentId,
    ...(link.fragment !== undefined ? { fragment: link.fragment } : {}),
    clickId: nextShipitLinkClickId(),
  });
}

function openPreviewLink(link: Extract<ShipitLink, { kind: "preview" }>): void {
  const sessionId = useSessionStore.getState().sessionId;
  if (!sessionId) {
    reportUnopenable("That link can't be opened — no session is open.");
    return;
  }

  const preview = usePreviewStore.getState();
  // Exact match against the *declared* services, never a prefix or fuzzy one:

  const service = preview.services.find((s) => s.name === link.service);
  if (!service) {
    reportUnopenable(`This project declares no service named "${link.service}".`);
    return;
  }

  if (!service.port) {
    reportUnopenable(`Service "${link.service}" has no port to preview.`);
    return;
  }

  revealWorkspaceTab("preview");
  preview.setPreviewLinkIntent({
    sessionId,
    service: service.name,
    port: service.port,
    slotKey: `${sessionId}:${service.port}`,
    targetPath: link.target,
    clickId: nextShipitLinkClickId(),
    startedAt: Date.now(),
  });

  // chosen port isn't among the running ones, so it cannot be set up front.
  if (service.status === "running") preview.setSelectedPort(service.port);
}
