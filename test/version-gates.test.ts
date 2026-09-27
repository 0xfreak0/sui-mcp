import { describe, it, expect, vi, beforeEach } from "vitest";
import { scanVersionGates, MAX_VERSIONS_COMPARED } from "../src/utils/version-gates.js";

const { fetchPackageVersions, fetchAllModuleDisassembly } = vi.hoisted(() => ({
  fetchPackageVersions: vi.fn(),
  fetchAllModuleDisassembly: vi.fn(),
}));
vi.mock("../src/utils/package-versions.js", () => ({ fetchPackageVersions }));
vi.mock("../src/utils/move-package.js", () => ({ fetchAllModuleDisassembly }));

const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const EMPTY = new Map([["m", "module aa.m {\n}"]]);

beforeEach(() => {
  fetchPackageVersions.mockReset();
  fetchAllModuleDisassembly.mockReset();
});

describe("scanVersionGates", () => {
  it("reads nothing for a package that upgrades in place", async () => {
    fetchPackageVersions.mockResolvedValue([1, 2, 3].map((version) => ({ address: "0x2", version })));
    expect(await scanVersionGates("0x2")).toBeNull();
    expect(fetchAllModuleDisassembly).not.toHaveBeenCalled();
  });

  it("compares the oldest versions and the newest past the bound, names the rest, and reuses the version already read", async () => {
    const total = MAX_VERSIONS_COMPARED + 2;
    fetchPackageVersions.mockResolvedValue(Array.from({ length: total }, (_, i) => ({ address: id(i + 1), version: i + 1 })));
    fetchAllModuleDisassembly.mockImplementation(async (pkg: string) => {
      if (pkg === id(2)) throw new Error("503");
      return EMPTY;
    });
    const scan = await scanVersionGates(id(1), { package_id: id(1), disassembly: EMPTY });
    expect(scan?.version_count).toBe(total);
    expect(scan?.versions_not_compared).toEqual({ count: 2, from: MAX_VERSIONS_COMPARED, to: MAX_VERSIONS_COMPARED + 1 });
    expect(scan?.versions_compared).toContain(total);
    expect(scan?.versions_compared).not.toContain(2);
    expect(scan?.unreadable?.map((u) => u.version)).toEqual([2]);
    expect(fetchAllModuleDisassembly).not.toHaveBeenCalledWith(id(1));
  });
});
