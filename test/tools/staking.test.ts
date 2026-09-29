import { describe, it, expect, vi, beforeEach } from "vitest";
import { gqlPage, gqlPages } from "../helpers/service-shapes.js";
import { createMockClient, createMockGraphql } from "../helpers/mock-grpc.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_NETWORK, getNetwork } from "../../src/config.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readStoredResult } from "../../src/utils/output-cap.js";
import { resetStore } from "../../src/utils/store.js";

const mockSui = createMockClient();
const mockGqlQuery = createMockGraphql();

vi.mock("../../src/clients/grpc.js", () => ({
  sui: mockSui,
  archive: mockSui,
}));

vi.mock("../../src/clients/graphql.js", () => ({
  gqlQuery: mockGqlQuery,
}));

// Load after the client mocks: the network wrapper imports the gRPC proxy.
const { registerStakingTools } = await import("../../src/tools/staking.js");
const { withNetworkParam } = await import("../../src/tools/with-network.js");

const tools = new Map<string, Function>();
const mockServer = {
  tool: (name: string, _desc: string, _schema: unknown, handler: Function) => {
    tools.set(name, handler);
  },
} as unknown as McpServer;

registerStakingTools(mockServer);

function makeValidator(name: string, stake: string, commission: string) {
  return {
    atRisk: 0,
    contents: {
      json: {
        metadata: { sui_address: `0x${name}`, name, description: `Validator ${name}` },
        voting_power: "100",
        gas_price: "750",
        staking_pool: { id: `0xpool_${name}`, activation_epoch: "0", sui_balance: stake },
        commission_rate: commission,
        next_epoch_stake: stake,
        next_epoch_commission_rate: commission,
      },
    },
  };
}

