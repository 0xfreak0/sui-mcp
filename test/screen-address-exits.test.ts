import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/utils/price-providers.js", () => ({ pricesForRanking: async () => new Map() }));
/** A coin with no CoinMetadata answers NOT_FOUND over gRPC. */
const mockGetCoinInfo = vi.fn();
vi.mock("../src/clients/grpc.js", () => ({ sui: { stateService: { getCoinInfo: mockGetCoinInfo } }, archive: {} }));

const { screenAddress } = await import("../src/utils/screening.js");
const { resetLiveCoinScale } = await import("../src/utils/valuation.js");

/**
 * A sender with 14 CCTP burns and one Mayan order (62MTsGpC…), which fires
 * Mayan's, Wormhole's and CCTP's markers. The order counts once, under
 * Mayan, and destination reads are taken from each bridge group in turn, so
 * ten reads still reach the Mayan group, whose beneficiary is
 * chain-readable. Transaction and event shapes below are the GraphQL
 * service's, read from those digests.
 */
const ATTACKER = "0xc99ac031ff19e9bff0b5b3f5b870c82402db99c30dfec2d406eb2088be6c2194";
const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const MAYAN_PKG = "0xb5bd3599ec7f4ae86afd84398f6f2d862deecce965e8ace2d8d8c8108d5076df";
const CCTP_BURN = "0x2aa6c5d56376c371f88a6cc42e852824994993cb9bab8d3e6450cbe3cb32b94e::deposit_for_burn::DepositForBurn";
const WORMHOLE_MSG = "0x5306f64e312b581766351c07af79c72fcb1cd25147157fdc2f8ad76de9a3fb6a::publish_message::WormholeMessage";
const MAYAN_DIGEST = "62MTsGpC8t9TosVErGxMfUNc1LnR2hJdLBNmDM8yBXrT";

const call = (module: string, fn: string, pkg = "0x1") => ({ function: { name: fn, module: { name: module, package: { address: pkg } } } });

const cctpBurn = (i: number) => ({
  digest: `cctpBurn${i}`,
  sender: { address: ATTACKER },
  gasInput: { gasSponsor: { address: ATTACKER } },
  effects: {
    status: "SUCCESS",
    timestamp: `2025-10-15T13:${String(10 + i).padStart(2, "0")}:00Z`,
    gasEffects: { gasSummary: { computationCost: "1000", storageCost: "0", storageRebate: "0" } },
    balanceChanges: { nodes: [{ amount: "-10000000000", owner: { address: ATTACKER }, coinType: { repr: USDC } }] },
    events: { pageInfo: { hasNextPage: false }, nodes: [{ contents: { type: { repr: CCTP_BURN } } }] },
  },
  kind: { commands: { nodes: [call("deposit_for_burn", "deposit_for_burn")] } },
});

const mayanOrder = {
  digest: MAYAN_DIGEST,
  sender: { address: ATTACKER },
  gasInput: { gasSponsor: { address: ATTACKER } },
  effects: {
    status: "SUCCESS",
    timestamp: "2025-10-15T13:47:15.214Z",
    gasEffects: { gasSummary: { computationCost: "1000", storageCost: "0", storageRebate: "0" } },
    balanceChanges: { nodes: [{ amount: "-120724257370", owner: { address: ATTACKER }, coinType: { repr: SUI } }] },
    events: {
      pageInfo: { hasNextPage: false },
      nodes: [
        { contents: { type: { repr: CCTP_BURN } } },
        { contents: { type: { repr: `${MAYAN_PKG}::init_order::OrderCreated` } } },
        { contents: { type: { repr: WORMHOLE_MSG } } },
        { contents: { type: { repr: `${MAYAN_PKG}::init_order::InitMctpLogged` } } },
      ],
    },
  },
  kind: {
    commands: {
      nodes: [
        call("calculate_mctp_fee", "calculate_mctp_fee", MAYAN_PKG),
        call("deposit_for_burn", "deposit_for_burn_with_caller_with_package_auth"),
        call("publish_message", "publish_message"),
        call("init_order", "log_initialize_mctp", MAYAN_PKG),
      ],
    },
  },
};

