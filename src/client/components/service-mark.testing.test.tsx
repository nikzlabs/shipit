/**
 * The discriminator itself, pinned.
 *
 * {@link queryServiceMark} exists because four assertions need to tell a vendor
 * mark apart from the other glyphs on the same row, and the CSS spelling of that
 * stopped working under jsdom 30 (its docstring has the mechanism). Those
 * assertions now all route through one function, which concentrates the risk: a
 * helper that answered "yes" to any `svg` would make every positive call site
 * vacuous, and one that could never match would make the negative one vacuous —
 * **in both directions the suites stay green while asserting nothing**, which is
 * precisely the failure that just shipped. So the two halves are pinned here
 * rather than trusted.
 *
 * Deliberately built from a real {@link ServiceLogo} and a real Phosphor glyph
 * rather than hand-written `<svg>` literals: a fixture asserting against markup
 * this file made up would keep passing the day `ServiceLogo` changes grid.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { CheckIcon } from "@phosphor-icons/react";
import { ServiceLogo } from "./ServiceLogo.js";
import { allServices } from "../../server/shared/catalogue/index.js";
import { queryServiceMark } from "./service-mark.testing.js";

afterEach(cleanup);

describe("queryServiceMark", () => {
  const anthropic = () => allServices().find((s) => s.id === "anthropic")!;

  it("finds the mark a real ServiceLogo draws", () => {
    const { container } = render(<ServiceLogo service={anthropic()} />);
    expect(queryServiceMark(container)).not.toBeNull();
  });

  it("refuses a Phosphor glyph — the whole reason it is not querySelector('svg')", () => {
    // A checkmark is what a selected picker row carries beside its mark, and a
    // caret is what every trigger carries, so this is the exact false positive
    // the call sites are guarding against.
    const { container } = render(<CheckIcon />);
    expect(container.querySelector("svg")).not.toBeNull();
    expect(queryServiceMark(container)).toBeNull();
  });

  it("finds the mark among the glyphs it sits beside, not merely on its own", () => {
    // Every real call site hands it a row or a trigger, never a lone mark.
    const { container } = render(
      <span>
        <CheckIcon />
        <ServiceLogo service={anthropic()} />
      </span>,
    );
    expect(queryServiceMark(container)).not.toBeNull();
  });
});
