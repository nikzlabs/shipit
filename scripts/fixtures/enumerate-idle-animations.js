/** Enumerate running animations for the idle-frame trace. */
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
    const infinite = timing.iterations === Infinity || timing.iterations === null;
    const rect = el?.getBoundingClientRect?.();
    return {
      name: a.animationName ?? a.transitionProperty ?? "(unnamed)",
      state: a.playState,
      infinite,
      durationMs: timing.duration,
      element: describe(el),
      // Offscreen animations still schedule frames.
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
