import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockClient, createMockGraphql } from "./helpers/mock-grpc.js";

const sui = createMockClient();
const gqlQuery = createMockGraphql();
vi.mock("../src/clients/grpc.js", () => ({ sui, archive: sui }));
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery }));
// Loaded after the mock clients: a static import would bind the real transports before vi.mock runs.
const { readWalletPackageActivity } = await import("../src/utils/wallet-packages.js");

const ADDRESS = `0x${"a".repeat(64)}`;
const firstPage = (nodes: unknown[], more: boolean, cursor: string | null = null) => ({
  transactions: { nodes, pageInfo: { hasNextPage: more, endCursor: cursor } },
});
const tx = (digest: string, commands: string[], more = false, cursor: string | null = null) => ({
  digest,
  effects: { timestamp: "2024-07-26T10:32:18Z" },
  kind: {
    __typename: "ProgrammableTransaction",
    commands: { nodes: commands.map((__typename) => ({ __typename })), pageInfo: { hasNextPage: more, endCursor: cursor } },
  },
});
const effects = (ids: string[], more = false, cursor: string | null = null) => ({
  transaction: {
    effects: {
      status: "SUCCESS",
      objectChanges: {
        nodes: ids.map((address) => ({ idCreated: true, outputState: { asMovePackage: { address } } })),
        pageInfo: { hasNextPage: more, endCursor: cursor },
      },
    },
  },
});

beforeEach(() => vi.clearAllMocks());

describe("wallet package activity", () => {
  it("finds multiple publications and upgrades across cursor pages without mistaking the signer for today's cap holder", async () => {
    const first = [tx("published", ["PublishCommand", "PublishCommand"]), tx("upgraded", ["UpgradeCommand"])];
    first.push(...Array.from({ length: 18 }, (_, n) => tx(`ordinary-${n}`, ["MoveCallCommand"])));
    gqlQuery.mockImplementation(async (query: string, variables: { digest?: string; after?: string }) => {
      if (query.includes("sentAddress")) return variables.after === "next" ? firstPage([tx("later", ["PublishCommand"])], false) : firstPage(first, true, "next");
      if (variables.digest === "published") return effects(["0xp1", "0xp2"]);
      if (variables.digest === "upgraded") return effects(["0xv2"]);
      if (variables.digest === "later") return effects(["0xp3"]);
      throw new Error(`unexpected detail read: ${variables.digest}`);
    });
    sui.movePackageService.getPackage.mockImplementation(async ({ packageId }: { packageId: string }) => ({
      response: { package: { originalId: packageId === "0xv2" ? "0xp1" : packageId, version: packageId === "0xv2" ? 2n : 1n } },
    }));

    const page1 = await readWalletPackageActivity(ADDRESS);
    expect(page1.packages.map(({ package_id, root_package_id, action, transaction_digest }) => [package_id, root_package_id, action, transaction_digest])).toEqual([
      ["0xp1", "0xp1", "published", "published"],
      ["0xp2", "0xp2", "published", "published"],
      ["0xv2", "0xp1", "upgraded", "upgraded"],
    ]);
    expect(page1.scan).toMatchObject({ transactions_scanned: 20, complete: false, next_call: { tool: "get_wallet_packages", args: { address: ADDRESS, cursor: expect.any(String) } } });
    const page2 = await readWalletPackageActivity(ADDRESS, page1.scan.next_call?.args.cursor);
    expect(page2.packages.map((p) => p.package_id)).toEqual(["0xp3"]);
    expect(page2.scan).toMatchObject({ transactions_scanned: 1, complete: true });
  });

  it("finishes nested command and effect pages rather than missing a package beyond the first 50 rows", async () => {
    gqlQuery.mockImplementation(async (query: string, variables: { digest?: string; after?: string }) => {
      if (query.includes("sentAddress")) return firstPage([tx("wide", ["MoveCallCommand"], true, "cmd-next")], false);
      if (query.includes("commands(first:") && variables.digest === "wide") return {
        transaction: { kind: { commands: { nodes: [{ __typename: "PublishCommand" }], pageInfo: { hasNextPage: false, endCursor: null } } } },
      };
      if (variables.digest === "wide") return variables.after ? effects(["0xpkg"]) : effects([], true, "effects-next");
      throw new Error("unexpected read");
    });
    sui.movePackageService.getPackage.mockResolvedValue({ response: { package: { originalId: "0xpkg", version: 1n } } });

    const result = await readWalletPackageActivity(ADDRESS);
    expect(result.packages.map((p) => p.package_id)).toEqual(["0xpkg"]);
    expect(result.scan.complete).toBe(true);
  });

  it("does not declare a clean wallet when one transaction's command cursor is missing or a package detail read fails", async () => {
    gqlQuery.mockImplementation(async (query: string, variables: { digest?: string }) => {
      if (query.includes("sentAddress")) return firstPage([
        tx("unread", ["MoveCallCommand"], true, null),
        tx("publisher", ["PublishCommand"]),
      ], false);
      if (variables.digest === "publisher") return effects(["0xunknown"]);
      throw new Error("unexpected read");
    });
    sui.movePackageService.getPackage.mockRejectedValue(new Error("unavailable"));

    const result = await readWalletPackageActivity(ADDRESS);
    expect(result.scan).toMatchObject({ complete: false, incomplete_transactions: ["unread"] });
    expect(result.packages[0]).toMatchObject({ package_id: "0xunknown", action: "unknown", detail_unavailable: "unavailable" });
  });

  it("keeps an unread earlier transaction unresolved after the final history page", async () => {
    gqlQuery.mockImplementation(async (query: string, variables: { after?: string | null }) => {
      if (!query.includes("sentAddress")) throw new Error("No detail read is possible for this transaction");
      return variables.after === "next"
        ? firstPage([tx("later", ["MoveCallCommand"])], false)
        : firstPage([tx("unread", ["MoveCallCommand"], true, null)], true, "next");
    });

    const first = await readWalletPackageActivity(ADDRESS);
    expect(first.scan).toMatchObject({ complete: false, incomplete_transactions: ["unread"] });
    const last = await readWalletPackageActivity(ADDRESS, first.scan.next_call?.args.cursor);
    expect(last.scan).toMatchObject({ complete: false, prior_incomplete_transactions: 1 });
    expect(last.scan.incomplete_transactions).toBeUndefined();
    expect(last.scan.next_call).toBeUndefined();
    expect(last.scan.note).toContain("earlier transaction(s) could not be checked");
  });

  it("rejects a malformed continuation rather than restarting at the oldest transaction", async () => {
    await expect(readWalletPackageActivity(ADDRESS, "not-a-scan-cursor")).rejects.toThrow("Invalid wallet package cursor");
    expect(gqlQuery).not.toHaveBeenCalled();
  });
});
