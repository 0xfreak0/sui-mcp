import { beforeEach, describe, expect, it, vi } from "vitest";

const getObjects = vi.fn();
const gqlQuery = vi.fn();
const scanTokenTopHolders = vi.fn();
const objectTypes = new Map<string, string>();

vi.mock("../src/clients/grpc.js", () => ({ sui: { getObjects }, archive: { getObjects } }));
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery }));
vi.mock("../src/tools/holders.js", () => ({ scanTokenTopHolders, sampledHolders: vi.fn() }));
vi.mock("../src/utils/publisher.js", () => ({ resolvePublisher: async () => ({ publisher: DEPLOYER, publish_tx: "tx" }) }));
vi.mock("../src/utils/identity.js", () => ({
  fetchKinds: async (addresses: string[]) => new Map(addresses.map((address) =>
    [address, objectTypes.has(address) ? { kind: "object", type: objectTypes.get(address) } : { kind: "wallet" }])),
}));
vi.mock("../src/utils/liquidity-origin.js", () => ({ readLiquidityOrigin: async () => ({ positions: [] }) }));

// Imported after the mocks above, whose factories close over this file's mocks and constants.
const { analyzeLiquidityCustody } = await import("../src/utils/liquidity-custody.js");

const pad = (hex: string) => `0x${hex.replace(/^0x/, "").padStart(64, "0")}`;
const DEPLOYER = pad("5fb4b7218acdafd00716621ffe154967920d28f3e09ba9c0892c4caccd15ac1e");
const SUI = `${pad("2")}::sui::SUI`;
const GOBBLE = `${pad("e24cf7665edf8dbf3452b786bbf20a40b5d52f9957c92bbb1e46efdaebafc7b6")}::gobble::GOBBLE`;
const BLUEMOVE = pad("b24b6789e088b876afabca733bed2299fbc9e2d6369be4d1acfa17d8145454d9");
const CETUS = pad("1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb");

beforeEach(() => {
  getObjects.mockReset();
  gqlQuery.mockReset();
  scanTokenTopHolders.mockReset();
  objectTypes.clear();
});

