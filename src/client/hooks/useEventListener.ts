/**
 * Shared browser event-listener hooks (docs/227, planning#216).
 *
 * Centralizes the `target.addEventListener(type, fn)` /
 * `target.removeEventListener(type, fn)` pair that several client hooks
 * hand-roll inside their own `useEffect` (useNotification, useConnectionSync,
 * useServerEvents, use-voice-input, useKeyboardShortcuts). Folding it into one
 * primitive does two things:
 *
 *  1. **Makes cleanup correct by construction.** The add and the remove use the
 *     SAME listener reference, so the cleanup actually detaches what mount
 *     attached. The deferred sketch in docs/225 got this wrong — it called
 *     `removeEventListener(event, () => {})` with a *fresh* closure, and because
 *     `removeEventListener` matches by reference + capture flag, a brand-new
 *     arrow matches nothing and removes nothing (silent leak + double-fire after
 *     a remount). Here the cleanup closes over the exact `listener` const that
 *     `addEventListener` received, so they always pair up.
 *
 *  2. **Stops inline handlers from churning the subscription.** The latest
 *     `handler` is stored in a ref that is refreshed on every render; the bound
 *     `listener` is a stable wrapper that reads `handlerRef.current`. So passing
 *     a fresh inline arrow each render does NOT re-run the effect — the
 *     subscription rebinds only when the `target`, `type`, or capture flag
 *     actually change. This is the "latest-callback ref" (a.k.a. useEvent)
 *     pattern.
 *
 * This is the single place in the client allowed to wrap `addEventListener` in
 * a `useEffect`; the eslint-disable for the `useEffect` restriction lives here
 * once, with this justification, instead of being copy-pasted at every site.
 */

// eslint-disable-next-line no-restricted-imports -- the one sanctioned addEventListener/cleanup useEffect wrapper (browser API subscription); see module docstring
import { useEffect, useRef } from "react";

export type EventTargetLike = Window | Document | HTMLElement | EventTarget | null | undefined;

/**
 * Subscribe `handler` to `type` on `target` for the lifetime of the component.
 *
 * @param target  Window/Document/Element (or null to disable).
 * @param type    Event name, e.g. "visibilitychange", "keydown".
 * @param handler Called on each event. May be a fresh inline arrow every render
 *                — it will NOT cause a rebind; the latest one is always invoked.
 * @param options Standard `addEventListener` options — `capture`, `once`,
 *                `passive`, and `signal` are all honored on add. Only `capture`
 *                participates in remove matching. All four are tracked, so a
 *                rebind fires when any changes; an inline object literal is read
 *                by-field (and `signal` by identity), so unchanged values do not
 *                rebind. Note an aborted `signal` detaches the listener natively,
 *                independent of unmount.
 *
 * Typed overloads infer the event type per target — `useEventListener(window,
 * "keydown", e => …)` gives `e: KeyboardEvent`, no cast at the call site. A `null`
 * target keeps the inference (`enabled ? window : null` still infers from the
 * window arm). The string/`EventTargetLike` fallback covers custom event names.
 */
export function useEventListener<K extends keyof WindowEventMap>(
  target: Window | null | undefined,
  type: K,
  handler: (event: WindowEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions,
): void;
export function useEventListener<K extends keyof DocumentEventMap>(
  target: Document | null | undefined,
  type: K,
  handler: (event: DocumentEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions,
): void;
export function useEventListener<K extends keyof HTMLElementEventMap>(
  target: HTMLElement | null | undefined,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions,
): void;
export function useEventListener(
  target: EventTargetLike,
  type: string,
  handler: (event: Event) => void,
  options?: boolean | AddEventListenerOptions,
): void;
export function useEventListener(
  target: EventTargetLike,
  type: string,
  handler: (event: Event) => void,
  options?: boolean | AddEventListenerOptions,
): void {

  // non-memoized handler never forces the effect to re-run.
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const { capture, once, passive, signal } = normalizeOptions(options);

  // eslint-disable-next-line no-restricted-syntax -- the one sanctioned addEventListener/cleanup useEffect wrapper; see module docstring
  useEffect(() => {
    if (!target) return undefined;

    const listener = (event: Event) => handlerRef.current(event);

    const addOpts: AddEventListenerOptions = { capture, once, passive, ...(signal ? { signal } : {}) };
    target.addEventListener(type, listener, addOpts);
    return () => {

      target.removeEventListener(type, listener, { capture });
    };
    // handler is intentionally NOT a dep — it lives in handlerRef. Rebind only

  }, [target, type, capture, once, passive, signal]);
}

export interface EventListenerSpec {
  target: EventTargetLike;
  type: string;
  handler: (event: Event) => void;
  options?: boolean | AddEventListenerOptions;
}

export function useEventListeners(specs: EventListenerSpec[]): void {
  const specsRef = useRef(specs);
  specsRef.current = specs;

  const key = specs
    .map((s) => {
      const o = normalizeOptions(s.options);
      return [
        identityKey(s.target),
        s.type,
        o.capture ? 1 : 0,
        o.once ? 1 : 0,
        o.passive ? 1 : 0,
        o.signal ? identityKey(o.signal) : "ns",
      ].join(":");
    })
    .join("|");

  // eslint-disable-next-line no-restricted-syntax -- the one sanctioned addEventListener/cleanup useEffect wrapper; see module docstring
  useEffect(() => {

    const bound = specsRef.current.map((spec, i) => {
      const { capture, once, passive, signal } = normalizeOptions(spec.options);

      const listener = (event: Event) => specsRef.current[i]?.handler(event);
      spec.target?.addEventListener(spec.type, listener, { capture, once, passive, ...(signal ? { signal } : {}) });
      return { spec, listener, capture };
    });
    return () => {
      for (const { spec, listener, capture } of bound) {
        spec.target?.removeEventListener(spec.type, listener, { capture });
      }
    };

    // handlers ride `specsRef`, so a handler swap intentionally does not re-bind.
  }, [key]);
}

function normalizeOptions(options?: boolean | AddEventListenerOptions): {
  capture: boolean;
  once: boolean;
  passive: boolean;
  signal: AbortSignal | undefined;
} {
  if (typeof options === "boolean") {
    return { capture: options, once: false, passive: false, signal: undefined };
  }
  return {
    capture: options?.capture ?? false,
    once: options?.once ?? false,
    passive: options?.passive ?? false,
    signal: options?.signal,
  };
}

// id each on first use, so the common ambient-target case never spuriously

const objectIds = new WeakMap<object, number>();
let nextObjectId = 0;
function identityKey(obj: EventTargetLike | AbortSignal): string {
  if (!obj) return "none";
  let id = objectIds.get(obj);
  if (id === undefined) {
    id = (nextObjectId += 1);
    objectIds.set(obj, id);
  }
  return `#${id}`;
}