describe("get_validators", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns validators sorted by stake (default)", async () => {
    mockGqlQuery.mockResolvedValue({
      epoch: {
        epochId: 500,
        validatorSet: {
          activeValidators: gqlPage([
              makeValidator("small", "1000000000", "500"),
              makeValidator("big", "9000000000", "200"),
              makeValidator("med", "5000000000", "300"),
            ]),
          contents: { json: { total_stake: "15000000000" } },
        },
      },
    });

    const handler = tools.get("get_validators")!;
    const result = await handler({ limit: undefined, sort_by: undefined });
    const data = JSON.parse(result.content[0].text);

    expect(data.epoch).toBe(500);
    expect(data.validator_count).toBe(3);
    expect(data.total_stake).toBe("15000000000");
    // Sorted by stake descending
    expect(data.validators[0].name).toBe("big");
    expect(data.validators[1].name).toBe("med");
    expect(data.validators[2].name).toBe("small");
  });

  it("sorts by commission when requested", async () => {
    mockGqlQuery.mockResolvedValue({
      epoch: {
        epochId: 500,
        validatorSet: {
          activeValidators: gqlPage([
              makeValidator("high", "1000000000", "1000"),
              makeValidator("low", "2000000000", "100"),
              makeValidator("mid", "1500000000", "500"),
            ]),
          contents: { json: { total_stake: "4500000000" } },
        },
      },
    });

    const handler = tools.get("get_validators")!;
    const result = await handler({ limit: undefined, sort_by: "commission" });
    const data = JSON.parse(result.content[0].text);

    // Sorted by commission ascending
    expect(data.validators[0].name).toBe("low");
    expect(data.validators[0].commission_rate_bps).toBe(100);
    expect(data.validators[2].name).toBe("high");
  });

  describe("a set larger than one page", () => {
    // 60 validators with distinct stakes, served in pages of 50. The largest
    // stakes sit on the second page, so a cut made by page order rather than
    // by stake order shows up.
    const all = Array.from({ length: 60 }, (_, i) =>
      makeValidator(`v${String(i).padStart(2, "0")}`, String((i + 1) * 1_000_000_000), String(100 + i)),
    );
    const pages = gqlPages(all);
    const serve = () =>
      mockGqlQuery.mockImplementation(async (_q: string, vars: { after: string | null }) => {
        const index = vars.after === null ? 0 : pages.findIndex((_, i) => i > 0 && pages[i - 1].pageInfo.endCursor === vars.after);
        return { epoch: { epochId: 900, validatorSet: { activeValidators: pages[index], contents: { json: { total_stake: "1830000000000" } } } } };
      });

    it("lists every active validator in full detail", async () => {
      serve();
      const data = JSON.parse((await tools.get("get_validators")!({ detail: "full" })).content[0].text);

      expect(data.active_validator_count).toBe(60);
      expect(data.validator_count).toBe(60);
      expect(data.validators).toHaveLength(60);
      expect(data.truncated).toBeUndefined();
      const names = new Set(data.validators.map((v: { name: string }) => v.name));
      for (const v of all) expect(names.has(v.contents.json.metadata.name)).toBe(true);
      expect(data.validators[0].name).toBe("v59");
      expect(data.validators[59].name).toBe("v00");
    });

    it("with limit, keeps totals over the whole set and states the omitted rest", async () => {
      serve();
      const data = JSON.parse((await tools.get("get_validators")!({ limit: 10, sort_by: "commission" })).content[0].text);

      expect(data.active_validator_count).toBe(60);
      expect(data.total_stake).toBe("1830000000000");
      expect(data.validator_count).toBe(10);
      expect(data.validators.map((v: { name: string }) => v.name)).toEqual(
        Array.from({ length: 10 }, (_, i) => `v${String(i).padStart(2, "0")}`),
      );
      expect(data.truncated).toBe(true);
      const omitted = data.omitted.lists.validators;
      expect(omitted.count).toBe(50);
      expect(omitted.from).toBe(10);
      expect(omitted.first).toMatchObject({ name: "v10", commission_rate_bps: 110 });
      const full = JSON.parse((await tools.get("get_validators")!(data.omitted.next_call.args)).content[0].text);
      expect(full.validators.slice(10).map((v: { name: string }) => v.name)).toEqual(
        all.slice(10).map((v) => v.contents.json.metadata.name),
      );
    });

    it("caps summary rows after ranking and keeps at-risk validators beyond the budget", async () => {
      serve();
      all[0].atRisk = 1;
      try {
        const data = JSON.parse((await tools.get("get_validators")!({})).content[0].text);
        expect(data.validators[0].name).toBe("v59");
        expect(data.validators.at(-1)).toMatchObject({ name: "v00", at_risk: 1 });
        expect(data.validators[0]).toEqual({
          name: "v59", address: "0xv59", staking_pool_sui_balance: "60000000000",
          commission_rate_bps: 159, voting_power: 100, at_risk: 0,
        });
        expect(JSON.stringify(data.validators).length).toBeLessThanOrEqual(6000);
        expect(data.validator_count).toBe(data.validators.length);
        expect(data.active_validator_count).toBe(60);
        expect(data.total_stake).toBe("1830000000000");
        expect(data.omitted.lists.validators.count).toBe(60 - data.validators.length);
        expect(data.omitted.fields).toEqual(["validators.description", "validators.next_epoch_commission_rate_bps", "validators.gas_price"]);
        const full = JSON.parse((await tools.get("get_validators")!(data.omitted.next_call.args)).content[0].text);
        expect(full.validators).toHaveLength(60);
        expect(full.validators[0].description).toBe("Validator v59");
        const limited = JSON.parse((await tools.get("get_validators")!({ limit: 1 })).content[0].text);
        expect(limited.validators.map((v: { name: string }) => v.name)).toEqual(["v59", "v00"]);
      } finally {
        all[0].atRisk = 0;
      }
    });

    it("stores full rows with their own count rather than the displayed count", async () => {
      const dir = mkdtempSync(join(tmpdir(), "validators-store-"));
      const previous = process.env.SUI_STORE_PATH;
      process.env.SUI_STORE_PATH = join(dir, "store.db");
      resetStore();
      try {
        serve();
        const data = JSON.parse((await tools.get("get_validators")!({ limit: 2 })).content[0].text);
        const id = data.omitted.result.uri.split("/").at(-1);
        const stored = readStoredResult(id, { path: "validator_count" });
        expect(stored.value).toBe(60);
        const rows = readStoredResult(id, { path: "validators", limit: "100" });
        expect(rows.total).toBe(60);
        expect(rows.rows).toEqual(expect.arrayContaining([
          { index: 0, row: expect.objectContaining({ name: "v59", description: "Validator v59", gas_price: "750" }) },
        ]));
        expect(data.validator_count).toBe(data.validators.length);
        expect(data.validator_count).toBe(2);
      } finally {
        if (previous === undefined) delete process.env.SUI_STORE_PATH;
        else process.env.SUI_STORE_PATH = previous;
        resetStore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("executes the continuation on the original non-default network", async () => {
      const wrapped = new Map<string, Function>();
      registerStakingTools(withNetworkParam({
        registerTool: (name: string, _config: unknown, handler: Function) => wrapped.set(name, handler),
      } as unknown as McpServer));
      const network = DEFAULT_NETWORK === "testnet" ? "mainnet" : "testnet";
      mockGqlQuery.mockImplementation(async () => ({
        epoch: { epochId: getNetwork() === network ? 900 : 500, validatorSet: {
          activeValidators: gqlPage(getNetwork() === network ? all.slice(0, 4) : [makeValidator("other-chain", "1", "1")]),
          contents: { json: { total_stake: "10000000000" } },
        } },
      }));
      const call = wrapped.get("get_validators")!;
      const limited = JSON.parse((await call({ network, limit: 2, sort_by: "commission" })).content[0].text);
      const continued = JSON.parse((await call(limited.omitted.next_call.args)).content[0].text);
      expect(continued.epoch).toBe(900);
      expect(continued.validators.map((v: { name: string }) => v.name)).toEqual(["v00", "v01", "v02", "v03"]);
      expect(continued.validators[2].address).toBe(limited.omitted.lists.validators.first.address);
    });
  });
});

describe("get_validators (detail via address)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns detail for known validator", async () => {
    mockGqlQuery.mockResolvedValue({
      epoch: {
        epochId: 500,
        validatorSet: {
          activeValidators: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [makeValidator("myval", "5000000000", "200")],
          },
        },
      },
    });

    const handler = tools.get("get_validators")!;
    const result = await handler({ address: "0xmyval" });
    const data = JSON.parse(result.content[0].text);

    expect(data.in_active_set).toBe(true);
    expect(data.credentials.name).toBe("myval");
    expect(data.staking_stats.staking_pool_sui_balance).toBe("5000000000");
    expect(data.staking_stats.commission_rate_bps).toBe(200);
  });

  it("returns not-found note for unknown address", async () => {
    mockGqlQuery.mockResolvedValue({
      epoch: {
        epochId: 500,
        validatorSet: {
          activeValidators: gqlPage([]),
        },
      },
    });

    const handler = tools.get("get_validators")!;
    const result = await handler({ address: "0xunknown" });
    const data = JSON.parse(result.content[0].text);

    expect(data.in_active_set).toBe(false);
    expect(data.note).toContain("not found");
  });
});

