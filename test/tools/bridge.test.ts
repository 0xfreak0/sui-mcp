import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
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
    expect(dest.redeemed_via_contract.account).toBe("eip155:1:0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed");
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
    expect(dest.redeemed_via_contract.account).toBeNull();
    expect(dest.chain).toBeNull();
    expect(dest.wormhole_chain_id).toBe(2);
    expect(dest.redeemed_via_contract.address_note).toMatch(/reuses its chain numbers/i);
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

  it("names a protocol it cannot read a destination for rather than reporting nothing happened", async () => {
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

  it("names Mayan's beneficiary and marks the CCTP leg as settlement (6jMEFeap…)", async () => {
    // 54.4M of the Cetus attacker's 61.3M USDC left through Mayan. The CCTP
    // burn mints to Mayan's contract 0x875d…, which was reported as the
    // destination account with a next step to record it.
    const pkg = "0xb5bd3599ec7f4ae86afd84398f6f2d862deecce965e8ace2d8d8c8108d5076df";
    mockGqlQuery.mockResolvedValue(
      txWith([
        {
          contents: {
            type: { repr: "0x2aa6::deposit_for_burn::DepositForBurn" },
            json: {
              nonce: "80750",
              amount: "1000000000000",
              mint_recipient: "0x000000000000000000000000875d6d37ec55c8cf220b9e5080717549d8aa8eca",
              destination_domain: 0,
            },
          },
        },
        {
          contents: {
            type: { repr: `${pkg}::init_order::OrderCreated` },
            json: { addr_dest: "0x00000000000000000000000089012a55cd6b88e407c9d4ae9b3425f55924919b", chain_dest: 2 },
          },
        },
        { contents: { type: { repr: `${pkg}::init_order::InitMctpLogged` }, json: {} } },
      ]),
    );
    const data = await call({ digest: "D", include_destination: false });
    expect(data.beneficiaries.map((b: { account: string }) => b.account)).toEqual([
      "eip155:1:0x89012a55cd6b88e407c9d4ae9b3425f55924919b",
    ]);
    expect(data.circle_cctp[0].role).toBe("settlement_intermediate");
  });
});

/** resolve_bridge_transfer's own query, as mainnet returned it for each digest. */
const FIXTURES: Record<string, unknown> = JSON.parse(
  readFileSync(new URL("../fixtures/bridge-transactions.json", import.meta.url), "utf8"),
);

