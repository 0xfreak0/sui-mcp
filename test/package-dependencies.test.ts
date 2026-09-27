import { describe, it, expect, vi } from "vitest";
import { createMockClient } from "./helpers/mock-grpc.js";

const mockSui = createMockClient();
vi.mock("../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));

// Loaded after the mock above: the tool imports the client.
const { registerPackageTools } = await import("../src/tools/packages.js");

let handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
registerPackageTools({
  tool: (name: string, _d: string, _s: unknown, h: typeof handler) => {
    if (name === "get_package") handler = h;
  },
} as never);

// Cetus CLMM v10's linkage as mainnet returns it: integer-mate linked at v3,
// the framework at whatever version it was built against.
const CLMM_V10 = "0xc6faf3703b0e8ba9ed06b7851134bbbe7565eb35ff823fd78432baa4cbeaa12e";
const MATE = "0x714a63a0dba6da4f017b42d5d0fb78867f18bcde904868e51d951a5a6f5b7f57";
const MATE_V3 = "0xe2b515f0052c0b3f83c23db045d49dbe1732818ccfc5d4596c9482f7f2e76a85";
const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002";

describe("get_package dependencies", () => {
  it("names the dependency version the package runs, without framework rows", async () => {
    // MovePackageService returns the package with `linkage` empty; the
    // package object carries the table.
    mockSui.movePackageService.getPackage.mockResolvedValue({
      response: {
        package: {
          storageId: CLMM_V10,
          originalId: "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb",
          version: 10n,
          modules: [],
          linkage: [],
        },
      },
    });
    mockSui.ledgerService.getObject.mockResolvedValue({
      response: {
        object: {
          package: {
            linkage: [
              { originalId: SUI, upgradedId: SUI, upgradedVersion: 30n },
              { originalId: MATE, upgradedId: MATE_V3, upgradedVersion: 3n },
            ],
          },
        },
      },
    });
    const out = JSON.parse((await handler({ package_id: CLMM_V10 })).content[0].text);
    expect(out.dependencies).toEqual([{ original_id: MATE, linked_id: MATE_V3, linked_version: 3 }]);
  });
});