/** 62MTsGpC…'s events with the fields the beneficiary readers use, as the service returned them. */
const mayanEvents = [
  {
    contents: {
      type: { repr: CCTP_BURN },
      json: {
        nonce: "250187",
        amount: "335761619",
        mint_recipient: "0x000000000000000000000000875d6d37ec55c8cf220b9e5080717549d8aa8eca",
        destination_domain: 0,
        destination_caller: "0x000000000000000000000000875d6d37ec55c8cf220b9e5080717549d8aa8eca",
      },
    },
  },
  {
    contents: {
      type: { repr: `${MAYAN_PKG}::init_order::OrderCreated` },
      json: {
        trader: ATTACKER,
        amount_in: "335761619",
        addr_dest: "0x000000000000000000000000eb8a15d28dd54231e7e950f5720bc3d7af77b443",
        chain_dest: 2,
        cctp_nonce: "250187",
        domain_dest: 0,
      },
    },
  },
  { contents: { type: { repr: WORMHOLE_MSG }, json: { sequence: "102615", nonce: 0, payload: "lK8lmll78QD2YvD20VO9+Yt5gKpFpxO7wKqv87fMYbw=" } } },
  { contents: { type: { repr: `${MAYAN_PKG}::init_order::InitMctpLogged` }, json: { amount_in_initial: "120724256370" } } },
];

beforeEach(() => {
  resetLiveCoinScale();
  mockGetCoinInfo.mockReset();
  mockGetCoinInfo.mockRejectedValue(Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" }));
  mockGqlQuery.mockReset();
  mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown>) => {
    if (query.includes("transactions(filter")) {
      // Oldest first, as the window reverses `last` pages: fourteen burns, then the order.
      const nodes = [...Array.from({ length: 14 }, (_, i) => cctpBurn(i)), mayanOrder];
      return { transactions: { nodes, pageInfo: { hasPreviousPage: false, startCursor: null } } };
    }
    if (query.includes("transaction(digest")) {
      const nodes = vars.digest === MAYAN_DIGEST ? mayanEvents : [];
      return { transaction: { effects: { events: { pageInfo: { hasNextPage: false }, nodes } } } };
    }
    throw new Error(`unexpected query ${query.slice(0, 40)}`);
  });
});

describe("screenAddress bridge exits", () => {
  it("counts each exit once under its carrier and reads a destination for every bridge group", async () => {
    const r = await screenAddress(ATTACKER, {
      hops: 1,
      directions: ["out"],
      subjectTransactions: 300,
      hopTransactions: 50,
      maxExpand: 8,
      maxBridgeLookups: 10,
    });
    const bridges = r.exposures.filter((e) => e.category === "bridge");
    expect(bridges.map((e) => [e.label, e.exit_count]).sort()).toEqual([
      ["Circle CCTP", 14],
      ["Mayan MCTP", 1],
    ]);
    expect(r.bridge_exits_seen).toBe(15);

    const cctp = bridges.find((e) => e.label === "Circle CCTP")!;
    expect(cctp.digests).not.toContain(MAYAN_DIGEST);
    expect(String(cctp.sent)).not.toMatch(/SUI/);

    const mayan = bridges.find((e) => e.label === "Mayan MCTP")!;
    expect([...(mayan.route as string[])].sort()).toEqual(["Circle CCTP", "Wormhole"]);
    expect((mayan.destinations as Array<{ account: string }>).map((d) => d.account)).toEqual([
      "eip155:1:0xeb8a15d28dd54231e7e950f5720bc3d7af77b443",
    ]);
  });

  /**
   * An exit's `sent` is formatted at the coin's own decimals, read from
   * CoinMetadata for a coin in no curated list (here a 1-decimal coin).
   */
  it("formats an exit in a coin no curated list knows at its on-chain decimals", async () => {
    const KONG = "0xb0c3e7ae67c9161273aab9a06e589c1c13479337d14c794251a97df46822f2cb::kong::KONG";
    mockGetCoinInfo.mockImplementation(async ({ coinType }: { coinType: string }) => {
      if (coinType === KONG) return { response: { metadata: { decimals: 1, symbol: "KONG" } } };
      throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" });
    });
    const burn = cctpBurn(0);
    burn.effects.balanceChanges.nodes = [{ amount: "-7452793570", owner: { address: ATTACKER }, coinType: { repr: KONG } }];
    mockGqlQuery.mockImplementation(async (query: string) => {
      if (query.includes("transactions(filter")) return { transactions: { nodes: [burn], pageInfo: { hasPreviousPage: false, startCursor: null } } };
      return { transaction: { effects: { events: { pageInfo: { hasNextPage: false }, nodes: [] } } } };
    });
    const r = await screenAddress(ATTACKER, { hops: 1, directions: ["out"], subjectTransactions: 300, hopTransactions: 50, maxExpand: 8, maxBridgeLookups: 10 });
    const cctp = r.exposures.find((e) => e.label === "Circle CCTP")!;
    expect(cctp.sent).toBe("745279357 KONG");
  });
});

/**
 * One transaction is one exit under its carrier, and the destination read
 * keeps every bridge's beneficiaries. With an unrelated second bridge in the
 * transaction, the second bridge's recipient is screened too: a CCTP burn to
 * an OFAC-listed address beside a Wormhole message reports that destination
 * and its sanctions hit. The burn is 4rDEyqGe…'s DepositForBurn minting to an
 * OFAC-listed address; the Wormhole message is 6S9udfgK…'s and the Sui
 * Bridge deposit 4xLuY6N6…'s, as mainnet returned them.
 */
