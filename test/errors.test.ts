import { describe, it, expect } from "vitest";
import { errorResult, isNotFound } from "../src/utils/errors.js";

describe("errorResult", () => {
  it("returns content with isError flag", () => {
    const result = errorResult("something went wrong");
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("something went wrong");
  });
});

describe("isNotFound", () => {
  it("recognises the gRPC string status", () => {
    expect(isNotFound({ code: "NOT_FOUND" })).toBe(true);
    expect(isNotFound({ code: "not_found" })).toBe(true);
  });

  it("recognises the numeric status grpc-js uses", () => {
    expect(isNotFound({ code: 5 })).toBe(true);
    expect(isNotFound({ code: 14 })).toBe(false); // UNAVAILABLE
  });

  it("does not treat other failures as absence", () => {
    // This is the whole point: an outage, a timeout or a bad address must not
    // read as "there is no object here", because callers conclude things from
    // absence. identify_address answers `type: "wallet"` on that basis.
    expect(isNotFound({ code: "UNAVAILABLE" })).toBe(false);
    expect(isNotFound({ code: "DEADLINE_EXCEEDED" })).toBe(false);
    expect(isNotFound(new Error("socket hang up"))).toBe(false);
    expect(isNotFound(null)).toBe(false);
    expect(isNotFound("NOT_FOUND")).toBe(false);
  });

  it("falls back to the message only when there is no code", () => {
    expect(isNotFound(new Error("5 NOT_FOUND: object not found"))).toBe(true);
  });
});
