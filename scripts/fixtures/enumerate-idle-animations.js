/**
 * Answer "what is animating, and what observes, on a page that is doing nothing?"
 *
 * docs/265's idle-compositing finding needs BOTH ingredients present to cost
 * anything: a live IntersectionObserver and an always-on animation. The doc
 * measured the pairing but assumed the animation was the tool spinner. This
 * enumerates what is actually running, so the assumption is replaced by a list.
 *
 * Run as `--eval` for `scripts/trace-idle-frames.mjs`, or paste into a console.
 * Its resolved value is a JSON summary; the per-animation rows name the element
 * so a cost can be traced back to the component that drew it.
 *
 * `document.getAnimations()` reports every running CSSAnimation/CSSTransition
 * regardless of whether it is composited, which is what we want: the doc's rule
 * is about the browser SCHEDULING a frame, and a composited animation schedules
 * one every vsync just as a main-thread one does.
 */
(() => {
  const describe = (el) => {
    if (!el || !el.tagName) return "(no element)";
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" && el.className
      ? `.${el.className.trim().split(/\s+/).slice(0, 6).join(".")}`
      : "";
    const title = el.getAttribute?.("title");
    return `${el.tagName.toLowerCase()}${id}${cls}${title ? ` [title=${JSON.stringify(title)}]` : ""}`;
  };

  const anims = document.getAnimations().map((a) => {
    const el = a.effect?.target ?? null;
    const timing = a.effect?.getTiming?.() ?? {};
    // An animation that will end is not an "always-on" one; only an infinite
    // iteration count keeps the browser scheduling frames forever.
    const infinite = timing.iterations === Infinity || timing.iterations === null;
    const rect = el?.getBoundingClientRect?.();
    return {
      name: a.animationName ?? a.transitionProperty ?? "(unnamed)",
      state: a.playState,
      infinite,
      durationMs: timing.duration,
      element: describe(el),
      // An offscreen animating element still drives main-thread frames while
      // drawing nothing (docs/265's own trap), so record visibility rather than
      // filtering on it.
      onScreen: !!rect && rect.width > 0 && rect.height > 0
        && rect.bottom > 0 && rect.right > 0
        && rect.top < innerHeight && rect.left < innerWidth,
    };
  });

  const running = anims.filter((a) => a.state === "running" && a.infinite);
  const byName = {};
  for (const a of running) byName[a.name] = (byName[a.name] ?? 0) + 1;

  return {
    href: location.href,
    domNodes: document.getElementsByTagName("*").length,
    contentVisibilityElements: [...document.querySelectorAll("*")]
      .filter((el) => getComputedStyle(el).contentVisibility === "auto").length,
    totalAnimations: anims.length,
    runningInfinite: running.length,
    byName,
    detail: running,
  };
})();
