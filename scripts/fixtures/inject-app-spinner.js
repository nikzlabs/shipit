// Inject the app's own animation classes for idle-frame tracing.
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
      // Stagger mounts to keep their step boundaries independent.
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
