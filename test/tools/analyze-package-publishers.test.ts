import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockClient, createMockGraphql } from "../helpers/mock-grpc.js";
import { gqlPage } from "../helpers/service-shapes.js";

const mockSui = createMockClient();
const mockGqlQuery = createMockGraphql();
vi.mock("../../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));
vi.mock("../../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));

// Loaded after the mocks above: the tool imports both clients.
const { registerAnalyzePackageTools } = await import("../../src/tools/analyze-package.js");

let handler: (args: { package_id: string }) => Promise<{ content: { text: string }[] }>;
registerAnalyzePackageTools({
  tool: (_n: string, _d: string, _s: unknown, h: typeof handler) => {
    handler = h;
  },
} as never);

// Real Cetus CLMM lineage. v10 (the version live during the May 2025 exploit)
// was pushed by the team multisig, which also holds the UpgradeCap now; the
// lineage root was published by a different address in 2023.
const ROOT = "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb";
const V10 = "0xc6faf3703b0e8ba9ed06b7851134bbbe7565eb35ff823fd78432baa4cbeaa12e";
const ROOT_PUBLISHER = "0x34df762694fb2d135a9a77ff804360489d6ddd9b13ab353397aaa29de36802cb";
const UPGRADER = "0xdbfd0b17fa804c98f51d552b050fb7f850b85db96fa2a0d79e50119525814a47";
const CAP = "0x4462a572640227717cb8c60b6dd337f022743de6bc13f1fe0b7adb182d1fa274";
const P2 = "0x0000000000000000000000000000000000000000000000000000000000000002";

const creatingTx: Record<string, { digest: string; sender: string; seconds: bigint }> = {
  [ROOT]: { digest: "CWXtZr52XHTxkyAGf822P87vzU4LTkZbqicRxqi2AfyC", sender: ROOT_PUBLISHER, seconds: 1683128502n },
  [V10]: { digest: "6VrUUDTCofn1KZX22Y5H2RjTMHUNoq5f5CWKueryRCPb", sender: UPGRADER, seconds: 1739443869n },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSui.movePackageService.getPackage.mockResolvedValue({
    response: { package: { storageId: V10, originalId: ROOT, version: 10n, modules: [] } },
  });
  mockSui.ledgerService.getObject.mockImplementation(async ({ objectId }: { objectId: string }) => ({
    response: { object: { objectId, previousTransaction: creatingTx[objectId].digest } },
  }));
  mockSui.ledgerService.getTransaction.mockImplementation(async ({ digest }: { digest: string }) => {
    const tx = Object.values(creatingTx).find((t) => t.digest === digest)!;
    return {
      response: {
        transaction: { digest, transaction: { sender: tx.sender }, timestamp: { seconds: tx.seconds, nanos: 0 } },
      },
    };
  });
  mockGqlQuery.mockImplementation(async (query: string) => {
    if (query.includes("packageAt(version: 1)")) {
      // The root's publish transaction minted the UpgradeCap.
      return {
        package: {
          packageAt: {
            previousTransaction: {
              effects: {
                objectChanges: gqlPage([
                  {
                    idCreated: true,
                    outputState: {
                      address: CAP,
                      asMoveObject: { contents: { type: { repr: `${P2}::package::UpgradeCap` } } },
                    },
                  },
                ]),
              },
            },
          },
        },
      };
    }
    if (query.includes("object(address: $id)")) {
      return {
        object: {
          owner: { __typename: "AddressOwner", address: { address: UPGRADER } },
          asMoveObject: { contents: { json: { policy: 0 } } },
        },
      };
    }
    // fetchPackageLatestVersion
    return { package: { version: 15 } };
  });
});

const run = async () => JSON.parse((await handler({ package_id: V10 })).content[0].text);

describe("analyze_package — root and version publishers", () => {
  it("reports who deployed the lineage and who pushed this version, separately", async () => {
    const r = await run();
    expect(r.root_publisher).toMatchObject({ package_id: ROOT, publisher: ROOT_PUBLISHER });
    expect(r.version_publisher).toMatchObject({ package_id: V10, publisher: UPGRADER });
    expect(r.lineage).toEqual({ root_package_id: ROOT, version: 10, latest_version: 15 });
  });

  /**
   * Regression: the cap holder was compared against the version's publisher.
   * The multisig that pushed v10 also holds the cap, so the audit read
   * "still held by the address that published the package" although the cap
   * left the 2023 deployer.
   */
  it("judges the UpgradeCap holder against the root publisher", async () => {
    const r = await run();
    const cap = r.capabilities.capabilities.find((c: { kind: string }) => c.kind === "upgrade");
    expect(cap.holder_status).toBe("transferred");
    expect(cap.publisher).toBe(ROOT_PUBLISHER);
    expect(cap.owner_address).toBe(UPGRADER);
  });

  it("uses one publisher for both when handed the root itself", async () => {
    mockSui.movePackageService.getPackage.mockResolvedValue({
      response: { package: { storageId: ROOT, originalId: ROOT, version: 1n, modules: [] } },
    });
    const r = JSON.parse((await handler({ package_id: ROOT })).content[0].text);
    expect(r.version_publisher).toEqual(r.root_publisher);
    expect(r.root_publisher.publisher).toBe(ROOT_PUBLISHER);
  });
});
