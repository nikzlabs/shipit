// Inject a visible animation outside the React root for idle-frame tracing.
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