describe("screenAddress exits through unrelated bridges", () => {
  const SANCTIONED = "eip155:1:0x0330070fd38ec3bb94f58fa55d40368271e9e54a";
  const BURN_TO_SANCTIONED = {
    contents: {
      type: { repr: CCTP_BURN },
      json: {
        nonce: "425380",
        burn_token: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7",
        amount: "11085939",
        depositor: ATTACKER,
        mint_recipient: "0x0000000000000000000000000330070fd38ec3bb94f58fa55d40368271e9e54a",
        destination_domain: 0,
      },
    },
  };
  const MESSAGE = {
    contents: {
      type: { repr: WORMHOLE_MSG },
      json: {
        sender: "0x45a4ce7279dc1da00f16555dca7c04c0f19bb168fd787e57026a79600524515b",
        sequence: "0",
        nonce: 0,
        payload: "DQYiE30jTxpOQT19NnZBAB1vff0iwCQkin4ecuWvRLE=",
        consistency_level: 0,
        timestamp: "1738073864",
      },
    },
  };
  const NATIVE_DEPOSIT = {
    contents: {
      type: { repr: "0x000000000000000000000000000000000000000000000000000000000000000b::bridge::TokenDepositedEvent" },
      json: {
        seq_num: "23371",
        source_chain: 0,
        sender_address: "xKRFS6UEKXM8q3C7Q0rJnXTSCnU0w9/Tux+m6Ts8SzI=",
        target_chain: 10,
        target_address: "1vBbGb8sBcJkpka3dXBX13RmHFw=",
        token_type: 4,
        amount: "130004100000",
      },
    },
  };

  const screenOne = async (events: Array<{ contents: { type: { repr: string } } }>) => {
    const exit = cctpBurn(0);
    exit.effects.events.nodes = events.map((e) => ({ contents: { type: e.contents.type } }));
    mockGqlQuery.mockImplementation(async (query: string) => {
      if (query.includes("transactions(filter")) return { transactions: { nodes: [exit], pageInfo: { hasPreviousPage: false, startCursor: null } } };
      if (query.includes("transaction(digest")) return { transaction: { effects: { events: { pageInfo: { hasNextPage: false }, nodes: events } } } };
      throw new Error(`unexpected query ${query.slice(0, 40)}`);
    });
    const r = await screenAddress(ATTACKER, { hops: 1, directions: ["out"], subjectTransactions: 50, hopTransactions: 50, maxExpand: 8, maxBridgeLookups: 10 });
    const bridges = r.exposures.filter((e) => e.category === "bridge");
    const sanctioned = r.exposures.filter((e) => e.category === "sanctioned");
    return { bridges, sanctioned };
  };
  const accounts = (e: Record<string, unknown>) => (e.destinations as Array<{ account: string }>).map((d) => d.account).sort();

  it("screens a CCTP recipient when it is the only bridge", async () => {
    const { bridges, sanctioned } = await screenOne([BURN_TO_SANCTIONED]);
    expect(bridges.map((e) => e.label)).toEqual(["Circle CCTP"]);
    expect(accounts(bridges[0])).toEqual([SANCTIONED]);
    expect(sanctioned).toMatchObject([{ counterparty: SANCTIONED, via_bridge: { protocol: "Circle CCTP" } }]);
  });

  it("screens the CCTP recipient when an unrelated Wormhole message carries the exit", async () => {
    const { bridges, sanctioned } = await screenOne([BURN_TO_SANCTIONED, MESSAGE]);
    expect(bridges.map((e) => [e.label, e.exit_count, e.route, e.also_exited])).toEqual([["Wormhole", 1, undefined, ["Circle CCTP"]]]);
    expect(accounts(bridges[0])).toEqual([SANCTIONED]);
    expect(sanctioned).toMatchObject([{ counterparty: SANCTIONED, via_bridge: { protocol: "Circle CCTP" } }]);
  });

  it("screens both recipients of a Sui Bridge deposit and a CCTP burn in one transaction", async () => {
    const { bridges, sanctioned } = await screenOne([BURN_TO_SANCTIONED, NATIVE_DEPOSIT]);
    expect(bridges.map((e) => [e.label, e.exit_count, e.also_exited])).toEqual([["Sui Bridge", 1, ["Circle CCTP"]]]);
    expect(accounts(bridges[0])).toEqual([SANCTIONED, "eip155:1:0xd6f05b19bf2c05c264a646b7757057d774661c5c"].sort());
    expect(sanctioned.map((e) => e.counterparty)).toEqual([SANCTIONED]);
  });
});

