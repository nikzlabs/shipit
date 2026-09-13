import { describe, it, expect } from "vitest";
import {
  DIRECT_CALL_PATHS,
  SERVICES,
  apiModelIdFor,
  credentialPermitsDirectCall,
  directCallPathFor,
  directCallSelections,
  getMode,
  joinEndpoint,
  resolveDirectCall,
} from "./index.js";
import type { ApiStyle, BillingModeDef, ModelDef, ModelSelection, ServiceDef } from "./index.js";

const CATALOGUE: readonly ServiceDef[] = SERVICES;

function everyRow(): { service: ServiceDef; mode: BillingModeDef; model: ModelDef }[] {
  return CATALOGUE.flatMap((service) =>
    service.modes.flatMap((mode) => mode.models.map((model) => ({ service, mode, model }))),
  );
}

function selectionOf(row: { service: ServiceDef; mode: BillingModeDef; model: ModelDef }): ModelSelection {
  return { serviceId: row.service.id, billingMode: row.mode.kind, modelId: row.model.id };
}

function label(selection: ModelSelection): string {
  return `${selection.serviceId}/${selection.billingMode}/${selection.modelId}`;
}

describe("the capability fails closed", () => {
  it("a credential that declares nothing may not be called directly", () => {
    for (const { service, mode } of everyRow()) {
      for (const credential of mode.credentials) {
        const declared = credential.via === "string" && credential.directCall !== undefined;
        expect(
          credentialPermitsDirectCall(service.id, mode.kind, credential.via),
          `${service.id}/${mode.kind}/${credential.via}`,
        ).toBe(declared);
      }
    }
  });

  it("no model of an undeclared mode resolves to a direct call", () => {
    for (const row of everyRow()) {
      if (credentialPermitsDirectCall(row.service.id, row.mode.kind, "string")) continue;
      expect(resolveDirectCall(selectionOf(row)), label(selectionOf(row))).toBeUndefined();
    }
  });

  it("an account credential is never directly callable", () => {
    for (const { service, mode } of everyRow()) {
      expect(credentialPermitsDirectCall(service.id, mode.kind, "account")).toBe(false);
    }
  });

  it("a permitted credential whose styles have no client still resolves to nothing", () => {
    for (const row of everyRow()) {
      if (!credentialPermitsDirectCall(row.service.id, row.mode.kind, "string")) continue;
      const reachable = row.model.styles.some(
        (style) => directCallPathFor(style) !== undefined && row.mode.endpoints[style] !== undefined,
      );
      if (reachable) continue;
      expect(resolveDirectCall(selectionOf(row)), label(selectionOf(row))).toBeUndefined();
    }
  });
});

describe("nothing already in the catalogue decides the capability", () => {
  // The two rules docs/299's reviews refuted, stated as properties of the
  // shipped rows so a re-derivation from either one goes red here.
  it("the billing mode does not decide it", () => {
    const byMode = (kind: "sub" | "key", permitted: boolean) =>
      CATALOGUE.some((service) =>
        service.modes.some(
          (mode) =>
            mode.kind === kind
            && mode.credentials.some(
              (c) => c.via === "string" && (c.directCall !== undefined) === permitted,
            ),
        ),
      );
    expect(byMode("sub", true)).toBe(true);
    expect(byMode("sub", false)).toBe(true);
  });

  it("a pasted credential does not decide it", () => {
    const stringCredentials = everyRow().flatMap(({ mode }) =>
      mode.credentials.filter((c) => c.via === "string"),
    );
    expect(stringCredentials.some((c) => c.via === "string" && c.directCall !== undefined)).toBe(true);
    expect(stringCredentials.some((c) => c.via === "string" && c.directCall === undefined)).toBe(true);
  });
});

