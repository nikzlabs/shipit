// `--eval` script for scripts/trace-idle-frames.mjs — puts a real ShipIt page
// into the "an indicator is spinning" condition using the app's OWN animation
// classes, so what gets measured is the app's stylesheet rather than a probe's.
//
// `scripts/fixtures/inject-probe-animation.js` injects its own linear keyframes
// on purpose (it was attributing the pairing, and had to be independent of the
// app). This one is the opposite instrument: it is how the docs/265 10 Hz rule
// is verified end to end, so it must inherit whatever `index.css` says today.
//
//   #spin       one `.tool-spinner`      (the streaming / todo indicator)
//   #mixed      `.tool-spinner` + `.animate-pulse` + `.animate-ping`, mounted
//               100 ms apart — the multi-indicator case, where costs add
//   #no-anim    inject nothing (the idle control)
//
// It returns the resolved `animation` shorthand of each injected element, which
// is the positive control: a run whose `animation` reads `linear` is measuring
// the un-stepped build whatever the numbers say.
(async () => {
  const hash = location.hash;

  await new Promise((r) => setTimeout(r, 6000)); // let the app settle

  const add = (className, top) => {
    const el = document.createElement("span");
    el.className = `${className} shipit-anim-probe`;
    el.style.cssText =
      `position:fixed;top:${top}px;left:40px;z-index:99999;display:inline-block;`
      + "width:12px;height:12px;background:#39f;border-radius:9999px";
    document.documentElement.appendChild(el);
    return el;
  };

  if (!hash.includes("no-anim")) {
    add("tool-spinner", 40);
    if (hash.includes("mixed")) {
      // Staggered on purpose: step boundaries run from each animation's own
      // start time, so simultaneous mounts would understate the real cost.
      await new Promise((r) => setTimeout(r, 100));
      add("animate-pulse", 60);
      await new Promise((r) => setTimeout(r, 100));
      add("animate-ping", 80);
    }
  }

  await new Promise((r) => setTimeout(r, 500));

  return {
    injected: [...document.querySelectorAll(".shipit-anim-probe")].map((el) => ({
      cls: el.className.replace(" shipit-anim-probe", ""),
      animation: getComputedStyle(el).animation,
      onScreen: el.getBoundingClientRect().top < innerHeight,
    })),
    contentVisibilityElements: [...document.querySelectorAll("*")]
      .filter((el) => getComputedStyle(el).contentVisibility === "auto").length,
    runningAnimations: document.getAnimations().filter((a) => a.playState === "running").length,
  };
})();
