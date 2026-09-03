import { describe, it, expect, vi, beforeEach } from "vitest";
import { runWithNetwork } from "../../src/config.js";

const mockGqlQuery = vi.fn();
vi.mock("../../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));

const { registerBridgeTools } = await import("../../src/tools/bridge.js");

const tools = new Map<string, Function>();
registerBridgeTools({
  tool: (name: string, _d: string, _s: unknown, handler: Function) => tools.set(name, handler),
} as any);
const resolve = tools.get("resolve_bridge_transfer")!;

const WORMHOLE_EVENT = {
  contents: {
    type: {
      repr: "0x5306f64e312b581766351c07af79c72fcb1cd25147157fdc2f8ad76de9a3fb6a::publish_message::WormholeMessage",
    },
    json: {
      sender: "0x89b91e68d0264956632bf11f8abd2243caa56c4a42c97d9b97eadc71bf1074bf",
      sequence: "188994",
      nonce: 0,
      consistency_level: 0,
    },
  },
};
/** The real mainnet burn payload, so the destination actually resolves. */
const CCTP_EVENT = {
  contents: {
    type: { repr: "0xabc::deposit_for_burn::DepositForBurn" },
    json: {
      nonce: "425380",
      amount: "11085939",
      depositor: "0x13b9da3c7102c1e94a02e926a544e50b93eecdfa3eef2300b99274ff4a5803d5",
      mint_recipient: "0x0000000000000000000000009a62c1af2dff7f6b1731d9eb36b1622c17eae7be",
      destination_domain: 3,
    },
  },
};

const MAYAN_EVENT = {
  contents: { type: { repr: "0xabc::init_order::InitMctpLogged" }, json: {} },
};

const txWith = (nodes: unknown[]) => ({
  transaction: { digest: "D", effects: { events: { nodes } } },
});

async function call(args: Record<string, unknown>, network: "mainnet" | "testnet" | "devnet" = "mainnet") {
  const res = await runWithNetwork(network, () => resolve(args));
  return JSON.parse(res.content[0].text);
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  mockGqlQuery.mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

const jsonResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe("resolve_bridge_transfer", () => {
  it("returns the chain-derived VAA identity without consulting the indexer", async () => {
    mockGqlQuery.mockResolvedValue(txWith([WORMHOLE_EVENT]));
    const data = await call({ digest: "D", include_destination: false });

    expect(data.wormhole_messages[0].vaa_id).toBe(
      "21/89b91e68d0264956632bf11f8abd2243caa56c4a42c97d9b97eadc71bf1074bf/188994",
    );
    expect(data.wormhole_messages[0].evidence).toBe("chain-derived");
    expect(data.wormhole_messages[0].destination.status).toBe("not_requested");
    // The whole point of the flag: no third party is contacted.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to the VAA triple when the source-transaction lookup misses", async () => {
    mockGqlQuery.mockResolvedValue(txWith([WORMHOLE_EVENT]));
    fetchMock
      // /operations?txHash=... — indexed under a hash we did not match.
      .mockResolvedValueOnce(jsonResponse({ operations: [] }))
      // /operations/21/<emitter>/<seq> — the key the guardians actually sign.
      .mockResolvedValueOnce(
        jsonResponse({
          id: "21/89b91e68d0264956632bf11f8abd2243caa56c4a42c97d9b97eadc71bf1074bf/188994",
          targetChain: {
            chainId: 2,
            status: "completed",
            to: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
            transaction: { txHash: "0xdead" },
          },
        }),
      );

    const data = await call({ digest: "D" });
    const dest = data.wormhole_messages[0].destination;
    expect(dest.status).toBe("completed");
    expect(dest.account).toBe("eip155:1:0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not spend a second request when the transaction lookup already resolved it", async () => {
    mockGqlQuery.mockResolvedValue(txWith([WORMHOLE_EVENT]));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        operations: [
          {
            id: "21/89b91e68d0264956632bf11f8abd2243caa56c4a42c97d9b97eadc71bf1074bf/188994",
            targetChain: { chainId: 2, status: "completed", to: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed" },
          },
        ],
      }),
    );
    await call({ digest: "D" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the chain-derived half when the indexer fails", async () => {
    mockGqlQuery.mockResolvedValue(txWith([WORMHOLE_EVENT]));
    fetchMock.mockResolvedValue({ ok: false, status: 503, statusText: "Service Unavailable" });

    const data = await call({ digest: "D" });
    // The evidence survives the indexer being down; only the lead is lost.
    expect(data.wormhole_messages[0].vaa_id).toContain("188994");
    expect(data.wormhole_messages[0].destination.status).toBe("lookup_failed");
  });

  it("withholds CAIP-2 ids off mainnet, where Wormhole chain numbers mean other chains", async () => {
    mockGqlQuery.mockResolvedValue(txWith([WORMHOLE_EVENT]));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        operations: [
          {
            id: "21/89b91e68d0264956632bf11f8abd2243caa56c4a42c97d9b97eadc71bf1074bf/188994",
            targetChain: { chainId: 2, status: "completed", to: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed" },
          },
        ],
      }),
      );

    const data = await call({ digest: "D" }, "testnet");
    const dest = data.wormhole_messages[0].destination;
    // On testnet, Wormhole chain 2 is Sepolia — calling it eip155:1 would file
    // a testnet address under a mainnet chain and read as verified.
    expect(dest.account).toBeNull();
    expect(dest.chain).toBeNull();
    expect(dest.wormhole_chain_id).toBe(2);
    expect(dest.address_note).toMatch(/reuses its chain numbers/i);
  });

  it("says the network has no index rather than querying the wrong one", async () => {
    mockGqlQuery.mockResolvedValue(txWith([WORMHOLE_EVENT]));
    const data = await call({ digest: "D" }, "devnet");

    expect(data.wormhole_messages[0].destination.status).toBe("no_index_for_network");
    // Querying mainnet's index with a devnet digest would return nothing and
    // read as "never redeemed".
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves a CCTP exit from chain data when there is no Wormhole message", async () => {
    mockGqlQuery.mockResolvedValue(txWith([CCTP_EVENT]));
    const data = await call({ digest: "D" });

    expect(data.wormhole_messages).toEqual([]);
    expect(data.circle_cctp[0].evidence).toBe("chain-derived");
    expect(data.circle_cctp[0].destination_account).toBe(
      "eip155:42161:0x9a62c1af2dff7f6b1731d9eb36b1622c17eae7be",
    );
    // No indexer was contacted for the destination.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names a detect-only protocol rather than reporting nothing happened", async () => {
    mockGqlQuery.mockResolvedValue(txWith([MAYAN_EVENT]));
    const data = await call({ digest: "D" });

    expect(data.wormhole_messages).toEqual([]);
    expect(data.other_bridge_activity[0].protocol).toContain("Mayan");
    expect(data.note).toMatch(/funds did leave/i);
  });

  it("errors clearly on a transaction that does not exist", async () => {
    mockGqlQuery.mockResolvedValue({ transaction: null });
    const res = await runWithNetwork("mainnet", () => resolve({ digest: "nope" }));
    expect(res.isError).toBe(true);
  });
});
