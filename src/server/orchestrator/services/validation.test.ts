import { describe, it, expect } from "vitest";
import { ServiceError } from "./types.js";
import {
  validateString,
  validateNumber,
  validateStringArray,
  validateNonEmptyString,
} from "./validation.js";

describe("validateString", () => {
  it("returns the value when it is a string", () => {
    expect(validateString("hello", "field")).toBe("hello");
    expect(validateString("", "field")).toBe("");
  });

  it("throws a 400 ServiceError for non-strings", () => {
    for (const bad of [42, null, undefined, {}, [], true]) {
      expect(() => validateString(bad, "remoteUrl")).toThrow(
        new ServiceError(400, "remoteUrl must be a string"),
      );
    }
  });

  it("uses the provided field name in the message", () => {
    try {
      validateString(1, "myField");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).statusCode).toBe(400);
      expect((err as ServiceError).message).toBe("myField must be a string");
    }
  });
});

describe("validateNumber", () => {
  it("returns the value when it is a finite number", () => {
    expect(validateNumber(42, "field")).toBe(42);
    expect(validateNumber(0, "field")).toBe(0);
    expect(validateNumber(-1.5, "field")).toBe(-1.5);
  });

  it("throws a 400 ServiceError for non-numbers and NaN", () => {
    for (const bad of ["42", null, undefined, {}, [], true, NaN]) {
      expect(() => validateNumber(bad, "prNumber")).toThrow(
        new ServiceError(400, "prNumber must be a number"),
      );
    }
  });
});

describe("validateStringArray", () => {
  it("returns the array when every entry is a string", () => {
    expect(validateStringArray([], "ids")).toEqual([]);
    expect(validateStringArray(["a", "b"], "ids")).toEqual(["a", "b"]);
  });

  it("throws a 400 ServiceError for non-arrays", () => {
    for (const bad of ["a", 1, null, undefined, {}]) {
      expect(() => validateStringArray(bad, "ids")).toThrow(
        new ServiceError(400, "ids must be an array of strings"),
      );
    }
  });

  it("throws a 400 ServiceError when any entry is not a string", () => {
    expect(() => validateStringArray(["a", 2, "c"], "urls")).toThrow(
      new ServiceError(400, "urls must be an array of strings"),
    );
  });
});

describe("validateNonEmptyString", () => {
  it("returns the value when it is a non-empty string", () => {
    expect(validateNonEmptyString("hello", "field")).toBe("hello");
    // Surrounding whitespace is preserved on the returned value.
    expect(validateNonEmptyString("  x  ", "field")).toBe("  x  ");
  });

  it("throws a 400 ServiceError for empty / whitespace-only strings", () => {
    for (const bad of ["", "   ", "\t\n"]) {
      expect(() => validateNonEmptyString(bad, "Template ID")).toThrow(
        new ServiceError(400, "Template ID must be a non-empty string"),
      );
    }
  });

  it("throws a 400 ServiceError for non-strings", () => {
    for (const bad of [42, null, undefined, {}, []]) {
      expect(() => validateNonEmptyString(bad, "Comment body")).toThrow(
        new ServiceError(400, "Comment body must be a non-empty string"),
      );
    }
  });
});
