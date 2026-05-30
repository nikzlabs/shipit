/**
 * MediaRecorder wrapper (docs/144).
 *
 * Captures a single push-to-talk utterance: open the mic, record into
 * `audio/webm;opus` (or whatever the browser picks — Safari produces
 * `audio/mp4`), and on stop assemble the chunks into one Blob. No
 * streaming partials — the whole utterance is captured, then handed off
 * for transcription (see plan "Why no mid-utterance partials").
 */

const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) {
    return undefined;
  }
  for (const t of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return undefined;
}

export interface CaptureResult {
  blob: Blob;
  mimeType: string;
  durationMs: number;
}

/**
 * An in-progress recording. `stop()` resolves with the assembled audio;
 * `abort()` discards everything (used on session switch). Both release
 * the underlying mic track.
 */
export interface ActiveCapture {
  stop: () => Promise<CaptureResult>;
  abort: () => void;
}

export class MicPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MicPermissionError";
  }
}

/**
 * Begin capturing audio. Throws `MicPermissionError` if the user denies
 * (or there is no) microphone. The returned object owns the media stream
 * and the recorder; the caller must eventually call `stop()` or
 * `abort()` to release the mic.
 */
export async function startCapture(): Promise<ActiveCapture> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new MicPermissionError("Microphone capture is not supported in this browser");
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    const name = (err as DOMException)?.name;
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new MicPermissionError("Microphone access denied — enable it in your browser settings");
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      throw new MicPermissionError("No microphone found");
    }
    throw new MicPermissionError(`Could not access the microphone: ${(err as Error).message}`);
  }

  const mimeType = pickMimeType();
  const recorder = mimeType
    ? new MediaRecorder(stream, { mimeType })
    : new MediaRecorder(stream);
  const chunks: Blob[] = [];
  const startedAt = Date.now();
  let stopped = false;

  recorder.addEventListener("dataavailable", (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  });

  function releaseStream(): void {
    for (const track of stream.getTracks()) track.stop();
  }

  recorder.start();

  return {
    stop(): Promise<CaptureResult> {
      if (stopped) return Promise.reject(new Error("Capture already stopped"));
      stopped = true;
      return new Promise<CaptureResult>((resolve, reject) => {
        recorder.addEventListener("stop", () => {
          releaseStream();
          const type = recorder.mimeType || mimeType || "audio/webm";
          const blob = new Blob(chunks, { type });
          if (blob.size === 0) {
            reject(new Error("No audio captured"));
            return;
          }
          resolve({ blob, mimeType: type, durationMs: Date.now() - startedAt });
        });
        try {
          recorder.stop();
        } catch (err) {
          releaseStream();
          reject(err as Error);
        }
      });
    },
    abort(): void {
      if (stopped) return;
      stopped = true;
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch {
        // ignore — we're discarding anyway
      }
      releaseStream();
    },
  };
}
