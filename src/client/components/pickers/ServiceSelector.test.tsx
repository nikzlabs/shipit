/**
 * docs/252 — the service control carries the **vendor's mark**, in the menu and
 * on the trigger.
 *
 * What is worth pinning is not that a glyph exists but that it never replaces
 * anything: the name stays on every row and on the trigger, and a selection the
 * list no longer holds (a pin whose credential went away) gets no mark at all —
 * a logo beside "No service" would be a logo for nothing.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ServiceSelector } from "./ServiceSelector.js";
import type { ServiceChoice } from "./model-choice.js";
import { queryVendorMark } from "../vendor-mark-test-helpers.js";

const services: ServiceChoice[] = [
  { serviceId: "anthropic", serviceName: "Anthropic", billingMode: "sub" },
  { serviceId: "deepseek", serviceName: "DeepSeek", billingMode: "key" },
];

afterEach(cleanup);

describe("ServiceSelector marks", () => {
  it("draws a mark on every row, without dropping the name", async () => {
    const user = userEvent.setup();
    render(
      <ServiceSelector
        services={services}
        selected={{ serviceId: "anthropic", billingMode: "sub" }}
        onChange={() => {}}
        idPrefix="test"
      />,
    );
    await user.click(screen.getByTestId("test-service-trigger"));

    for (const service of services) {
      const row = screen.getByTestId(`test-service-option-${service.serviceId}:${service.billingMode}`);
      expect(queryVendorMark(row), `no mark for ${service.serviceId}`).not.toBeNull();
      expect(row).toHaveTextContent(service.serviceName);
    }
  });

  it("marks the trigger with the service in force", () => {
    render(
      <ServiceSelector
        services={services}
        selected={{ serviceId: "deepseek", billingMode: "key" }}
        onChange={() => {}}
        idPrefix="test"
      />,
    );

    const trigger = screen.getByTestId("test-service-trigger");
    expect(queryVendorMark(trigger)).not.toBeNull();
    expect(trigger).toHaveTextContent("DeepSeek");
  });

  it("draws no mark when the selection is not in the list", () => {
    // A pin whose credential went away. The trigger names it — a control that
    // read as empty while the server still held a pin is the bug `fallbackLabel`
    // exists for — but there is no service here to draw.
    render(
      <ServiceSelector
        services={services}
        selected={{ serviceId: "gone", billingMode: "key" }}
        onChange={() => {}}
        idPrefix="test"
        fallbackLabel="gone"
      />,
    );

    const trigger = screen.getByTestId("test-service-trigger");
    expect(trigger).toHaveTextContent("gone");
    // The caret is still there and is an svg too — hence the viewBox check
    // rather than a count, which would break the day the trigger grows another
    // glyph.
    expect(queryVendorMark(trigger)).toBeNull();
  });
});
