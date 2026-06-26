/**
 * usePolling — the shared mechanics of "fetch a snapshot on an interval into
 * React state, with cleanup". Collapses the repeated
 * `[data/error/loading]` + `setInterval` + stale-guard + cleanup boilerplate
 * found across HostPanel, SessionDiagnosticsPanel, and useContainerHealthPoll.
 *
 * Design doc: docs/226-use-polling-hook/plan.md (originating catalog: SHI-212,
 * docs/225-component-dedup-refactors → "Explicitly not doing").
 *
 * What the hook owns (the mechanics every site repeats):
 *   - immediate-first-poll vs interval-only (`immediate`)
 *   - enable/disable gating (`enabled`) and optional pause-while-hidden
 *   - a stale-response guard so a poll that started before the loop was torn
 *     down (unmount, session switch, cadence change) never writes state
 *   - `data` / `error` / `loading` state and a manual `refresh()` trigger
 *
 * What the hook deliberately does NOT own (site-specific *semantics*):
 *   - the request itself — the caller's `poll` closure decides the URL/parse
 *   - what to do with a result beyond storing it — pass `onSuccess` (it runs
 *     under the same stale-guard, so caller-side store writes are protected)
 *   - a variable cadence — compute `intervalMs` in the caller and pass it; the
 *     loop re-arms when the value changes (e.g. fast-while-restarting)
 *
 * This is a *recurring snapshot* primitive. It is intentionally NOT a fit for
 * a converge-once-then-stop retry loop (see usePreviewHealthPoller, which the
 * doc explicitly excludes from migration).
 */

// eslint-disable-next-line no-restricted-imports -- useEffect: interval polling of external state with cleanup is the hook's entire purpose
import { useCallback, useEffect, useRef, useState } from "react";

export interface UsePollingOptions<T> {
  /** Performs one poll. May have side effects; should return the fresh value. */
  poll: () => Promise<T>;
  /** Interval between polls, in ms. Changing it re-arms the loop. */
  intervalMs: number;
  /** Gate the loop. When false, no polling happens. Default: true. */
  enabled?: boolean;
  /** Fire one poll immediately when the loop (re)starts. Default: true. */
  immediate?: boolean;
  /**
   * Also pause while `document.hidden` (and resume — with an immediate poll if
   * `immediate` — on re-show). Distinct from `enabled`, which is app-level
   * gating (e.g. a tab not selected). Default: false.
   */
  pauseWhenHidden?: boolean;
  /** Clear `data`/`error` when the loop is disabled. Default: false. */
  resetOnDisable?: boolean;
  /** Invoked after a successful, non-stale poll, with the fresh value. */
  onSuccess?: (data: T) => void;
  /** Invoked after a failed, non-stale poll, with the raw thrown value. */
  onError?: (error: unknown) => void;
}

export interface UsePollingResult<T> {
  /** Last successful poll result, or null before the first success. */
  data: T | null;
  /** Last error message, or null when the last poll succeeded. */
  error: string | null;
  /** True while a poll is in flight. */
  loading: boolean;
  /** Trigger a poll immediately, off-cycle (e.g. a refresh button). */
  refresh: () => Promise<void>;
}

export function usePolling<T>(options: UsePollingOptions<T>): UsePollingResult<T> {
  const {
    poll,
    intervalMs,
    enabled = true,
    immediate = true,
    pauseWhenHidden = false,
    resetOnDisable = false,
    onSuccess,
    onError,
  } = options;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Keep the latest caller closures in refs so passing fresh inline functions
  // each render does NOT re-arm the interval. Only the behavioral knobs
  // (enabled / intervalMs / immediate / pauseWhenHidden) re-arm the loop.
  const pollRef = useRef(poll);
  pollRef.current = poll;
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // Monotonic epoch, bumped on every effect cleanup (unmount, dep change). A
  // poll captures the epoch at its start; if the epoch has since moved, the
  // poll's result belongs to a torn-down loop and must not write state. This
  // is the stale-response guard — the same race useContainerHealthPoll guards
  // by hand on session switch (an old session's in-flight fetch resolving
  // after the new session's state is set).
  const epochRef = useRef(0);

  const runPoll = useCallback(async () => {
    const epoch = epochRef.current;
    setLoading(true);
    try {
      const result = await pollRef.current();
      if (epoch !== epochRef.current) return; // stale — drop before any setState
      setData(result);
      setError(null);
      onSuccessRef.current?.(result);
    } catch (e) {
      if (epoch !== epochRef.current) return; // stale — same guard on the error path
      setError(e instanceof Error ? e.message : String(e));
      onErrorRef.current?.(e);
    } finally {
      if (epoch === epochRef.current) setLoading(false);
    }
  }, []);

  // `refresh` runs under the current epoch, so a button-triggered poll is
  // stale-guarded just like an interval one.
  const refresh = useCallback(() => runPoll(), [runPoll]);

  // eslint-disable-next-line no-restricted-syntax -- interval polling of external state with cleanup; the hook's reason to exist
  useEffect(() => {
    if (!enabled) {
      if (resetOnDisable) {
        setData(null);
        setError(null);
        setLoading(false);
      }
      return;
    }

    let intervalId: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (intervalId !== null) return;
      if (immediate) void runPoll();
      intervalId = setInterval(() => void runPoll(), intervalMs);
    };
    const stop = () => {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    let onVisibility: (() => void) | null = null;
    if (pauseWhenHidden) {
      onVisibility = () => {
        if (document.hidden) stop();
        else start();
      };
      document.addEventListener("visibilitychange", onVisibility);
      if (!document.hidden) start();
    } else {
      start();
    }

    return () => {
      stop();
      if (onVisibility) document.removeEventListener("visibilitychange", onVisibility);
      epochRef.current += 1; // invalidate any in-flight poll from this loop
    };
  }, [enabled, intervalMs, immediate, pauseWhenHidden, resetOnDisable, runPoll]);

  return { data, error, loading, refresh };
}