/** A StakedSui as the SDK's listOwnedObjects returns it with `include: { json: true }`. */
function stakedSui(id: string, pool: string, principal: string, epoch: string) {
  return {
    objectId: id,
    version: "988732962",
    digest: "AvQg6ywqWwqGo471qka7wvcMLWzwcwsiaaUiw6n9XbtP",
    owner: { $kind: "AddressOwner", AddressOwner: "0xwallet" },
    type: "0x0000000000000000000000000000000000000000000000000000000000000003::staking_pool::StakedSui",
    json: { id, pool_id: pool, principal, stake_activation_epoch: epoch },
  };
}

describe("get_staking_summary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns staking positions with totals", async () => {
    mockSui.listOwnedObjects.mockResolvedValue({
      objects: [stakedSui("0xstake1", "0xpool1", "1000000000", "100"), stakedSui("0xstake2", "0xpool2", "2000000000", "200")],
      hasNextPage: false,
      cursor: null,
    });

    const handler = tools.get("get_staking_summary")!;
    const result = await handler({ address: "0xwallet" });
    const data = JSON.parse(result.content[0].text);

    expect(data.position_count).toBe(2);
    expect(data.total_staked_mist).toBe("3000000000");
    expect(data.positions[0].pool_id).toBe("0xpool1");
    expect(data.positions[0].principal_mist).toBe("1000000000");
    expect(data.positions[1].pool_id).toBe("0xpool2");
  });

  it("sums every page, not the first", async () => {
    // A wallet with 139 positions reported the principal of its first 50 as
    // its total stake.
    mockSui.listOwnedObjects
      .mockResolvedValueOnce({
        objects: [stakedSui("0xs1", "0xp", "1000000000", "1"), stakedSui("0xs2", "0xp", "2000000000", "1")],
        hasNextPage: true,
        cursor: "c1",
      })
      .mockResolvedValueOnce({
        objects: [stakedSui("0xs3", "0xp", "4000000000", "1")],
        hasNextPage: false,
        cursor: null,
      });

    const data = JSON.parse((await tools.get("get_staking_summary")!({ address: "0xwallet" })).content[0].text);

    expect(mockSui.listOwnedObjects.mock.calls[1][0].cursor).toBe("c1");
    expect(data.position_count).toBe(3);
    expect(data.total_staked_mist).toBe("7000000000");
    expect(data.truncated).toBe(false);
  });

  it("gives no total when the walk could not reach the end", async () => {
    mockSui.listOwnedObjects.mockResolvedValueOnce({
      objects: [stakedSui("0xs1", "0xp", "1000000000", "1")],
      hasNextPage: true,
      cursor: null,
    });

    const data = JSON.parse((await tools.get("get_staking_summary")!({ address: "0xwallet" })).content[0].text);

    expect(data.truncated).toBe(true);
    expect(data.total_staked_mist).toBeNull();
    expect(data.total_unavailable).toBeTruthy();
  });

  it("handles wallet with no stakes", async () => {
    mockSui.listOwnedObjects.mockResolvedValue({
      objects: [],
      hasNextPage: false,
      cursor: null,
    });

    const handler = tools.get("get_staking_summary")!;
    const result = await handler({ address: "0xempty" });
    const data = JSON.parse(result.content[0].text);

    expect(data.position_count).toBe(0);
    expect(data.total_staked_mist).toBe("0");
    expect(data.positions).toEqual([]);
  });
});