describe("the two settled terms decisions", () => {
  it("Anthropic's API key may be called directly", () => {
    expect(credentialPermitsDirectCall("anthropic", "key", "string")).toBe(true);
  });

  it("Anthropic's Claude Code auth token may not", () => {
    expect(credentialPermitsDirectCall("anthropic", "sub", "string")).toBe(false);
  });

  it("Z.AI's coding plan may not", () => {
    expect(credentialPermitsDirectCall("zai", "sub", "string")).toBe(false);
  });
});

describe("the endpoint join is declared, not guessed", () => {
  it.each(directCallSelections().map((e) => [label(e.selection), e] as const))(
    "%s joins its service base to its style path",
    (_name, entry) => {
      const mode = getMode(entry.selection.serviceId, entry.selection.billingMode);
      const path = directCallPathFor(entry.target.style);
      expect(path).toBeDefined();
      expect(entry.target.baseUrl).toBe(mode?.endpoints[entry.target.style]);
      const url = joinEndpoint(entry.target.baseUrl, path!);
      expect(url.startsWith(entry.target.baseUrl)).toBe(true);
      expect(url.endsWith(path!)).toBe(true);
    },
  );

  it("bases are not uniform, so no client may assume where one ends", () => {
    const paths = [...new Set(directCallSelections().map((e) => new URL(e.target.baseUrl).pathname))];
    expect(paths).toContain("/");
    expect(paths.some((p) => p === "/v1")).toBe(true);
    expect(paths.some((p) => p !== "/" && p !== "/v1")).toBe(true);
  });

  it("a trailing slash on a base does not double the separator", () => {
    expect(joinEndpoint("https://example.test/v1/", "/responses")).toBe(
      "https://example.test/v1/responses",
    );
  });

  it("every style with a client path is one a shipped row can reach", () => {
    const used = new Set(directCallSelections().map((e) => e.target.style));
    for (const style of Object.keys(DIRECT_CALL_PATHS) as ApiStyle[]) {
      expect(used.has(style), style).toBe(true);
    }
  });
});

describe("the API model id", () => {
  it("defaults to the catalogue id", () => {
    for (const row of everyRow()) {
      if (row.model.apiId) continue;
      expect(apiModelIdFor(selectionOf(row))).toBe(row.model.id);
    }
  });

  it.each(everyRow().filter((r) => r.model.apiId).map((r) => [label(selectionOf(r)), r] as const))(
    "%s sends its declared API id instead of its row id",
    (_name, row) => {
      expect(apiModelIdFor(selectionOf(row))).toBe(row.model.apiId);
      expect(row.model.apiId).not.toBe(row.model.id);
    },
  );

  it("at least one directly callable row is a harness alias needing an API id", () => {
    // The founding case: a row whose id is what a harness takes, not what the
    // API takes. If this ever empties, the field has no user and the resolver's
    // apiId path is untested — look before deleting it.
    expect(directCallSelections().some((e) => e.target.apiModelId !== e.selection.modelId)).toBe(true);
  });
});

describe("required request headers", () => {
  it.each(directCallSelections().map((e) => [label(e.selection), e] as const))(
    "%s carries exactly its credential's declared headers",
    (_name, entry) => {
      const credential = getMode(entry.selection.serviceId, entry.selection.billingMode)
        ?.credentials.find((c) => c.via === "string");
      const declared = credential?.via === "string" ? credential.directCall?.headers : undefined;
      expect(entry.target.headers).toEqual(declared);
    },
  );

  it("a service that refuses an unnamed client declares what to send", () => {
    // OpenCode Go: 403/1010 to a generic agent, 400 MissingSessionID without a session.
    const go = directCallSelections().filter((e) => e.selection.serviceId === "opencode" && e.selection.billingMode === "sub");
    expect(go.length).toBeGreaterThan(0);
    for (const entry of go) {
      expect(Object.keys(entry.target.headers ?? {})).toEqual(
        expect.arrayContaining(["User-Agent", "x-opencode-session"]),
      );
    }
  });
});
