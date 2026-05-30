/**
 * Push-to-talk dictation hook (docs/144).
 *
 * Owns the STT state machine: hotkey hold/release, mic capture, the
 * transcribe round-trip, and the resulting transcript. It is deliberately
 * **mode-agnostic** — it produces a transcript and notifies subscribers;
 * the consumer (MessageInput for Mode A, QuickCaptureOverlay for Mode B)
 * decides where to splice it.
 *
 * Review-before-send is enforced here by omission: the only output is
 * `onTranscript(cb: (text: string) => void)`. The hook has no concept of
 * "send" and is never given a reference to one, so auto-submit cannot be
 * wired without redesigning this contract (see plan "review-before-send
 * is mandatory").
 */

// eslint-disable-next-line no-restricted-imports -- global keyboard + media lifecycle with cleanup
import { useCallback, useEffect, useRef, useState } from "react";
import { startCapture, MicPermissionError, type ActiveCapture } from "./capture.js";

export type VoiceInputState = "idle" | "recording" | "transcribing" | "error";

const MIN_RECORDING_MS = 250;
const MAX_RECORDING_MS = 60_000;

const PTT_MODIFIERS = ["mod", "ctrl", "cmd", "meta", "alt", "opt", "shift"];

function normalizeKey(key: string): string {
  const k = key.toLowerCase();
  if (k === " " || k === "spacebar") return "space";
  return k;
}

/** Whether a held-down keyboard event matches the push-to-talk hotkey. */
export function eventMatchesPtt(e: KeyboardEvent, hotkey: string): boolean {
  const parts = hotkey.toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
  const key = parts.find((p) => !PTT_MODIFIERS.includes(p));
  if (!key) return false;
  const wantsMod = parts.includes("mod");
  const wantsCtrl = parts.includes("ctrl");
  const wantsMeta = parts.includes("cmd") || parts.includes("meta");
  const wantsAlt = parts.includes("alt") || parts.includes("opt");
  const wantsShift = parts.includes("shift");

  const modOk = wantsMod ? e.ctrlKey || e.metaKey : (!e.ctrlKey || wantsCtrl) && (!e.metaKey || wantsMeta);
  return (
    modOk &&
    e.ctrlKey === (wantsCtrl || (wantsMod && e.ctrlKey)) &&
    e.metaKey === (wantsMeta || (wantsMod && e.metaKey)) &&
    e.altKey === wantsAlt &&
    e.shiftKey === wantsShift &&
    normalizeKey(e.key) === key
  );
}

export interface UseVoiceInputOptions {
  /** Master enable — when false the hook is fully inert (no listeners). */
  enabled: boolean;
  /** Push-to-talk hotkey, e.g. "ctrl+shift+space". Empty disables the key path (button still works). */
  hotkey?: string;
  /** Whether to run the server-side LLM cleanup pass. Mirrors the settings toggle. */
  cleanup?: boolean;
  /** Optional language hint passed to STT + cleanup. */
  language?: string;
  /**
   * Current session id. A change aborts an in-flight recording and
   * discards the audio (the user switched sessions mid-press).
   */
  sessionId?: string;
}

export interface VoiceInputApi {
  state: VoiceInputState;
  elapsedMs: number;
  errorMessage: string | null;
  /** Non-fatal warning surfaced when cleanup fell through to the raw transcript. */
  cleanupWarning: string | null;
  startRecording: () => void;
  stopRecording: () => void;
  /** Subscribe to cleaned transcripts. Returns an unsubscribe fn. Text-only by design. */
  onTranscript: (cb: (text: string) => void) => () => void;
  dismissError: () => void;
}

interface TranscribeResponse {
  text: string;
  rawText: string;
  cleanupProvider?: string;
  cleanupErrorCode?: string;
}

