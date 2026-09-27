import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runWithNetwork } from "../../src/config.js";

// Synthetic fixtures: every package, object, address and digest here is made up.
const mockGqlQuery = vi.fn();
vi.mock("../../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));

// Loaded after the mock above, which these modules' GraphQL client must see.
const { registerBridgeTools } = await import("../../src/tools/bridge.js");
const { addSessionLabel, removeSessionLabel } = await import("../../src/utils/labels.js");
const { clearLabeledObjectTypes } = await import("../../src/utils/bridge/labeled-package.js");
const { clearPackageRootCache } = await import("../../src/protocols/package-roots.js");

const tools = new Map<string, Function>();
registerBridgeTools({
  tool: (name: string, _d: string, _s: unknown, handler: Function) => tools.set(name, handler),
} as unknown as McpServer);
const resolve = tools.get("resolve_bridge_transfer")!;

const hex32 = (byte: string) => `0x${byte.repeat(32)}`;
const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const USDC = `${hex32("dc")}::usdc::USDC`;
const WORMHOLE_CORE = hex32("c0");

/** A version-1 VAA with no signatures, as a BCS `vector<u8>` pure input. */
function vaaInput(chain: number, emitterByte: number, sequence: bigint, payload: Buffer) {
  const body = Buffer.alloc(51);
  body.writeUInt16BE(chain, 8);
  Buffer.alloc(32, emitterByte).copy(body, 10);
  body.writeBigUInt64BE(sequence, 42);
  const vaa = Buffer.concat([Buffer.from([1, 0, 0, 0, 4, 0]), body, payload]);
  const len = vaa.length;
  const uleb = len < 128 ? Buffer.from([len]) : Buffer.from([(len & 0x7f) | 0x80, len >> 7]);
  return { __typename: "MoveValue", type: { repr: "vector<u8>" }, bcs: Buffer.concat([uleb, vaa]).toString("base64") };
}

const move = (pkg: string, module: string, fn: string) => ({
  __typename: "MoveCallCommand",
  function: { name: fn, module: { name: module, package: { address: pkg } } },
});

const change = (address: string, coin: string, amount: string) => ({ owner: { address }, coinType: { repr: coin }, amount });

function tx(parts: { events: unknown[]; commands: unknown[]; inputs?: unknown[]; changes?: unknown[]; sender?: string }) {
  return {
    transaction: {
      digest: "D",
      sender: { address: parts.sender ?? hex32("50") },
      effects: {
        status: "SUCCESS",
        balanceChanges: { nodes: parts.changes ?? [] },
        events: { nodes: parts.events },
      },
      kind: { commands: { nodes: parts.commands }, inputs: { nodes: parts.inputs ?? [] } },
    },
  };
}

/**
 * Answers each query the tool makes: the transaction, lineage roots (each
 * package its own root unless `roots` says otherwise) and object types.
 */
function serve(response: unknown, opts: { roots?: Record<string, string>; types?: Record<string, string> } = {}) {
  mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown>) => {
    if (query.includes("packageVersions")) {
      return Object.fromEntries(
        Object.entries(vars).map(([k, id]) => [`p${k.slice(1)}`, { nodes: [{ address: opts.roots?.[id as string] ?? id }] }]),
      );
    }
    if (query.includes("multiGetObjects")) {
      return {
        multiGetObjects: (vars.keys as Array<{ address: string }>).map((k) =>
          opts.types?.[k.address] ? { address: k.address, asMoveObject: { contents: { type: { repr: opts.types[k.address] } } } } : null,
        ),
      };
    }
    return response;
  });
}

async function call(args: Record<string, unknown>) {
  const res = await runWithNetwork("mainnet", () => resolve(args));
  return JSON.parse(res.content[0].text);
}

beforeEach(() => {
  mockGqlQuery.mockReset();
  clearLabeledObjectTypes();
  clearPackageRootCache();
  vi.stubGlobal("fetch", vi.fn());
});

