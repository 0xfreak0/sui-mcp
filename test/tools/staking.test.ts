import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockClient, createMockGraphql } from "../helpers/mock-grpc.js";

const mockSui = createMockClient();
const mockGqlQuery = createMockGraphql();

vi.mock("../../src/clients/grpc.js", () => ({
  sui: mockSui,
  archive: mockSui,
}));

vi.mock("../../src/clients/graphql.js", () => ({
  gqlQuery: mockGqlQuery,
}));

const { registerStakingTools } = await import("../../src/tools/staking.js");

const tools = new Map<string, Function>();
const mockServer = {
  tool: (name: string, _desc: string, _schema: unknown, handler: Function) => {
    tools.set(name, handler);
  },
} as any;

registerStakingTools(mockServer);

function makeValidator(name: string, stake: string, commission: string) {
  return {
    atRisk: null,
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
          activeValidators: {
            nodes: [
              makeValidator("small", "1000000000", "500"),
              makeValidator("big", "9000000000", "200"),
              makeValidator("med", "5000000000", "300"),
            ],
          },
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
          activeValidators: {
            nodes: [
              makeValidator("high", "1000000000", "1000"),
              makeValidator("low", "2000000000", "100"),
              makeValidator("mid", "1500000000", "500"),
            ],
          },
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
});

describe("get_validator_detail", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns detail for known validator", async () => {
    mockGqlQuery.mockResolvedValue({
      epoch: {
        epochId: 500,
        validatorSet: {
          activeValidators: {
            nodes: [makeValidator("myval", "5000000000", "200")],
          },
        },
      },
    });

    const handler = tools.get("get_validator_detail")!;
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
          activeValidators: { nodes: [] },
        },
      },
    });

    const handler = tools.get("get_validator_detail")!;
    const result = await handler({ address: "0xunknown" });
    const data = JSON.parse(result.content[0].text);

    expect(data.in_active_set).toBe(false);
    expect(data.note).toContain("not found");
  });
});

describe("get_staking_summary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns staking positions with totals", async () => {
    mockSui.listOwnedObjects.mockResolvedValue({
      objects: [
        { objectId: "0xstake1" },
        { objectId: "0xstake2" },
      ],
      hasNextPage: false,
    });

    mockSui.ledgerService.getObject
      .mockResolvedValueOnce({
        response: {
          object: {
            objectId: "0xstake1",
            json: {
              kind: {
                oneofKind: "structValue",
                structValue: {
                  fields: {
                    pool_id: { kind: { oneofKind: "stringValue", stringValue: "0xpool1" } },
                    principal: { kind: { oneofKind: "stringValue", stringValue: "1000000000" } },
                    stake_activation_epoch: { kind: { oneofKind: "stringValue", stringValue: "100" } },
                  },
                },
              },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        response: {
          object: {
            objectId: "0xstake2",
            json: {
              kind: {
                oneofKind: "structValue",
                structValue: {
                  fields: {
                    pool_id: { kind: { oneofKind: "stringValue", stringValue: "0xpool2" } },
                    principal: { kind: { oneofKind: "stringValue", stringValue: "2000000000" } },
                    stake_activation_epoch: { kind: { oneofKind: "stringValue", stringValue: "200" } },
                  },
                },
              },
            },
          },
        },
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

  it("handles wallet with no stakes", async () => {
    mockSui.listOwnedObjects.mockResolvedValue({
      objects: [],
      hasNextPage: false,
    });

    const handler = tools.get("get_staking_summary")!;
    const result = await handler({ address: "0xempty" });
    const data = JSON.parse(result.content[0].text);

    expect(data.position_count).toBe(0);
    expect(data.total_staked_mist).toBe("0");
    expect(data.positions).toEqual([]);
  });
});
