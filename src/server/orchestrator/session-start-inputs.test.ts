/**
 * docs/324-scheduled-sessions req 5: every input through which a user picks a
 * session-start choice today maps to a `SessionStartParams` key (or to the
 * target or the prompt), so a schedule can set the same choice. Each table is
 * typed over the type the server reads the input through — a WebSocket message,
 * the WebSocket route's query, a route's body — so a new message, field, seed
 * key or body key does not compile until it is mapped here. A key the client
 * sends but the server's type does not name is never read, so it is no input.
 */
import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import type { ApiDeps } from "./api-routes.js";
import { registerEgressRoutes, type EgressSessionOverrideBody } from "./api-routes-egress.js";
import {
  registerSessionCrudRoutes,
  type HeadlessSessionBody,
  type SandboxSessionBody,
  type SessionCapabilitiesBody,
} from "./api-routes-session-crud.js";
import { registerSshRoutes, type SessionSshHostsBody } from "./api-routes-ssh.js";
import type { SessionSeedQuery } from "./route-registry.js";
import { START_PARAM_APPLIERS } from "./services/session-start-params.js";
import { START_PARAM_LABELS } from "../shared/session-start-labels.js";
import type {
  SessionStartParams,
  WsAnswerQuestion,
  WsClientMessage,
  WsSendMessage,
} from "../shared/types.js";

type StartInput =
  | keyof SessionStartParams
  | "target"
  | "prompt"
  | { notAChoice: string };

type Fields<T> = Record<keyof T, StartInput>;

type SetMessage = Extract<WsClientMessage, { type: `set_${string}` }>;

const SET_MESSAGES: { [M in SetMessage as M["type"]]: Fields<Omit<M, "type">> } = {
  set_agent: { agentId: "agent" },
  set_model: { model: "model", serviceId: "serviceId", billingMode: "billingMode" },
  set_reasoning: { effort: "reasoning" },
  set_role: { roleName: "role" },
};

const WS_SEED_QUERY: Fields<SessionSeedQuery> = {
  agent: "agent",
  model: "model",
  reasoning: "reasoning",
  service: "serviceId",
  billingMode: "billingMode",
  role: "role",
};

type AssertExtends<T extends U, U> = T;
export type _SendCarriesStartMode = AssertExtends<
  NonNullable<WsSendMessage["permissionMode"]>,
  NonNullable<SessionStartParams["permissionMode"]>
>;
export type _AnswerCarriesStartMode = AssertExtends<
  NonNullable<WsAnswerQuestion["permissionMode"]>,
  NonNullable<SessionStartParams["permissionMode"]>
>;

/** The composer keeps the permission mode in the browser and sends it with each message. */
const PER_MESSAGE: {
  send_message: Fields<Pick<WsSendMessage, "permissionMode">>;
  answer_question: Fields<Pick<WsAnswerQuestion, "permissionMode">>;
} = {
  send_message: { permissionMode: "permissionMode" },
  answer_question: { permissionMode: "permissionMode" },
};

/** The routes Quick Capture, the composer, the Sandbox dialog and Session settings use for session choices. */
const HTTP_INPUTS: {
  "POST /api/sessions/headless": Fields<HeadlessSessionBody>;
  "PUT /api/egress/session/:id": Fields<EgressSessionOverrideBody>;
  "PUT /api/sessions/:id/ssh-hosts": Fields<SessionSshHostsBody>;
  "POST /api/sessions/sandbox": Fields<SandboxSessionBody>;
  "PUT /api/sessions/:id/capabilities": Fields<SessionCapabilitiesBody>;
} = {
  "POST /api/sessions/headless": {
    repoUrl: "target",
    initialPrompt: "prompt",
    issueRef: "prompt",
    agent: "agent",
    model: "model",
    reasoning: "reasoning",
    armAutoMerge: "armAutoMerge",
    serviceId: "serviceId",
    billingMode: "billingMode",
    role: "role",
    dictated: { notAChoice: "it records that the prompt was dictated, not how the session runs" },
    networkMode: "networkMode",
  },
  "PUT /api/egress/session/:id": { override: "networkMode" },
  "PUT /api/sessions/:id/ssh-hosts": { granted: "sshHosts" },
  "POST /api/sessions/sandbox": { capabilities: "target" },
  "PUT /api/sessions/:id/capabilities": { capabilities: "target" },
};

function allMappings(): { input: string; target: StartInput }[] {
  const tables: Record<string, Record<string, StartInput>> = {
    ...SET_MESSAGES,
    "ws seed query": WS_SEED_QUERY,
    ...PER_MESSAGE,
    ...HTTP_INPUTS,
  };
  return Object.entries(tables).flatMap(([where, fields]) =>
    Object.entries(fields).map(([field, target]) => ({ input: `${where} · ${field}`, target })));
}

describe("session-start inputs (docs/324-scheduled-sessions req 5)", () => {
  const paramKeys = Object.keys(START_PARAM_APPLIERS);

  it("applies and describes the same parameters", () => {
    expect(Object.keys(START_PARAM_LABELS).sort()).toEqual([...paramKeys].sort());
  });

  it("maps every input to a parameter, the target or the prompt, or says why it is not a choice", () => {
    const unmapped = allMappings().filter(({ target }) =>
      typeof target === "string"
        ? !paramKeys.includes(target) && target !== "target" && target !== "prompt"
        : target.notAChoice.trim() === "");
    expect(unmapped).toEqual([]);
  });

  it("gives every parameter an input, so the list is not missing one", () => {
    const reached = new Set(allMappings().map(({ target }) => target));
    expect(paramKeys.filter((key) => !reached.has(key as keyof SessionStartParams))).toEqual([]);
  });

  it("finds each listed HTTP route where the list says it is", async () => {
    const app = Fastify();
    const deps = { egressAllowlistStore: {} } as unknown as ApiDeps;
    await registerEgressRoutes(app, deps);
    await registerSshRoutes(app, deps);
    await registerSessionCrudRoutes(app, deps);
    await app.ready();

    const missing = Object.keys(HTTP_INPUTS).filter((route) => {
      const [method, url] = route.split(" ");
      return !app.hasRoute({ method: method as "PUT" | "POST", url });
    });
    expect(missing).toEqual([]);
    await app.close();
  });
});