describe("resolve_bridge_transfer on the newer bridges", () => {
  const LZ_SCAN = {
    data: [
      {
        guid: "0xb108fd02770cbe42f914326c8941d6bd57086a77cd9434d394e6629dd83d1386",
        status: { name: "DELIVERED" },
        source: { status: "SUCCEEDED" },
        pathway: { sender: { name: "wBTC" }, receiver: { address: "0x0555e30da8f98308edb960aa94c0db47230d2b9c" } },
        destination: {
          status: "SUCCEEDED",
          tx: { txHash: "0xca09e0696b49f7ef759a7ad8114d6c8540ab3d88ef26367db88a9ce8dc91b210", blockTimestamp: 1790315927 },
        },
      },
    ],
  };

  it("names a LayerZero OFT recipient from chain data and the delivery from LayerZero Scan (4rH8bqFB…)", async () => {
    mockGqlQuery.mockResolvedValue(FIXTURES["4rH8bqFBzvaZFTvc74LH6DsHC79kHPm3TJD7tQc597Bg"]);
    fetchMock.mockResolvedValueOnce(jsonResponse(LZ_SCAN));
    const data = await call({ digest: "4rH8bqFBzvaZFTvc74LH6DsHC79kHPm3TJD7tQc597Bg" });

    expect(data.beneficiaries.map((b: { account: string }) => b.account)).toEqual([
      "eip155:1:0x5d99551ce4a2c1467adf632474424e7e22c72c66",
    ]);
    expect(data.layerzero[0].destination_oapp.address).toBe("0x0555e30da8f98308edb960aa94c0db47230d2b9c");
    expect(data.layerzero[0].delivery).toMatchObject({
      evidence: "indexer-attested",
      transaction: "0xca09e0696b49f7ef759a7ad8114d6c8540ab3d88ef26367db88a9ce8dc91b210",
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("scan.layerzero-api.com/v1/messages/tx/4rH8bqFB");
  });

  it("keeps the chain-derived LayerZero packet when the index is down", async () => {
    mockGqlQuery.mockResolvedValue(FIXTURES["4rH8bqFBzvaZFTvc74LH6DsHC79kHPm3TJD7tQc597Bg"]);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, statusText: "Service Unavailable" });
    const data = await call({ digest: "4rH8bqFBzvaZFTvc74LH6DsHC79kHPm3TJD7tQc597Bg" });

    expect(data.layerzero[0].delivery.status).toBe("lookup_failed");
    expect(data.beneficiaries[0].evidence).toBe("chain-derived");
  });

  it("names Allbridge's wallet as the beneficiary and marks its CCTP burn as the carrier (AyApNXU7…)", async () => {
    mockGqlQuery.mockResolvedValue(FIXTURES["AyApNXU7fNRcism61V76ijzxbXKAefLL6U5wXooJVthc"]);
    const data = await call({ digest: "AyApNXU7fNRcism61V76ijzxbXKAefLL6U5wXooJVthc" });

    expect(data.beneficiaries.map((b: { account: string }) => b.account)).toEqual([
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:EVouhT1HgMproxeVcFdmZERhbpnYS4taEV3tzG3zBbdV",
    ]);
    expect(data.circle_cctp[0].carries).toBe("Allbridge Core");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports Meson from its call, with no destination (7EyRb8Bb…)", async () => {
    mockGqlQuery.mockResolvedValue(FIXTURES["7EyRb8BbLPKvKQmuH2ExUFDnzxV6d6nhKGWBxG18ohiZ"]);
    const data = await call({ digest: "7EyRb8BbLPKvKQmuH2ExUFDnzxV6d6nhKGWBxG18ohiZ" });

    expect(data.other_bridge_activity.map((h: { protocol: string }) => h.protocol)).toEqual(["Meson"]);
    expect(data.beneficiaries).toBeUndefined();
    expect(data.note).toMatch(/cannot read that protocol's destination/);
  });

  it("reports an NTT redemption into Sui as inbound, with its origin VAA (H2qXS8fT…)", async () => {
    mockGqlQuery.mockResolvedValue(FIXTURES["H2qXS8fTHgeMvjME4aWShazkvLbp28DZc6ZrAGqKa6dU"]);
    const data = await call({ digest: "H2qXS8fTHgeMvjME4aWShazkvLbp28DZc6ZrAGqKa6dU" });

    expect(data.wormhole_inbound.direction).toBe("inbound");
    expect(data.wormhole_inbound.redemptions[0].vaa_id).toBe(
      "1/a84051ee54d531c23b904961e053801c73e446317a1a843421b5cfa2c1435fec/203",
    );
    expect(data.beneficiaries).toBeUndefined();
    expect(data.note).toMatch(/ARRIVING on Sui/);
  });

  it("counts a Mayan Swift order as a resolved exit, not an unreadable one (3aVcL3mh…)", async () => {
    mockGqlQuery.mockResolvedValue(FIXTURES["3aVcL3mhsmhrNbBS3L21YrF6tGXozpaHBB7TVJqpsEMR"]);
    const data = await call({ digest: "3aVcL3mhsmhrNbBS3L21YrF6tGXozpaHBB7TVJqpsEMR" });

    expect(data.beneficiaries[0].protocol).toBe("Mayan Swift");
    expect(data.other_bridge_activity).toBeUndefined();
    expect(data.note).toContain("Mayan Swift");
  });
});
