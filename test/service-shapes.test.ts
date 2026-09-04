import { describe, it, expect } from "vitest";
import {
  GQL_MAX_PAGE_SIZE,
  gqlPage,
  gqlPages,
  grpcError,
  httpError,
  httpOk,
  notFoundError,
} from "./helpers/service-shapes.js";
import { isNotFound } from "../src/utils/errors.js";

describe("gqlPage", () => {
  it("always carries pageInfo, because every real connection does", () => {
    // The validator bug survived because a mock omitted pageInfo entirely, so
    // paginating code had nothing to read and the test never exercised it.
    const page = gqlPage([{ a: 1 }]);
    expect(page.pageInfo).toEqual({ hasNextPage: false, endCursor: null });
  });

  it("refuses to build a page the service would have rejected", () => {
    // Mainnet answers `first: 200` with "Page size is too large: 200 > 50" — a
    // validation error, not a large page. A mock that returns 200 nodes is
    // asserting something false about the world.
    const tooMany = Array.from({ length: GQL_MAX_PAGE_SIZE + 1 }, (_, i) => i);
    expect(() => gqlPage(tooMany)).toThrow(/exceeds the GraphQL page cap/);
  });

  it("refuses a next page with no cursor to follow", () => {
    expect(() => gqlPage([1], { hasNextPage: true, endCursor: null })).toThrow(/endCursor is null/);
  });

  it("supplies a cursor when more pages exist", () => {
    const page = gqlPage([1], { hasNextPage: true });
    expect(page.pageInfo.endCursor).toBeTruthy();
  });
});

describe("gqlPages", () => {
  it("splits an over-cap list into linked pages", () => {
    const pages = gqlPages(Array.from({ length: 120 }, (_, i) => i));
    expect(pages).toHaveLength(3);
    expect(pages[0].nodes).toHaveLength(GQL_MAX_PAGE_SIZE);
    expect(pages[0].pageInfo.hasNextPage).toBe(true);
    expect(pages[2].pageInfo.hasNextPage).toBe(false);
    expect(pages[2].pageInfo.endCursor).toBeNull();
  });

  it("returns one empty page for an empty list", () => {
    const pages = gqlPages([]);
    expect(pages).toHaveLength(1);
    expect(pages[0].nodes).toEqual([]);
  });
});

describe("gRPC status errors", () => {
  it("builds a NOT_FOUND the production check recognises", () => {
    // The point of the helper: the thing it produces must satisfy the same
    // predicate the shipping code uses, or tests prove nothing.
    expect(isNotFound(notFoundError())).toBe(true);
  });

  it("builds transport failures that are NOT absence", () => {
    for (const code of ["UNAVAILABLE", "DEADLINE_EXCEEDED", "PERMISSION_DENIED"] as const) {
      expect(isNotFound(grpcError(code))).toBe(false);
    }
  });

  it("refuses to build NOT_FOUND through the failure helper", () => {
    // Absence and failure support different conclusions. Making a test say
    // which one it means is the whole point.
    expect(() => grpcError("NOT_FOUND" as never)).toThrow(/use notFoundError/);
  });
});

describe("http helpers", () => {
  it("models a success and a failure the way fetch does", async () => {
    expect(await httpOk({ a: 1 }).json()).toEqual({ a: 1 });
    const err = httpError(401);
    expect(err.ok).toBe(false);
    expect(err.status).toBe(401);
  });
});