export function useVoiceInput(options: UseVoiceInputOptions): VoiceInputApi {
  const { enabled, hotkey, cleanup = true, language, sessionId } = options;

  const [state, setState] = useState<VoiceInputState>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [cleanupWarning, setCleanupWarning] = useState<string | null>(null);

  const captureRef = useRef<ActiveCapture | null>(null);
  const subscribersRef = useRef<Set<(text: string) => void>>(new Set());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const capTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedAtRef = useRef(0);
  // Latest config for use inside event listeners without re-binding them.
  const cfgRef = useRef({ cleanup, language });
  cfgRef.current = { cleanup, language };
  // Live session id so a startCapture() that resolves AFTER a session switch
  // can discard its recording — the abort effect can't catch a capture that
  // wasn't assigned to captureRef yet (plan: switch mid-record → insert nothing).
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const clearTimers = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (capTimeoutRef.current) { clearTimeout(capTimeoutRef.current); capTimeoutRef.current = null; }
  }, []);

  const emitTranscript = useCallback((text: string) => {
    for (const cb of subscribersRef.current) cb(text);
  }, []);

  const transcribe = useCallback(async (blob: Blob, mimeType: string) => {
    setState("transcribing");
    try {
      const form = new FormData();
      form.append("audio", blob, "audio");
      form.append("cleanup", String(cfgRef.current.cleanup));
      if (cfgRef.current.language) form.append("language", cfgRef.current.language);
      // mimeType travels with the blob; included as a field for servers that prefer it.
      form.append("mimeType", mimeType);

      const res = await fetch("/api/voice/transcribe", { method: "POST", body: form });
      if (!res.ok) {
        let detail = "";
        try { detail = ((await res.json()) as { error?: string }).error ?? ""; } catch { /* ignore */ }
        console.error(`Voice transcribe failed (${res.status})`, detail);
        setErrorMessage("Couldn't transcribe — try again");
        setState("error");
        return;
      }
      const data = (await res.json()) as TranscribeResponse;
      if (data.cleanupErrorCode && cfgRef.current.cleanup) {
        setCleanupWarning("Cleanup unavailable — inserted raw transcript");
      } else {
        setCleanupWarning(null);
      }
      const text = (data.text ?? "").trim();
      if (text) emitTranscript(text);
      setState("idle");
    } catch (err) {
      console.error("Voice transcribe error", err);
      setErrorMessage("Couldn't transcribe — try again");
      setState("error");
    }
  }, [emitTranscript]);

  const finishRecording = useCallback(async () => {
    const capture = captureRef.current;
    if (!capture) return;
    captureRef.current = null;
    clearTimers();
    const duration = Date.now() - startedAtRef.current;
    if (duration < MIN_RECORDING_MS) {
      capture.abort();
      setState("idle");
      setElapsedMs(0);
      return;
    }
    try {
      const result = await capture.stop();
      setElapsedMs(0);
      await transcribe(result.blob, result.mimeType);
    } catch (err) {
      console.error("Voice capture stop failed", err);
      setState("idle");
      setElapsedMs(0);
    }
  }, [clearTimers, transcribe]);

  const startRecording = useCallback(() => {
    if (!enabled) return;
    if (captureRef.current) return;
    if (state === "transcribing") return;
    setErrorMessage(null);
    setCleanupWarning(null);
    // Mark intent synchronously so a fast keyup still finds an active recording.
    startedAtRef.current = Date.now();
    const startedSessionId = sessionIdRef.current;
    void (async () => {
      try {
        const capture = await startCapture();
        // A session switch or stop may have happened during getUserMedia.
        if (!enabled || sessionIdRef.current !== startedSessionId) { capture.abort(); return; }
        captureRef.current = capture;
        setState("recording");
        setElapsedMs(0);
        timerRef.current = setInterval(() => {
          setElapsedMs(Date.now() - startedAtRef.current);
        }, 200);
        capTimeoutRef.current = setTimeout(() => { void finishRecording(); }, MAX_RECORDING_MS);
      } catch (err) {
        const msg = err instanceof MicPermissionError ? err.message : "Could not start recording";
        setErrorMessage(msg);
        setState("error");
      }
    })();
  }, [enabled, state, finishRecording]);

  const stopRecording = useCallback(() => {
    if (!captureRef.current) return;
    void finishRecording();
  }, [finishRecording]);

  const abortRecording = useCallback(() => {
    const capture = captureRef.current;
    captureRef.current = null;
    clearTimers();
    if (capture) capture.abort();
    setElapsedMs(0);
    setState((s) => (s === "recording" ? "idle" : s));
  }, [clearTimers]);

  const onTranscript = useCallback((cb: (text: string) => void) => {
    subscribersRef.current.add(cb);
    return () => { subscribersRef.current.delete(cb); };
  }, []);

  const dismissError = useCallback(() => {
    setErrorMessage(null);
    setState((s) => (s === "error" ? "idle" : s));
  }, []);

  // Hotkey push-to-talk listeners.
  // eslint-disable-next-line no-restricted-syntax -- global PTT shortcut with cleanup
  useEffect(() => {
    if (!enabled || !hotkey) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return; // autorepeat — first keydown already started
      if (!eventMatchesPtt(e, hotkey)) return;
      e.preventDefault();
      startRecording();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!eventMatchesPtt(e, hotkey)) return;
      e.preventDefault();
      stopRecording();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [enabled, hotkey, startRecording, stopRecording]);

  // Stop (and transcribe) when the user tabs away mid-press — keyup is
  // unreliable once focus leaves the window.
  // eslint-disable-next-line no-restricted-syntax -- focus/visibility lifecycle with cleanup
  useEffect(() => {
    if (!enabled) return undefined;
    const onBlur = () => { if (captureRef.current) void finishRecording(); };
    const onVisibility = () => { if (document.hidden && captureRef.current) void finishRecording(); };
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, finishRecording]);

  // Session switch mid-recording → discard audio, insert nothing.
  // eslint-disable-next-line no-restricted-syntax -- abort capture when the active session changes
  useEffect(() => {
    abortRecording();
  }, [sessionId]);

  // Unmount cleanup.
  // eslint-disable-next-line no-restricted-syntax -- release MediaRecorder/timers on unmount
  useEffect(() => () => {
    clearTimers();
    captureRef.current?.abort();
    captureRef.current = null;
  }, [clearTimers]);

  return {
    state,
    elapsedMs,
    errorMessage,
    cleanupWarning,
    startRecording,
    stopRecording,
    onTranscript,
    dismissError,
  };
}
