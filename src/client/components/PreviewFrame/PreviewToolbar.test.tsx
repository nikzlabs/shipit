import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { PreviewToolbar } from "./PreviewToolbar.js";

// jsdom implements neither ResizeObserver nor layout. The stub keeps the
// collapse hook's callback ref from throwing; the hook then reads clientWidth
// as 0 and leaves the bar expanded, which is what these tests want — they drive
// the stage flags directly rather than trying to provoke a measurement jsdom
// could never perform.
vi.stubGlobal("ResizeObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
});

afterEach(cleanup);

const baseProps = {
  isRunning: true,
  showSelector: true,
  portSelectorOpen: false,
  setPortSelectorOpen: vi.fn(),
  activeStatus: "running",
  portLabel: "requirements",
  allPorts: [{ port: 5173, label: "requirements", status: "running" as const }],
  activePort: 5173,
  onSelectPort: vi.fn(),
  deviceFrameActive: false,
  deviceWidth: 390,
  deviceHeight: 844,
  deviceScale: 1,
  deviceScalePercent: 100,
  freeformPanelSize: null,
  hasErrors: false,
  errorCount: 0,
  errorPanelOpen: false,
  setErrorPanelOpen: vi.fn(),
  onRefresh: vi.fn(),
  onBack: vi.fn(),
  onHome: vi.fn(),
  activeSlotUrl: "http://a--5173.localhost/requirements",
  previewPath: "/requirements?focus=7",
  previewFullUrl: "http://a--5173.localhost/requirements?focus=7",
};

/** The element the collapse hook writes its stage flags onto. */
function toolbar(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>(".group\\/ptb");
  if (!el) throw new Error("toolbar root (group/ptb) not found");
  return el;
}

/**
 * Every text label in the bar must participate in the collapse ladder, either
 * by carrying a hide class itself or by sitting inside something that does.
 *
 * This is the shape of defect the layout tests cannot see: a label rendered as
 * a bare text node (as the non-selector service name was) is invisible to the
 * `data-hide-*` flags, so the bar keeps overflowing after every stage has been
 * spent and the original clipping comes back.
 */
function classOf(el: Element): string {
  // Not `el.className` — on an SVG that is an SVGAnimatedString, not a string.
  return el.getAttribute("class") ?? "";
}

function unladderedLabels(root: HTMLElement): string[] {
  const orphans: string[] = [];
  const walk = (node: Node, covered: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim() ?? "";
      // Separators and the error count pill are glyphs, not labels.
      if (text && text !== "|" && !/^\d+$/.test(text) && !covered) orphans.push(text);
      return;
    }
    if (!(node instanceof Element)) return;
    // The address is deliberately NOT in the ladder: it shrinks rather than
    // hides, which is the whole point of the design. Exclude its subtree.
    if (node.hasAttribute("data-preview-address")) return;
    const hides = classOf(node).includes("group-data-[hide-");
    node.childNodes.forEach((child) => walk(child, covered || hides));
  };
  walk(root, false);
  return orphans;
}

describe("PreviewToolbar collapse wiring", () => {
  it("starts fully expanded", () => {
    const { container } = render(<PreviewToolbar {...baseProps} />);
    const bar = toolbar(container);
    expect(bar.dataset.hideViewport).toBe("false");
    expect(bar.dataset.hideAutofix).toBe("false");
    expect(bar.dataset.hideService).toBe("false");
  });

  it("leaves no label outside the collapse ladder", () => {
    const { container } = render(<PreviewToolbar {...baseProps} />);
    expect(unladderedLabels(toolbar(container))).toEqual([]);
  });

  it("leaves no label outside the ladder without the port dropdown either", () => {
    // The branch that shipped the defect: `showSelector: false` rendered the
    // service name as a bare text node, which no hide class can reach.
    const { container } = render(<PreviewToolbar {...baseProps} showSelector={false} />);
    expect(unladderedLabels(toolbar(container))).toEqual([]);
  });

  it("leaves no label outside the ladder while errors are showing", () => {
    const { container } = render(
      <PreviewToolbar {...baseProps} hasErrors errorCount={3} />,
    );
    expect(unladderedLabels(toolbar(container))).toEqual([]);
  });

  it("hides each label at its own stage, cumulatively", () => {
    const { container } = render(<PreviewToolbar {...baseProps} />);
    const bar = toolbar(container);
    const hidden = () =>
      Array.from(bar.querySelectorAll("*"))
        .filter((el) => {
          const flag = /group-data-\[(hide-[a-z]+)=true\]/.exec(classOf(el))?.[1];
          if (!flag) return false;
          const key = flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
          return bar.dataset[key] === "true";
        })
        .map((el) => el.textContent?.trim())
        .filter(Boolean);

    expect(hidden()).toEqual([]);
    bar.dataset.hideViewport = "true";
    expect(hidden()).toContain("Responsive");
    bar.dataset.hideAutofix = "true";
    expect(hidden()).toContain("Auto-fix");
    bar.dataset.hideService = "true";
    expect(hidden()).toContain("requirements");
  });

  it("keeps the auto-fix checkbox named once its label is hidden", () => {
    // display:none takes the visible text out of accessible-name computation,
    // so without an explicit aria-label the collapse produces an unnamed
    // checkbox — a control a screen reader cannot announce.
    const { container } = render(<PreviewToolbar {...baseProps} />);
    toolbar(container).dataset.hideAutofix = "true";
    expect(screen.getByRole("checkbox", { name: "Auto-fix" })).toBeInTheDocument();
  });

  it("keeps the service name reachable from the trigger's tooltip", () => {
    const { container } = render(<PreviewToolbar {...baseProps} />);
    toolbar(container).dataset.hideService = "true";
    const trigger = screen.getByLabelText("Select preview port");
    expect(trigger).toHaveAttribute("title", "Preview: requirements");
  });

  it("keeps the copy button inside the address region", () => {
    const { container } = render(<PreviewToolbar {...baseProps} />);
    const address = container.querySelector("[data-preview-address]");
    expect(address).toBeInTheDocument();
    const region = address!.closest("button")!.parentElement!;
    expect(region.className).toContain("min-w-7");
    expect(within(region).getByRole("button")).toHaveAccessibleName(/Copy preview URL/);
  });
});
