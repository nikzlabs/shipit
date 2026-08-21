// `--init` script for scripts/trace-idle-frames.mjs — stubs IntersectionObserver
// out before any page script runs, so the app can never create a live one.
//
// It has to be an --init script rather than something injected after load.
// Disconnecting observers once the app is up looks equivalent and is not: the
// sidebar re-creates them as it re-renders, so a disconnect pass at t=6s leaves
// live observers behind and the condition silently fails to hold. That mistake
// produced a "removing the observers changes nothing" result on the first
// attempt at this measurement (docs/265).
(() => {
  window.IntersectionObserver = class {
    constructor() {}
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
})();
