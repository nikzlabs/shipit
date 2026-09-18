import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagedServiceState } from "../stores/preview-store.js";
import { ServiceList } from "./ServiceList.js";

const running: ManagedServiceState = { name: "web", status: "running", port: 5173, preview: "auto" };
const stopped: ManagedServiceState = { name: "db", status: "stopped", preview: "manual" };

function renderList(services: ManagedServiceState[]) {
  const onSelectPreview = vi.fn();
  const onSelect = vi.fn();
  render(
    <ServiceList
      services={services}
      onStart={vi.fn()}
      onStop={vi.fn()}
      onRestart={vi.fn()}
      onSelectPreview={onSelectPreview}
      onSelect={onSelect}
    />,
  );
  return { onSelectPreview, onSelect };
}

afterEach(cleanup);

describe("ServiceList", () => {
  it("pivots the preview to a running service when its name is clicked", async () => {
    const { onSelectPreview, onSelect } = renderList([running]);

    await userEvent.click(screen.getByRole("button", { name: "web" }));

    expect(onSelectPreview).toHaveBeenCalledWith("web", 5173);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("opens the log view from the log button, not the name", async () => {
    const { onSelectPreview, onSelect } = renderList([running]);

    await userEvent.click(screen.getByRole("button", { name: "View web logs" }));

    expect(onSelect).toHaveBeenCalledWith("web");
    expect(onSelectPreview).not.toHaveBeenCalled();
  });

  it("leaves the name of a service with no preview as a plain label", () => {
    renderList([stopped]);

    expect(screen.queryByRole("button", { name: "db" })).not.toBeInTheDocument();
    expect(screen.getByText("db")).toBeInTheDocument();
  });
});
