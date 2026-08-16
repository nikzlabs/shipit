// `--eval` script for scripts/trace-idle-frames.mjs — puts a real page into the
// "something is animating" condition without needing an agent turn to be running.
//
// It appends a 12x12 rotating square to <html>, i.e. outside the app's React root
// and with no app ancestor, so nothing about the app's own layout can be blamed
// for what the animation does. `transform: rotate()` is the same property
// `.tool-spinner` animates.
//
// Two knobs, both from the URL fragment, so one file covers every condition:
//
//   #no-cv     also force `content-visibility: visible` everywhere, removing the
//              internal observers Chrome keeps for `content-visibility: auto`
//   #no-anim   skip the probe entirely (the idle control)
//
// Combine with `--init=scripts/fixtures/neuter-intersection-observer.js` to
// remove the *other* observer source. The reason the probe must be visible:
// an offscreen animating element still drives main-thread frames at display rate
// but produces no compositor frames, so an accidentally-offscreen probe measures
// a different thing than the one under test.
(async () => {
  const hash = location.hash;

  await new Promise((r) => setTimeout(r, 6000)); // let the app settle

  if (hash.includes("no-cv")) {
    const off = document.createElement("style");
    off.textContent = "*{content-visibility:visible !important}";
    document.head.appendChild(off);
  }

  if (!hash.includes("no-anim")) {
    const style = document.createElement("style");
    style.textContent =
      "@keyframes probe-rot { to { transform: rotate(360deg) } }" +
      ".probe-rot { animation: probe-rot 1s linear infinite; }";
    document.head.appendChild(style);

    const probe = document.createElement("span");
    probe.className = "probe-rot";
    probe.style.cssText =
      "position:fixed;top:40px;left:40px;z-index:99999;display:inline-block;width:12px;height:12px;background:#39f";
    document.documentElement.appendChild(probe);
  }

  await new Promise((r) => setTimeout(r, 500));

  const rect = document.querySelector(".probe-rot")?.getBoundingClientRect();
  return {
    probeVisible: rect ? rect.width > 0 && rect.top >= 0 && rect.top < innerHeight : false,
    contentVisibilityElements: [...document.querySelectorAll("*")]
      .filter((el) => getComputedStyle(el).contentVisibility === "auto").length,
    runningAnimations: document.getAnimations().filter((a) => a.playState === "running").length,
  };
})();
