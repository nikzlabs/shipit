/**
 * `navigator.clipboard` is a secure-context-only API: on a page served over plain HTTP from
 * anything other than `localhost` it is `undefined`, the same class of failure as
 * `random-id.ts`. A selection-based `execCommand("copy")` works there, so it is the fallback.
 */
export async function copyText(value: string): Promise<boolean> {
  const clipboard: Clipboard | undefined = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (typeof clipboard?.writeText === "function") {
    try {
      await clipboard.writeText(value);
      return true;
    } catch {
      // A rejected write (permission policy) can still succeed through a selection.
    }
  }
  return copyViaSelection(value);
}

// A selected <span> does not take focus, so a dialog's focus trap cannot undo the selection.
function copyViaSelection(value: string): boolean {
  const selection = document.getSelection();
  if (!selection) return false;
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
  const saved = Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i));

  const span = document.createElement("span");
  span.textContent = value;
  span.style.position = "fixed";
  span.style.top = "0";
  span.style.opacity = "0";
  span.style.whiteSpace = "pre";
  span.style.userSelect = "text";
  // Without this the browser also copies the span as HTML, hidden styling included.
  span.addEventListener("copy", (event) => {
    event.stopPropagation();
    if (!event.clipboardData) return;
    event.clipboardData.setData("text/plain", value);
    event.preventDefault();
  });
  document.body.appendChild(span);
  try {
    const range = document.createRange();
    range.selectNodeContents(span);
    selection.removeAllRanges();
    selection.addRange(range);
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the only clipboard write outside a secure context
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    selection.removeAllRanges();
    // A range has no direction, so a backwards selection is restored from its anchor and focus.
    if (saved.length === 1 && anchorNode && focusNode) {
      selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
    } else {
      for (const range of saved) selection.addRange(range);
    }
    span.remove();
  }
}
