# Agent Interface SDK

ShipIt injects a small `window.shipit` API into HTML shown as the active service Preview or active rendered Present artifact. Use it when an interface you build should collect values and send a composed instruction back to the agent that owns the session.

```ts
await window.shipit?.ready;
await window.shipit.agent.sendMessage({ text: "Apply the settings selected in the form" });
```

The call may run from a click, form submission, load callback, timer, or other application logic. A recent user gesture is not required. Avoid accidental loops: do not send again merely because the page reloaded after the agent changed a file.

## Detection and visibility

Presence alone does not prove embedding. Wait for the parent handshake and feature-detect `embedded`. `visibility.current` is `null` until the first authoritative host message.

```ts
await window.shipit?.ready;
if (window.shipit?.embedded) {
  const unsubscribe = window.shipit.visibility.subscribe(async (visible) => {
    if (visible) await audioContext?.resume();
    else await audioContext?.suspend();
  });
}
```

Use visibility to pause audio, media, animation, polling, and expensive timers. The subscription immediately receives an already-known value and returns an unsubscribe function.

`visible` means **on screen in the ShipIt window**, not merely "loaded". It is false when the surface is not the selected one, when the pane is behind an overlay, and — the case a page cannot detect for itself — when the frame's element has been scrolled or clipped outside the ShipIt viewport. That last one matters for animation: a browser stops delivering `requestAnimationFrame` to a cross-origin frame whose element is out of view, and it does so silently. Inside such a page `document.hidden` stays false, an `IntersectionObserver` on your own content stays intersecting (it measures against your frame's viewport, which did not move), and no `longtask` or `long-animation-frame` entry is recorded, because frames are withheld rather than made slow. `window.shipit.visibility` is the only signal that reports the condition.

So do not treat `document.hidden` as equivalent, and do not read a stalled `rAF` loop as a fault in your own drawing code. Gate the loop on visibility and it pauses on purpose instead of stalling by surprise:

```ts
let running = false;
window.shipit?.visibility.subscribe((visible) => {
  if (visible && !running) { running = true; requestAnimationFrame(tick); }
  else running = visible;
});
function tick(t) { if (!running) return; draw(t); requestAnimationFrame(tick); }
```

## Message behavior

- The page supplies only final `text`; it cannot select a session or spoof Preview/Present provenance.
- ShipIt shows a normal user bubble with a `Preview` or `Present` Agent Interface SDK badge.
- The agent receives ShipIt-authored context explaining that the instruction came through the SDK and may have been automatic.
- Dispatch follows normal behavior: start when idle, live-steer when enabled and supported, otherwise queue.
- The Promise resolves when ShipIt accepts the request, not when the agent finishes.
- Empty messages and messages over 50,000 characters are rejected.
- Repository-backed sessions require **Trust this repository**; the server enforces it.
- Only the active Preview or rendered Present HTML frame can send. Background and ordinary file/gallery/diff frames are rejected.

## Form example

```html
<form id="setup"><input name="framework" required><button>Apply setup</button></form>
<output id="status"></output>
<script>
  setup.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(setup));
    try {
      await window.shipit.ready;
      await window.shipit.agent.sendMessage({
        text: `Apply this setup:\n${JSON.stringify(values, null, 2)}`,
      });
      status.textContent = "Sent to agent";
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Send failed";
    }
  });
</script>
```

