/**
 * Shared browser event-listener hooks (docs/227, SHI-214).
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

/**
 * Targets we bind to. `null`/`undefined` is allowed so a caller can pass a
 * not-yet-resolved ref or a conditionally-disabled target and get a clean no-op
 * (no listener attached, nothing to clean up) without branching at the call site.
 */
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
  // Latest handler, refreshed every render. Read inside the stable wrapper so a
  // non-memoized handler never forces the effect to re-run.
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const { capture, once, passive, signal } = normalizeOptions(options);

  // eslint-disable-next-line no-restricted-syntax -- the one sanctioned addEventListener/cleanup useEffect wrapper; see module docstring
  useEffect(() => {
    if (!target) return undefined;
    // `listener` is created ONCE per effect run and captured by both the add and
    // the cleanup below — that shared reference is what makes removal correct.
    const listener = (event: Event) => handlerRef.current(event);
    // Pass every supported option through to the native add so `once`/`passive`/
    // `signal` are actually honored — not silently dropped.
    const addOpts: AddEventListenerOptions = { capture, once, passive, ...(signal ? { signal } : {}) };
    target.addEventListener(type, listener, addOpts);
    return () => {
      // `capture` is the only option that participates in matching; pass it back
      // so the remove targets the same listener slot the add created.
      target.removeEventListener(type, listener, { capture });
    };
    // handler is intentionally NOT a dep — it lives in handlerRef. Rebind only
    // when the subscription identity (target/type/options) actually changes.
  }, [target, type, capture, once, passive, signal]);
}

/**
 * One stable spec in a `useEventListeners` batch.
 *
 * Targets may differ per spec (e.g. visibilitychange on `document` but
 * pageshow/focus on `window` — the exact shape in useConnectionSync), which is
 * why the target lives on the spec rather than being a single shared argument.
 */
export interface EventListenerSpec {
  target: EventTargetLike;
  type: string;
  handler: (event: Event) => void;
  options?: boolean | AddEventListenerOptions;
}

/**
 * Bind several listeners — possibly across different targets — under one effect
 * with one shared cleanup. The multi-event sibling of {@link useEventListener},
 * for the "several events, same lifetime" sites (useConnectionSync,
 * use-voice-input's focus/visibility effect).
 *
 * `specs` may be a fresh array literal each render: the handlers are read
 * through a ref (no rebind on handler identity), and the effect rebinds only
 * when the derived target/type/capture key changes. The array length may vary
 * between renders — this is ONE hook call with an internal loop, so the rules of
 * hooks are not violated.
 */
export function useEventListeners(specs: EventListenerSpec[]): void {
  const specsRef = useRef(specs);
  specsRef.current = specs;

  // Derived key over the binding-identity fields only (NOT the handlers). When
  // this string is unchanged the effect does not re-run, so swapping handlers
  // each render is free; adding/removing a spec, changing a target/signal by
  // identity, or flipping any boolean option rebinds. Identity (not a label) is
  // used for `target` and `signal` via a stable per-object id, so two different
  // same-tag elements — or a fresh `AbortSignal` — are distinguished correctly.
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
    // Snapshot the specs for THIS bind so each cleanup removes exactly what it
    // added, even if specsRef is later refreshed with a different array.
    const bound = specsRef.current.map((spec, i) => {
      const { capture, once, passive, signal } = normalizeOptions(spec.options);
      // Read the latest handler for this index at fire time, by index into the
      // live ref — so handler swaps without a rebind still call the new one.
      const listener = (event: Event) => specsRef.current[i]?.handler(event);
      spec.target?.addEventListener(spec.type, listener, { capture, once, passive, ...(signal ? { signal } : {}) });
      return { spec, listener, capture };
    });
    return () => {
      for (const { spec, listener, capture } of bound) {
        spec.target?.removeEventListener(spec.type, listener, { capture });
      }
    };
    // Deps: `key` encodes the binding identity of `specs` (targets/types/capture);
    // handlers ride `specsRef`, so a handler swap intentionally does not re-bind.
  }, [key]);
}

/** Normalize the boolean|object options form into the fields we care about. */
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

// Stable per-object id for the multi-form rebind key. A WeakMap keeps it
// identity-based (two distinct same-tag elements get distinct ids, so a target
// swap rebinds) without retaining the objects. `window`/`document` get one fixed
// id each on first use, so the common ambient-target case never spuriously
// rebinds. The counter only ever increments, so ids are stable for a session.
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
