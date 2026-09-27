import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FormattedCommand } from "../src/utils/ptb-anomalies.js";

const getObjects = vi.fn();
const getBalance = vi.fn();
const gqlQuery = vi.fn();
vi.mock("../src/clients/grpc.js", () => ({ sui: { getObjects, getBalance }, archive: {} }));
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery }));

// Imported after the mocks: vi.mock is hoisted above the fns its factories return.
const { presignSends, readPresignContext } = await import("../src/utils/presign-context.js");

const SENDER = `0x${"5e".repeat(32)}`;
const STRANGER = `0x${"a7".repeat(32)}`;
const OLD_FRIEND = `0x${"b8".repeat(32)}`;
const GAS = `0x${"9a".repeat(32)}`;
const USDC_COIN = `0x${"c1".repeat(32)}`;
const NFT = `0x${"d2".repeat(32)}`;
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const SUI = `0x${"0".repeat(63)}2::sui::SUI`;

const to = (address: string) => ({ type: "Input", index: 9, value_type: "address", address });
const commands: FormattedCommand[] = [
  { type: "SplitCoins", coin: { type: "GasCoin" }, amounts: [{ type: "Input", index: 0, value_type: "u64", value: "990000000000" }] },
  { type: "TransferObjects", objects: [{ type: "Result", index: 0, from: "SplitCoins" }], address: to(STRANGER) },
  { type: "TransferObjects", objects: [{ type: "Input", index: 1, object_id: USDC_COIN }, { type: "Input", index: 2, object_id: NFT }], address: to(OLD_FRIEND) },
  { type: "TransferObjects", objects: [{ type: "GasCoin" }], address: to(SENDER) },
];

beforeEach(() => {
  vi.clearAllMocks();
  getObjects.mockResolvedValue({
    objects: [
      { objectId: USDC_COIN, type: `0x2::coin::Coin<${USDC}>`, json: { id: USDC_COIN, balance: "250000000" } },
      { objectId: NFT, type: "0xabc::art::Piece", json: { id: NFT } },
      { objectId: GAS, type: `0x2::coin::Coin<${SUI}>`, json: { id: GAS, balance: "1000000000000" } },
    ],
  });
  getBalance.mockImplementation(async ({ coinType }: { coinType: string }) => ({ balance: { coinType, balance: coinType === SUI ? "1000000000000" : "1000000000" } }));
  gqlQuery.mockResolvedValue({ a0: { nodes: [] }, a1: { nodes: [{ digest: "Fr1end", effects: { timestamp: "2025-01-02T00:00:00Z" } }] } });
});

describe("presignSends", () => {
  it("resolves what each command hands another address to its source coin and amount, and skips the sender", () => {
    expect(presignSends(commands, SENDER)).toEqual([
      { command: 1, recipient: STRANGER, source: { gas: true }, amount: "990000000000", merged: [] },
      { command: 2, recipient: OLD_FRIEND, source: { object_id: USDC_COIN }, amount: null, merged: [] },
      { command: 2, recipient: OLD_FRIEND, source: { object_id: NFT }, amount: null, merged: [] },
    ]);
  });
});

describe("readPresignContext", () => {
  it("sets each coin sent against the sender's balance now and reads when each recipient first appeared", async () => {
    const c = await readPresignContext(SENDER, presignSends(commands, SENDER), [GAS]);
    expect(c.coins).toEqual([
      { coin_type: SUI, sent: "990000000000", sender_balance: "1000000000000", share_of_balance: 0.99 },
      { coin_type: USDC, sent: "250000000", sender_balance: "1000000000", share_of_balance: 0.25 },
    ]);
    expect(c.objects_sent).toEqual([`${NFT} (0xabc::art::Piece)`]);
    expect(c.recipients).toEqual([
      { address: STRANGER, first_seen: null, first_digest: null },
      { address: OLD_FRIEND, first_seen: "2025-01-02T00:00:00Z", first_digest: "Fr1end" },
    ]);
    expect(c.unread).toEqual([]);
  });

  it("does not report a recipient as never seen when its history could not be read", async () => {
    gqlQuery.mockRejectedValue(new Error("rate limited"));
    const c = await readPresignContext(SENDER, presignSends(commands, SENDER), [GAS]);
    expect(c.recipients).toEqual([{ address: STRANGER }, { address: OLD_FRIEND }]);
    expect(c.unread).toHaveLength(1);
  });
});