/**
 * An Allbridge pool transfer sent through Allbridge's Wormhole messenger
 * (messenger 2) also emits a WormholeMessage. The exit is filed under
 * Allbridge, and its recipient, the only one the transaction names, is
 * screened. Events, calls, balance changes and gas are the service's for
 * each digest; the three are put in one sender's window.
 */
describe("screenAddress Allbridge exits", () => {
  const SENDER = "0x22101391e2bbd3141e0aabd093643fad4c6fba70438071d8cd7364ca0225f9a7";
  const FIXTURES = JSON.parse(readFileSync(new URL("./fixtures/bridge-transactions.json", import.meta.url), "utf8"));
  const eventsOf = (digest: string) => FIXTURES[digest].transaction.effects.events.nodes as Array<{ contents: { type: { repr: string } } }>;
  const node = (digest: string, timestamp: string, gasSummary: Record<string, number>, changes: Array<[string, string]>) => ({
    digest,
    sender: { address: SENDER },
    gasInput: { gasSponsor: { address: SENDER } },
    effects: {
      status: "SUCCESS",
      timestamp,
      gasEffects: { gasSummary },
      balanceChanges: { nodes: changes.map(([amount, coin]) => ({ amount, owner: { address: SENDER }, coinType: { repr: coin } })) },
      events: { pageInfo: { hasNextPage: false }, nodes: eventsOf(digest).map((e) => ({ contents: { type: e.contents.type } })) },
    },
    kind: { commands: { nodes: (FIXTURES[digest].transaction.kind.commands.nodes as Array<{ function?: unknown }>).map((c) => (c.function ? { function: c.function } : {})) } },
  });
  const WORMHOLE_ROUTE = node(
    "6S9udfgK1GSCabDEsuUDB4ysdCTXkfvt2rwze2Wrdb7K",
    "2025-01-28T14:17:44.485Z",
    { computationCost: 1500000, storageCost: 24715200, storageRebate: 19908504 },
    [["-155468284", SUI], ["-100000", USDC]],
  );
  const CCTP_ROUTE = node(
    "AyApNXU7fNRcism61V76ijzxbXKAefLL6U5wXooJVthc",
    "2026-09-11T06:25:25.813Z",
    { computationCost: 100000, storageCost: 15078400, storageRebate: 13294908 },
    [["-1883492", SUI], ["-50001933", USDC]],
  );
  const OWN_MESSENGER = node(
    "FmxxWhRozP6j8PUBKYNXnNpLJcwGgNWuQkurvY2M1pxj",
    "2026-07-19T18:23:28.656Z",
    { computationCost: 100000, storageCost: 23294000, storageRebate: 19479636 },
    [["-3914364", SUI], ["-186664585", USDC]],
  );

  const screen = async (nodes: unknown[]) => {
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown>) => {
      if (query.includes("transactions(filter")) return { transactions: { nodes, pageInfo: { hasPreviousPage: false, startCursor: null } } };
      if (query.includes("transaction(digest")) {
        return { transaction: { effects: { events: { pageInfo: { hasNextPage: false }, nodes: eventsOf(vars.digest as string) } } } };
      }
      throw new Error(`unexpected query ${query.slice(0, 40)}`);
    });
    const r = await screenAddress(SENDER, { hops: 1, directions: ["out"], subjectTransactions: 50, hopTransactions: 50, maxExpand: 8, maxBridgeLookups: 10 });
    return r.exposures.filter((e) => e.category === "bridge");
  };

  it("files a pool transfer sent through Allbridge's Wormhole messenger under Allbridge and screens its recipient", async () => {
    const [only, ...rest] = await screen([WORMHOLE_ROUTE]);
    expect(rest).toEqual([]);
    expect(only.label).toBe("Allbridge Core");
    expect(only.route).toEqual(["Wormhole"]);
    expect((only.destinations as Array<{ account: string }>).map((d) => d.account)).toEqual([
      "eip155:42161:0xfb4717318748a204b028e7920bb86fe2b110917c",
    ]);
  });

  it("keeps the CCTP route over CCTP and the pool's own messenger with no route", async () => {
    const exposures = await screen([CCTP_ROUTE, OWN_MESSENGER]);
    expect(exposures.map((e) => [e.label, e.exit_count, e.route])).toEqual([["Allbridge Core", 2, ["Circle CCTP"]]]);
    expect((exposures[0].destinations as Array<{ account: string }>).map((d) => d.account).sort()).toEqual([
      "eip155:1:0x1c68916c0eddb9d88f88f89cfdacb5388a50781f",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:EVouhT1HgMproxeVcFdmZERhbpnYS4taEV3tzG3zBbdV",
    ]);
  });
});