describe("resolve_bridge_transfer on an inbound fulfilment", () => {
  const FULFIL = hex32("f1");
  const STATE = hex32("5a");
  const BENEFICIARY = hex32("be");
  const SOLVER = hex32("50");
  const RECEIVER = hex32("3e");
  const PAYLOAD = Buffer.alloc(32, 0xab);

  afterEach(() => runWithNetwork("mainnet", () => removeSessionLabel(STATE)));

  it("reports the origin chain from the quoted CCTP message, the VAA it consumed, and the credited beneficiary", async () => {
    runWithNetwork("mainnet", () => addSessionLabel(STATE, { label: "Example bridge state", category: "bridge" }, false));
    serve(
      tx({
        sender: SOLVER,
        events: [
          {
            contents: {
              type: { repr: `${FULFIL}::fulfil::Prepared` },
              json: { hash: `0x${PAYLOAD.toString("hex")}`, auction_sequence: "77", cctp_nonce: "1234", cctp_source_domain: 0, amount_net: "5000000" },
            },
            transactionModule: { fullyQualifiedName: `${FULFIL}::fulfil` },
          },
          {
            contents: {
              type: { repr: `${FULFIL}::fulfil::Fulfilled` },
              json: { hash: `0x${PAYLOAD.toString("hex")}`, amount_net: "900000000000", coin_type: SUI.slice(2) },
            },
            transactionModule: { fullyQualifiedName: `${FULFIL}::fulfil` },
          },
        ],
        commands: [move(WORMHOLE_CORE, "vaa", "parse_and_verify"), move(FULFIL, "fulfil", "prepare"), move(FULFIL, "fulfil", "complete")],
        // A price-update VAA beside the consumed one: nothing quotes it.
        inputs: [vaaInput(26, 0x11, 900n, Buffer.alloc(40, 0x22)), vaaInput(1, 0x83, 77n, PAYLOAD)],
        changes: [
          change(BENEFICIARY, SUI, "900000000000"),
          change(SOLVER, USDC, "12345"),
          change(SOLVER, SUI, "-1000"),
          change(RECEIVER, USDC, "-5012345"),
        ],
      }),
      { types: { [STATE]: `${FULFIL}::state::State` } },
    );

    const data = await call({ digest: "D" });
    const [f] = data.fulfilment_inbound.fulfilments;

    expect(data.fulfilment_inbound.fulfilments).toHaveLength(1);
    expect(f.package).toBe(FULFIL);
    expect(f.origin_chain).toBe("eip155:1");
    expect(f.origin_basis).toBe("cctp-source-domain");
    // The domain is read from another package's field named for it.
    expect(f.evidence).toBe("heuristic");
    expect(f.cctp.transfer_id).toBe("0/1234");
    expect(f.vaa.vaa_id).toBe(`1/${"83".repeat(32)}/77`);
    expect(f.vaa.verified_in_transaction).toBe(true);
    expect(f.vaa.quoted_by.map((q: { field: string }) => q.field).sort()).toEqual(["auction_sequence", "hash", "hash"]);
    expect(f.beneficiary).toMatchObject({ evidence: "chain-derived", address: BENEFICIARY, amount: "900000000000" });
    expect(f.beneficiary.matched.field).toBe("amount_net");
    expect(f.released_from).toEqual([{ address: RECEIVER, coin_type: USDC, amount: "-5012345" }]);
    expect(f.protocol).toMatchObject({ name: "Example bridge state", identified_via: "labeled-object" });
    expect(f.protocol.labeled_objects[0].object).toBe(STATE);
    expect(data.note).toMatch(/ARRIVING on Sui/);
  });

  it("takes the origin from the VAA when no CCTP message is quoted, and marks an unmatched credit heuristic", async () => {
    serve(
      tx({
        sender: SOLVER,
        events: [
          {
            contents: { type: { repr: `${FULFIL}::redeem::Redeemed` }, json: { vaa_sequence: "4410", fee: "3" } },
            transactionModule: { fullyQualifiedName: `${FULFIL}::redeem` },
          },
        ],
        commands: [move(WORMHOLE_CORE, "vaa", "parse_and_verify"), move(FULFIL, "redeem", "redeem")],
        inputs: [vaaInput(2, 0x44, 4410n, Buffer.alloc(8, 0x01))],
        changes: [change(BENEFICIARY, SUI, "31000"), change(SOLVER, SUI, "-900")],
      }),
    );

    const data = await call({ digest: "D" });
    const [f] = data.fulfilment_inbound.fulfilments;

    expect(f.origin_basis).toBe("wormhole-vaa");
    expect(f.evidence).toBe("chain-derived");
    expect(f.origin_chain).toBe("eip155:1");
    expect(f.vaa.vaa_id).toBe(`2/${"44".repeat(32)}/4410`);
    expect(f.beneficiary).toMatchObject({ evidence: "heuristic", address: BENEFICIARY, matched: null });
    expect(f.protocol).toBeNull();
  });
});

describe("resolve_bridge_transfer names the package that made the bridge call", () => {
  const ADAPTER = hex32("ad");
  const CCTP_V1 = hex32("c1");
  const CCTP_V2 = hex32("c2");
  const NATIVE_DEPOSIT = {
    contents: {
      type: { repr: "0x000000000000000000000000000000000000000000000000000000000000000b::bridge::TokenDepositedEvent" },
      json: {
        seq_num: "5",
        source_chain: 0,
        sender_address: Buffer.alloc(32, 0x77).toString("base64"),
        target_chain: 10,
        target_address: Buffer.alloc(20, 0x66).toString("base64"),
        token_type: 2,
        amount: "100",
      },
    },
    transactionModule: { fullyQualifiedName: `${ADAPTER}::route` },
  };

  it("reports an adapter outside the bridge's lineage as the carrier, and not an upgraded version of the bridge", async () => {
    serve(
      tx({
        events: [
          NATIVE_DEPOSIT,
          {
            contents: { type: { repr: `${ADAPTER}::route::Routed` }, json: { order_id: "9", adaptor: 7 } },
            transactionModule: { fullyQualifiedName: `${ADAPTER}::route` },
          },
          {
            contents: {
              type: { repr: `${CCTP_V1}::deposit_for_burn::DepositForBurn` },
              json: { nonce: "8", amount: "10", depositor: hex32("de"), mint_recipient: `0x${"00".repeat(12)}${"99".repeat(20)}`, destination_domain: 3 },
            },
            transactionModule: { fullyQualifiedName: `${CCTP_V2}::deposit_for_burn` },
          },
        ],
        commands: [move(ADAPTER, "route", "bridge_out"), move(CCTP_V2, "deposit_for_burn", "deposit_for_burn")],
      }),
      { roots: { [CCTP_V2]: CCTP_V1 } },
    );

    const data = await call({ digest: "D", include_destination: false });

    expect(data.carriers).toHaveLength(1);
    expect(data.carriers[0]).toMatchObject({
      evidence: "chain-derived",
      package: ADAPTER,
      module: "route",
      functions: ["route::bridge_out"],
      carried: ["Sui Bridge"],
    });
    expect(data.carriers[0].emitted).toEqual([{ type: `${ADAPTER}::route::Routed`, fields: { order_id: "9", adaptor: 7 } }]);
    expect(data.note).toContain(`${ADAPTER}::route::bridge_out`);
  });
});