describe("presign_context on a send-max drain", () => {
  const coin = (i: number) => `0x${(0xe0 + i).toString(16).repeat(32)}`;
  const input = (object_id: string) => ({ type: "Input", index: 1, object_id });

  it("counts every coin merged into the sent coin, so a merge-and-send reads as the whole balance", async () => {
    // MergeCoins(coin0, [coin1..coin9]); TransferObjects([coin0], stranger), ten 100-USDC coins.
    const coins = Array.from({ length: 10 }, (_, i) => coin(i));
    getObjects.mockResolvedValue({ objects: coins.map((id) => ({ objectId: id, type: `0x2::coin::Coin<${USDC}>`, json: { id, balance: "100000000" } })) });
    const drain: FormattedCommand[] = [
      { type: "MergeCoins", destination: input(coins[0]), sources: coins.slice(1).map(input) },
      { type: "TransferObjects", objects: [input(coins[0])], address: to(STRANGER) },
    ];
    const c = await readPresignContext(SENDER, presignSends(drain, SENDER), []);
    expect(c.coins).toEqual([{ coin_type: USDC, sent: "1000000000", sender_balance: "1000000000", share_of_balance: 1 }]);
  });

  it("counts coins merged into the gas coin before it is sent, and leaves a coin merged from a result unresolved", async () => {
    const drain: FormattedCommand[] = [
      { type: "MergeCoins", destination: { type: "GasCoin" }, sources: [input(USDC_COIN)] },
      { type: "TransferObjects", objects: [{ type: "GasCoin" }], address: to(STRANGER) },
    ];
    getObjects.mockResolvedValue({
      objects: [
        { objectId: USDC_COIN, type: `0x2::coin::Coin<${SUI}>`, json: { id: USDC_COIN, balance: "400000000" } },
        { objectId: GAS, type: `0x2::coin::Coin<${SUI}>`, json: { id: GAS, balance: "600000000" } },
      ],
    });
    getBalance.mockResolvedValue({ balance: { coinType: SUI, balance: "1000000000" } });
    const c = await readPresignContext(SENDER, presignSends(drain, SENDER), [GAS]);
    expect(c.coins).toEqual([{ coin_type: SUI, sent: "1000000000", sender_balance: "1000000000", share_of_balance: 1 }]);
    const fromResult: FormattedCommand[] = [
      { type: "SplitCoins", coin: { type: "GasCoin" }, amounts: [{ type: "Input", index: 0, value_type: "u64", value: "5" }] },
      { type: "MergeCoins", destination: input(USDC_COIN), sources: [{ type: "Result", index: 0 }] },
      { type: "TransferObjects", objects: [input(USDC_COIN)], address: to(STRANGER) },
    ];
    expect(presignSends(fromResult, SENDER)).toEqual([{ command: 2, recipient: STRANGER, source: null, amount: null, merged: [] }]);
  });

  it("does not value the whole gas coin at zero when a gas coin could not be read", async () => {
    getObjects.mockResolvedValue({ objects: [new Error("not found")] });
    getBalance.mockResolvedValue({ balance: { coinType: SUI, balance: "5000000000" } });
    const sendAll: FormattedCommand[] = [{ type: "TransferObjects", objects: [{ type: "GasCoin" }], address: to(STRANGER) }];
    const c = await readPresignContext(SENDER, presignSends(sendAll, SENDER), [GAS]);
    expect(c.coins).toEqual([]);
    expect(c.unresolved_sends).toBe(1);
    expect(c.unread.join(" ")).toContain(GAS);
  });
});