describe("liquidity custody reads", () => {
  it("reads BlueMove reserves from reserve_x/reserve_y and reconciles the LP the pool holds", async () => {
    // GOBBLE's BlueMove pool after its liquidity was pulled, as mainnet returns it: the coins sit in
    // an escrow field, token_x/token_y read zero, and the remaining LP is the pool's own fee and minimum.
    const pool = pad("ce12565b8875ddd3d929a963891374bd991c38085b372a6a39f3c32bae1a6e81");
    getObjects.mockResolvedValue({
      objects: [{
        objectId: pool, type: `${BLUEMOVE}::swap::Pool<${SUI}, ${GOBBLE}>`,
        json: {
          id: pool, token_x: "0", token_y: "0", lsp_supply: { value: "68251386489" }, fee_amount: "68251385489",
          fee_x: "325188948", fee_y: "11046298722838", minimum_liq: "1000", k_last: "4660050542431929046164",
          reserve_x: "3237705", reserve_y: "1453555712197458", is_freeze: false,
        },
      }],
    });
    scanTokenTopHolders.mockResolvedValue({ holders: [], truncated: false, unique_holders: 0, total_scanned: 0 });
    const result = await analyzeLiquidityCustody(GOBBLE, [{
      pool_id: pool, protocol: "bluemove", object_type: `${BLUEMOVE}::swap::Pool<${SUI}, ${GOBBLE}>`, token_a: SUI, token_b: GOBBLE,
    }]);
    const row = result.pools[0] as Record<string, unknown>;
    expect(row.reserve_coin_raw).toBe("1453555712197458");
    expect(row.counterpart_reserve).toEqual({ coin_type: SUI, raw: "3237705" });
    expect(row.scan).toMatchObject({ incomplete: false });
    expect(row.lp_locked_in_pool_raw).toBe("1000");
    expect(row.lp_protocol_fee_in_pool_raw).toBe("68251385489");
    expect(row.publisher_liquidity_raw).toBe("0");
  });

  it("keeps a wrapped Cetus position apart without nulling the other holders' shares", async () => {
    const pool = pad("c1");
    const table = pad("7a");
    const held = pad("p1");
    const wrapped = pad("p2");
    getObjects.mockResolvedValue({
      objects: [{
        objectId: pool, type: `${CETUS}::pool::Pool<${GOBBLE}, ${SUI}>`,
        // Tick 0 at sqrt price 2^64; both positions span ticks -100..100.
        json: { current_sqrt_price: (1n << 64n).toString(), current_tick_index: { bits: 0 }, liquidity: "3000000", position_manager: { positions: { id: table, size: "2" } } },
      }],
    });
    const info = (id: string, liquidity: string) => ({
      name: { json: id },
      value: { json: { value: { position_id: id, liquidity, tick_lower_index: { bits: 2 ** 32 - 100 }, tick_upper_index: { bits: 100 } } } },
    });
    gqlQuery.mockImplementation(async (query: string) => {
      if (query.includes("dynamicFields")) {
        return { address: { dynamicFields: { nodes: [info(held, "1000000"), info(wrapped, "2000000")], pageInfo: { hasNextPage: false, endCursor: null } } } };
      }
      if (query.includes("multiGetObjects")) {
        return { multiGetObjects: [{ address: held, owner: { address: { address: DEPLOYER } }, asMoveObject: { contents: { type: { repr: `${CETUS}::position::Position` } } } }, null] };
      }
      throw new Error(`unexpected query ${query.slice(0, 40)}`);
    });
    const result = await analyzeLiquidityCustody(GOBBLE, [{
      pool_id: pool, protocol: "cetus", object_type: `${CETUS}::pool::Pool<${GOBBLE}, ${SUI}>`, token_a: GOBBLE, token_b: SUI,
    }]);
    const row = result.pools[0] as { scan: { incomplete: boolean }; holders: Array<{ kind: string; share: number }>; owner_unread: { positions: number; share: number; position_ids: string[] } };
    expect(row.scan.incomplete).toBe(false);
    expect(row.holders).toEqual([expect.objectContaining({ kind: "publisher" })]);
    expect(row.holders[0]!.share).toBeCloseTo(1 / 3, 4);
    expect(row.owner_unread).toMatchObject({ positions: 1, position_ids: [wrapped] });
    expect(row.owner_unread.share).toBeCloseTo(2 / 3, 4);
  });

  it("does not report zero publisher or burned liquidity from a scan that stopped", async () => {
    const pool = pad("c2");
    getObjects.mockResolvedValue({
      objects: [{
        objectId: pool, type: `${CETUS}::pool::Pool<${GOBBLE}, ${SUI}>`,
        json: { current_sqrt_price: (1n << 64n).toString(), current_tick_index: { bits: 0 }, liquidity: "0", position_manager: { positions: { id: pad("7b"), size: "5000" } } },
      }],
    });
    gqlQuery.mockImplementation(async () => ({ address: { dynamicFields: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } }));
    const result = await analyzeLiquidityCustody(GOBBLE, [{
      pool_id: pool, protocol: "cetus", object_type: `${CETUS}::pool::Pool<${GOBBLE}, ${SUI}>`, token_a: GOBBLE, token_b: SUI,
    }]);
    const row = result.pools[0] as Record<string, unknown>;
    expect(row.scan).toMatchObject({ incomplete: true });
    expect(row.publisher_liquidity_raw).toBeNull();
    expect(row.burned_liquidity_raw).toBeNull();
    expect(row.total_liquidity_raw).toBeNull();
  });

  it("names the kiosk holding positions as dynamic object fields, not each Field", async () => {
    const pool = pad("c3");
    const kiosk = pad("8ac8b43dab12e6f73e1f7bad57ff384ee48e48326fce1ed7795601d2d17a9c95");
    const [fieldA, fieldB] = [pad("f1f1"), pad("f2f2")];
    const [posA, posB] = [pad("a1a1"), pad("a2a2")];
    objectTypes.set(fieldA, `${pad("2")}::dynamic_field::Field<${pad("2")}::dynamic_object_field::Wrapper<${pad("2")}::object::ID>, ${pad("2")}::object::ID>`);
    objectTypes.set(fieldB, objectTypes.get(fieldA)!);
    objectTypes.set(kiosk, `${pad("2")}::kiosk::Kiosk`);
    getObjects.mockResolvedValue({
      objects: [{
        objectId: pool, type: `${CETUS}::pool::Pool<${GOBBLE}, ${SUI}>`,
        json: { current_sqrt_price: (1n << 64n).toString(), current_tick_index: { bits: 0 }, liquidity: "2", position_manager: { positions: { id: pad("7c"), size: "2" } } },
      }],
    });
    const info = (id: string) => ({ name: { json: id }, value: { json: { value: { position_id: id, liquidity: "1000000", tick_lower_index: { bits: 2 ** 32 - 100 }, tick_upper_index: { bits: 100 } } } } });
    gqlQuery.mockImplementation(async (query: string, vars: { keys?: Array<{ address: string }> }) => {
      if (query.includes("dynamicFields")) return { address: { dynamicFields: { nodes: [info(posA), info(posB)], pageInfo: { hasNextPage: false, endCursor: null } } } };
      if (query.includes("asMoveObject")) {
        return { multiGetObjects: [fieldA, fieldB].map((field) => ({ owner: { address: { address: field } }, asMoveObject: { contents: { type: { repr: `${CETUS}::position::Position` } } } })) };
      }
      return { multiGetObjects: vars.keys!.map(() => ({ owner: { address: { address: kiosk } } })) };
    });
    const result = await analyzeLiquidityCustody(GOBBLE, [{
      pool_id: pool, protocol: "cetus", object_type: `${CETUS}::pool::Pool<${GOBBLE}, ${SUI}>`, token_a: GOBBLE, token_b: SUI,
    }]);
    const row = result.pools[0] as { holders: Array<Record<string, unknown>> };
    expect(row.holders).toEqual([expect.objectContaining({
      address: kiosk, kind: "kiosk", share: 1, position_count: 2, position_ids: [posA, posB], held_as_dynamic_object_field: true,
    })]);
  });
});
