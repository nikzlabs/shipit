/**
 * planning#313 — the orchestrator's token registry and the container-env read-back
 * that lets a restarted orchestrator keep talking to containers it adopted.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  clearWorkerAuthToken,
  getWorkerAuthToken,
  setWorkerAuthToken,
  workerAuthHeaders,
  workerTokenFromContainerEnv,
} from "./worker-auth.js";
import { WORKER_AUTH_HEADER, WORKER_TOKEN_ENV } from "../shared/worker-auth.js";

const URL_A = "http://172.18.0.3:9100";
const URL_B = "http://172.18.0.4:9100";
const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);

describe("worker token registry", () => {
  beforeEach(() => {
    clearWorkerAuthToken(URL_A);
    clearWorkerAuthToken(URL_B);
  });

  it("returns the token registered for a worker and nothing for others", () => {
    setWorkerAuthToken(URL_A, TOKEN_A);
    setWorkerAuthToken(URL_B, TOKEN_B);
    expect(workerAuthHeaders(URL_A)).toEqual({ [WORKER_AUTH_HEADER]: TOKEN_A });
    expect(workerAuthHeaders(URL_B)).toEqual({ [WORKER_AUTH_HEADER]: TOKEN_B });
  });

  it("sends no header for an unregistered worker rather than a wrong one", () => {
    // An adopted pre-planning#313 container: its worker ignores the header, and
    // sending a stale one would be worse than sending none.
    expect(workerAuthHeaders("http://172.18.0.99:9100")).toEqual({});
  });

  it("treats a trailing slash as the same worker", () => {
    setWorkerAuthToken(`${URL_A}/`, TOKEN_A);
    expect(getWorkerAuthToken(URL_A)).toBe(TOKEN_A);
    expect(workerAuthHeaders(`${URL_A}/`)).toEqual({ [WORKER_AUTH_HEADER]: TOKEN_A });
  });

  it("clears the binding on teardown so a recycled bridge IP can't inherit it", () => {
    setWorkerAuthToken(URL_A, TOKEN_A);
    clearWorkerAuthToken(URL_A);
    expect(workerAuthHeaders(URL_A)).toEqual({});
  });

  it("registering `undefined` clears rather than leaves the previous token", () => {
    setWorkerAuthToken(URL_A, TOKEN_A);
    setWorkerAuthToken(URL_A, undefined);
    expect(workerAuthHeaders(URL_A)).toEqual({});
  });

  it("ignores an empty base URL (a SessionContainer before its IP is known)", () => {
    setWorkerAuthToken("", TOKEN_A);
    expect(workerAuthHeaders("")).toEqual({});
  });
});

describe("workerTokenFromContainerEnv", () => {
  it("reads the token out of a docker inspect Config.Env array", () => {
    const env = ["SESSION_ID=abc", `${WORKER_TOKEN_ENV}=${TOKEN_A}`, "HOME=/home/shipit"];
    expect(workerTokenFromContainerEnv(env)).toBe(TOKEN_A);
  });

  it("returns undefined for a container created before the mechanism existed", () => {
    expect(workerTokenFromContainerEnv(["SESSION_ID=abc"])).toBeUndefined();
    expect(workerTokenFromContainerEnv(undefined)).toBeUndefined();
    expect(workerTokenFromContainerEnv([])).toBeUndefined();
  });

  it("treats an empty value as absent", () => {
    expect(workerTokenFromContainerEnv([`${WORKER_TOKEN_ENV}=`])).toBeUndefined();
  });

  it("does not match an env var that merely starts with the same letters", () => {
    expect(workerTokenFromContainerEnv([`${WORKER_TOKEN_ENV}_OLD=${TOKEN_A}`])).toBeUndefined();
  });
});
