import { describe, it, expect, vi } from "vitest";
import type Docker from "dockerode";

import {
  mapEngineContainer,
  listProjectContainers,
  listAllComposeProjects,
  inspectContainerViaApi,
} from "./compose-container-listing.js";

function row(overrides: Partial<Docker.ContainerInfo> = {}): Docker.ContainerInfo {
  return {
    Id: "c1",
    State: "running",
    Labels: {
      "com.docker.compose.project": "shipit-abc123",
      "com.docker.compose.service": "web",
    },
    NetworkSettings: { Networks: { "shipit-session-s1": { IPAddress: "172.20.0.4" } } },
    ...overrides,
  } as Docker.ContainerInfo;
}

describe("mapEngineContainer", () => {
  it("reads the service, state and per-network address a listing row carries", () => {
    expect(mapEngineContainer(row())).toEqual({
      ref: "c1",
      service: "web",
      state: "running",
      oneOff: false,
      networks: { "shipit-session-s1": "172.20.0.4" },
    });
  });

  it("marks a `docker compose run` container one-off, so it is never mistaken for the service", () => {
    const mapped = mapEngineContainer(row({
      Labels: {
        "com.docker.compose.project": "shipit-abc123",
        "com.docker.compose.service": "web",
        "com.docker.compose.oneoff": "True",
      },
    } as Partial<Docker.ContainerInfo>));
    expect(mapped.oneOff).toBe(true);
  });

  it("reports an empty network map rather than none, so no address is read as unknown", () => {
    const mapped = mapEngineContainer(row({ NetworkSettings: undefined } as Partial<Docker.ContainerInfo>));
    expect(mapped.networks).toEqual({});
  });

  // The listing never carries one, which is why an exited container still needs an inspect.
  it("reports no exit code", () => {
    expect(mapEngineContainer(row({ State: "exited" }))).not.toHaveProperty("exitCode");
  });
});

describe("listProjectContainers", () => {
  it("asks only for the one project's containers, stopped ones included", async () => {
    const listContainers = vi.fn(async () => [row()]);
    const docker = { listContainers } as unknown as Docker;

    const result = await listProjectContainers(docker, "shipit-abc123", ["stack=x"])();

    expect(listContainers).toHaveBeenCalledWith({
      all: true,
      filters: { label: ["com.docker.compose.project=shipit-abc123", "stack=x"] },
    });
    expect(result).toHaveLength(1);
  });
});

describe("listAllComposeProjects", () => {
  it("groups one host-wide listing by project, which is what makes the backstop flat", async () => {
    const docker = {
      listContainers: vi.fn(async () => [
        row(),
        row({ Id: "c2", Labels: { "com.docker.compose.project": "shipit-def456", "com.docker.compose.service": "db" } } as Partial<Docker.ContainerInfo>),
        row({ Id: "c3" }),
      ]),
    } as unknown as Docker;

    const byProject = await listAllComposeProjects(docker);

    expect([...byProject.keys()].sort()).toEqual(["shipit-abc123", "shipit-def456"]);
    expect(byProject.get("shipit-abc123")?.map((c) => c.ref)).toEqual(["c1", "c3"]);
  });

  it("drops a container carrying no project label, which belongs to no session", async () => {
    const docker = {
      listContainers: vi.fn(async () => [row({ Labels: {} } as Partial<Docker.ContainerInfo>)]),
    } as unknown as Docker;

    expect((await listAllComposeProjects(docker)).size).toBe(0);
  });
});

describe("inspectContainerViaApi", () => {
  it("reads the exit code and the OOM flag the listing omits", async () => {
    const docker = {
      getContainer: vi.fn(() => ({
        inspect: vi.fn(async () => ({
          State: { ExitCode: 137, OOMKilled: true },
          NetworkSettings: { Networks: {} },
        })),
      })),
    } as unknown as Docker;

    expect(await inspectContainerViaApi(docker)("c1")).toEqual({
      exitCode: 137,
      oomKilled: true,
      networks: {},
    });
  });

  it("omits an OOM flag the daemon did not state, rather than reporting false", async () => {
    const docker = {
      getContainer: vi.fn(() => ({
        inspect: vi.fn(async () => ({ State: { ExitCode: 1 }, NetworkSettings: { Networks: {} } })),
      })),
    } as unknown as Docker;

    expect(await inspectContainerViaApi(docker)("c1")).not.toHaveProperty("oomKilled");
  });
});
