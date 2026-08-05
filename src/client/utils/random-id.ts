/**
 * `crypto.randomUUID()` is a **secure-context-only** API. On a page served over
 * plain HTTP from anything other than `localhost` — a LAN IP, a Tailscale name,
 * a bare hostname behind a non-TLS reverse proxy — `window.crypto` still exists
 * but `randomUUID` is `undefined`.
 *
 * That broke every send on such a deployment. `sendUserMessage` mints its
 * request id *before* dispatching, so the `TypeError` aborted the send while
 * `MessageInput.handleSubmit` — which does not await `onSend` — went on to clear
 * the textarea: the composer emptied and nothing else happened. No bubble, no
 * spinner, no error banner; the only trace was an "Uncaught (in promise)
 * TypeError: crypto.randomUUID is not a function" in the browser console. It
 * reproduced on every `http://` deployment and on none of the localhost ones,
 * which is why it read as "only this one instance is broken".
 *
 * These ids are correlation handles (request ids, optimistic comment keys) —
 * they must be unique within one browser tab, never unguessable — so the
 * fallback's weaker randomness costs nothing.
 */
export function randomId(): string {
  const c: Crypto | undefined = typeof crypto !== "undefined" ? crypto : undefined;
  if (typeof c?.randomUUID === "function") return c.randomUUID();

  // `getRandomValues` is NOT secure-context-gated, so it is still available on
  // plain HTTP. Hand-assemble a v4 UUID from it.
  if (typeof c?.getRandomValues === "function") {
    const bytes = c.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // Last resort (ancient browsers, non-DOM test environments): still unique
  // enough for an in-tab correlation handle.
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}-${Math.random().toString(16).slice(2, 10)}`;
}
