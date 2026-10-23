import { beforeEach, describe, expect, it, vi } from "vitest";

const { listOwnedObjects } = vi.hoisted(() => ({ listOwnedObjects: vi.fn() }));
vi.mock("../src/clients/grpc.js", () => ({ sui: { listOwnedObjects } }));
const { ownedObjectsWalk, listOwnedWithJson } = await import("../src/utils/owned-objects.js");

const row = (id: number) => ({ objectId: `0x${id}`, version: "1", type: "0x2::example::Object", json: { id } });

describe("owned object scan bounds", () => {
  beforeEach(() => { listOwnedObjects.mockReset(); });
  it("scans past the default bound when raised and memoizes by that bound", async () => {
    listOwnedObjects.mockImplementation(async ({ limit, cursor }: { limit: number; cursor: string | null }) => {
      const start = Number(cursor ?? "0");
      const objects = Array.from({ length: Math.min(limit, 3 - start) }, (_, i) => row(start + i));
      return { objects, hasNextPage: start + objects.length < 3, cursor: String(start + objects.length) };
    });
    const memo = new Map<string, Promise<unknown>>();
    const short = await ownedObjectsWalk("0x1", memo, 2);
    expect(short).toMatchObject({ complete: false, objects: [row(0), row(1)] });
    const full = await ownedObjectsWalk("0x1", memo, 3);
    expect(full).toMatchObject({ complete: true, objects: [row(0), row(1), row(2)] });
  });

  it("does not re-read a page whose cursor has not advanced", async () => {
    listOwnedObjects.mockResolvedValue({ objects: [row(0)], hasNextPage: true, cursor: "same" });
    const result = await listOwnedWithJson("0x1", null, 20);
    expect(result.complete).toBe(false);
    expect(result.objects).toHaveLength(2);
    expect(listOwnedObjects).toHaveBeenCalledTimes(2);
  });
});
