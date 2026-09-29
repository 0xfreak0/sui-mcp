import { describe, it, expect, vi, beforeEach } from "vitest";

const { gqlQuery } = vi.hoisted(() => ({ gqlQuery: vi.fn() }));
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery }));
vi.mock("../src/utils/identity.js", () => ({ describeAddresses: async () => new Map() }));

// Loaded after the mocks above, as the repo's other tool tests do.
const { registerUpgradeHistoryTools } = await import("../src/tools/upgrade-history.js");
const { madeImmutableAtPublish } = await import("../src/utils/object-end.js");

type Result = { content: { text: string }[]; isError?: boolean };
let handler: (args: Record<string, unknown>) => Promise<Result>;
registerUpgradeHistoryTools({
  tool: (_n: string, _d: string, _s: unknown, h: typeof handler) => {
    handler = h;
  },
} as never);

// SUIPUMP 0xeb195778…: its publish 4nDW27Ki… runs Publish, then
// 0x2::package::make_immutable(Result(0)), and no object change shows an
// UpgradeCap (read live).
const PKG = "0xeb195778afba241590237cd6ca17c479b4fb09047c2a2ef2ee6a9346698d6827";
const PUBLISH = "4nDW27KiRYFacgfKLVBU5yBTDHmFrDaZhCy2QEYaTcQ6";
const PUBLISHER = "0xa19c3be9e4a8a85ca40def19932a2867ff0f33f27bcacdd1d8bf2c01e8ab3a31";
const P2 = "0x0000000000000000000000000000000000000000000000000000000000000002";
const PUBLISH_CMD = { __typename: "PublishCommand" };
const makeImmutable = (argument: Record<string, unknown>) => ({
  __typename: "MoveCallCommand",
  function: { name: "make_immutable", module: { name: "package", package: { address: P2 } } },
  arguments: [argument],
});

function chain(commands: Array<Record<string, unknown>> | null) {
  gqlQuery.mockReset();
  gqlQuery.mockImplementation(async (query: string) => {
    if (query.includes("packageVersions")) {
      return {
        packageVersions: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              address: PKG,
              version: 1,
              linkage: [],
              previousTransaction: {
                digest: PUBLISH,
                sender: { address: PUBLISHER },
                effects: { timestamp: "2026-09-05T21:10:22.489Z", checkpoint: { sequenceNumber: 319177638 } },
                signatures: [],
              },
            },
          ],
        },
      };
    }
    if (query.includes("objectChanges(first: 50")) {
      return { transaction: { effects: { objectChanges: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } };
    }
    if (query.includes("commands(first: 50")) {
      return { transaction: commands && { kind: { commands: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: commands } } } };
    }
    throw new Error(`unexpected query in test: ${query}`);
  });
}

describe("madeImmutableAtPublish", () => {
  it("is true when make_immutable takes the result of every Publish command, and only then", async () => {
    chain([PUBLISH_CMD, makeImmutable({ __typename: "TxResult", cmd: 0 })]);
    expect(await madeImmutableAtPublish(PUBLISH)).toBe(true);
    chain([PUBLISH_CMD, makeImmutable({ __typename: "Input" })]);
    expect(await madeImmutableAtPublish(PUBLISH)).toBe(false);
    chain([PUBLISH_CMD, PUBLISH_CMD, makeImmutable({ __typename: "TxResult", cmd: 1 })]);
    expect(await madeImmutableAtPublish(PUBLISH)).toBe(false);
    chain([makeImmutable({ __typename: "Input" })]);
    expect(await madeImmutableAtPublish(PUBLISH)).toBe(false);
  });

  // 6Uf8naj2FyqhkTxXfW3VFMeqYvahtNyVkMoLY7ER3Nhs (read live) publishes three
  // packages, 0x17fa0d81… among them, and destroys each UpgradeCap in turn.
  it("is true for a PTB that publishes several packages and destroys every UpgradeCap", async () => {
    const cmds = [0, 2, 4].flatMap((cmd) => [PUBLISH_CMD, makeImmutable({ __typename: "TxResult", cmd })]);
    chain(cmds);
    expect(await madeImmutableAtPublish(PUBLISH)).toBe(true);
    chain(cmds.slice(0, 5));
    expect(await madeImmutableAtPublish(PUBLISH)).toBe(false);
  });

  it("throws when the transaction cannot be read, rather than answering no", async () => {
    chain(null);
    await expect(madeImmutableAtPublish(PUBLISH)).rejects.toThrow(PUBLISH);
  });
});

describe("get_upgrade_history on a package made immutable in its publish transaction", () => {
  beforeEach(() => chain([PUBLISH_CMD, makeImmutable({ __typename: "TxResult", cmd: 0 })]));

  it("says the publish destroyed the UpgradeCap, and flags it", async () => {
    const out = JSON.parse((await handler({ package: PKG })).content[0].text);
    expect(out.upgrade_cap).toMatchObject({ object_id: null, state: "deleted", current_holder: null });
    expect(out.upgrade_cap_note).toContain(`made immutable in its publish transaction ${PUBLISH}`);
    expect(out.upgrade_cap_note).not.toMatch(/unknown/);
    expect(out.cap_end).toMatchObject({ kind: "deleted", tx: PUBLISH, sender: PUBLISHER });
    expect(out.flags).toEqual([expect.objectContaining({ kind: "cap_destroyed", txs: [PUBLISH] })]);
  });

  it("answers as_of from the publish on as deleted", async () => {
    const after = JSON.parse((await handler({ package: PKG, as_of: "2026-09-06T00:00:00Z" })).content[0].text);
    expect(after.as_of.cap_state).toBe("deleted");
    const before = JSON.parse((await handler({ package: PKG, as_of: "2026-09-05T00:00:00Z" })).content[0].text);
    expect(before.as_of.cap_state).toBe("not_created");
  });

  it("keeps custody unknown when the publish made no such call", async () => {
    chain([PUBLISH_CMD]);
    const out = JSON.parse((await handler({ package: PKG })).content[0].text);
    expect(out.upgrade_cap).toBeNull();
    expect(out.upgrade_cap_note).toMatch(/custody is unknown/);
    expect(out.cap_end).toBeUndefined();
  });
});
