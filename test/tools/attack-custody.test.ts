import { describe, it, expect, vi, beforeEach } from "vitest";
import { bcs } from "@mysten/sui/bcs";
import type { AttackCall, AttackTx } from "../../src/utils/attack-analysis.js";
import { createMockClient } from "../helpers/mock-grpc.js";
import { runWithNetwork } from "../../src/config.js";

/**
 * analyze_attack_tx reads the publisher tier only for packages the call
 * itself resolved, says when its lookup bound left called packages
 * unchecked, and runs decode_ptb's PTB checks on the transaction with its
 * sender and effects.
 */

// vi.mock is hoisted above the imports, so every module sees these stubs.
const { mockRead, gqlQuery } = vi.hoisted(() => ({ mockRead: vi.fn(), gqlQuery: vi.fn() }));
vi.mock("../../src/utils/attack-read.js", () => ({ readAttackTransactions: mockRead, digestsSentBy: vi.fn() }));
vi.mock("../../src/clients/graphql.js", () => ({ gqlQuery }));
vi.mock("../../src/utils/mvr-client.js", () => ({ reverseResolveBulk: vi.fn(async () => new Map()) }));
vi.mock("../../src/utils/valuation.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  priceUsdAtTime: vi.fn(async () => ({ points: new Map(), unpriced: [] })),
  prefetchCoinScale: vi.fn(async () => {}),
}));
// Signatures are read over gRPC to decode pure arguments; none is readable here.
const mockSui = createMockClient();
mockSui.getMoveFunction.mockRejectedValue(new Error("offline"));
vi.mock("../../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));

// Imported after the gRPC mock is built: the mock client comes from a helper
// module, which a hoisted mock factory cannot import.
const { registerAttackTools } = await import("../../src/tools/attack.js");
const { prefetchProtocolCustody } = await import("../../src/protocols/registry.js");
const { clearPackageCustodyCache, MAX_CUSTODY_LOOKUPS } = await import("../../src/protocols/package-custody.js");

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
const handlers: Record<string, Handler> = {};
registerAttackTools({ tool: (name: string, _d: string, _s: unknown, h: Handler) => void (handlers[name] = h) } as never);
const payloadOf = (r: { content: { text: string }[] }) => JSON.parse(r.content[r.content.length - 1].text);

/** Published Scallop's core package. */
const SCALLOP_PUBLISHER = "0xf70555871289e7a52a88754071f3e76afcb6b4e5b4b34177e845ad6fcc57edd5";
const SENDER = "0x27bc7a3c4f406cfa91551c32490ad7f5029414578c0649ab4ddbd232e76ef44e";
const STRANGER = `0x${"5a".repeat(32)}`;
const DIGEST = "6WNDjCX3W852hipq6yrHhpUaSFHSPWfTxuLKaQkgNfVL";
const pkg = (n: number) => `0x${n.toString(16).padStart(64, "0")}`.replace(/^0x0/, "0xa");

beforeEach(() => {
  vi.clearAllMocks();
  clearPackageCustodyCache();
  // Every package is its own lineage root, version 1, published by Scallop's key.
  gqlQuery.mockImplementation(async (_q: string, vars: Record<string, string>) =>
    Object.fromEntries(
      Object.keys(vars).map((k) => [
        `p${k.slice(1)}`,
        { nodes: [{ address: vars[k], version: 1, previousTransaction: { sender: { address: SCALLOP_PUBLISHER }, effects: { checkpoint: { sequenceNumber: 1 } } } }] },
      ]),
    ),
  );
});

const call = (command: number, p: string): AttackCall => ({ command, package: p, module: "user", function: "go", typeArguments: [], objectArgs: [], pureArgs: [], args: [] });

/** The signed transaction: the calls, then a payout of a split gas coin to `payTo` when given. */
function ptbBytes(calls: AttackCall[], payTo?: string): Uint8Array {
  const commands: unknown[] = calls.map((c) => ({ MoveCall: { package: c.package, module: c.module, function: c.function, typeArguments: [], arguments: [] } }));
  const inputs: unknown[] = [];
  if (payTo) {
    inputs.push({ Pure: { bytes: bcs.u64().serialize(5).toBytes() } }, { Pure: { bytes: bcs.Address.serialize(payTo).toBytes() } });
    commands.push({ SplitCoins: { coin: { GasCoin: true }, amounts: [{ Input: 0 }] } });
    commands.push({ TransferObjects: { objects: [{ NestedResult: [calls.length, 0] }], address: { Input: 1 } } });
  }
  return bcs.TransactionData.serialize({
    V1: {
      kind: { ProgrammableTransaction: { inputs, commands } },
      sender: SENDER,
      gasData: { payment: [], owner: SENDER, price: "1000", budget: "1000000" },
      expiration: { None: true },
    },
  } as never).toBytes();
}

const tx = (calls: AttackCall[], events: AttackTx["events"] = [], payTo?: string): AttackTx => ({
  digest: DIGEST,
  sender: SENDER,
  success: true,
  timestampMs: 0,
  checkpoint: "1",
  commandKinds: [...calls.map(() => "MoveCall"), ...(payTo ? ["SplitCoins", "TransferObjects"] : [])],
  bcs: ptbBytes(calls, payTo),
  movements: [],
  gas: null,
  calls,
  events,
  balanceChanges: [],
  objects: [],
});
const analyze = async (t: AttackTx) => {
  mockRead.mockResolvedValue({ txs: [t], missing: [], served_by_archive: 0, events_undecoded: [] });
  const r = await runWithNetwork("mainnet", () => handlers.analyze_attack_tx({ digest: DIGEST }));
  return { payload: payloadOf(r), text: r.content[0].text };
};

describe("analyze_attack_tx publisher attribution", () => {
  it("does not name an event's package from a publisher match another call cached", async () => {
    const EVENT_PKG = pkg(1);
    await runWithNetwork("mainnet", () => prefetchProtocolCustody([EVENT_PKG]));
    const { payload } = await analyze(
      tx([call(0, pkg(2))], [
        {
          index: 0,
          type: `${EVENT_PKG}::lp_pool::SwapEvent`,
          json: { pool: pkg(3), from_token_type: "0x2::sui::SUI", from_amount: "1", to_token_type: "0x2::sui::SUI", actual_to_amount: "1" },
        },
      ]),
    );
    expect(payload.swaps[0].protocol).toBeNull();
  });

  it("says which called packages went unchecked past the lookup bound, and leaves them unrecognized", async () => {
    const calls = Array.from({ length: MAX_CUSTODY_LOOKUPS + 1 }, (_, i) => call(i, pkg(10 + i)));
    const { payload } = await analyze(tx(calls));
    expect(payload.protocol_attribution_incomplete.past_bound).toEqual([pkg(10 + MAX_CUSTODY_LOOKUPS)]);
    const unverified = payload.anomalies.find((a: { code: string }) => a.code === "unverified-package-call");
    expect(unverified.evidence).toEqual([`${pkg(10 + MAX_CUSTODY_LOOKUPS)}::user::go`]);
  });
});

describe("analyze_attack_tx on a failed origin read", () => {
  it("names the called packages whose origin read failed, and leaves them unrecognized", async () => {
    gqlQuery.mockRejectedValue(new Error("503"));
    const { payload } = await analyze(tx([call(0, pkg(2))]));
    expect(payload.protocol_attribution_incomplete.read_failed).toEqual([pkg(2)]);
    expect(payload.anomalies.map((a: { code: string }) => a.code)).toContain("unverified-package-call");
  });
});

describe("analyze_attack_tx PTB checks", () => {
  it("flags a payout to an address other than the sender, as decode_ptb does", async () => {
    const { payload } = await analyze(tx([call(0, pkg(2))], [], STRANGER));
    const payout = payload.anomalies.find((a: { code: string }) => a.code === "transfers-to-non-sender");
    expect(payout.severity).toBe("high");
    expect(payout.evidence.join(" ")).toContain(STRANGER);
  });

  it("names every check that ran, in the JSON and the text, when nothing matched", async () => {
    const { payload, text } = await analyze(tx([call(0, pkg(2))]));
    expect(payload.anomalies.filter((a: { severity: string }) => a.severity !== "info")).toEqual([]);
    const codes = payload.checks_run.map((c: { code: string }) => c.code);
    expect(codes).toEqual(expect.arrayContaining(["outsized-mint", "transfers-to-non-sender", "unverified-package-call", "stale-package-version"]));
    for (const code of codes) expect(text).toContain(code);
  });

  it("prints PTB anomalies in the text, not only trade anomalies", async () => {
    const { payload, text } = await analyze(tx([call(0, pkg(2))], [], STRANGER));
    for (const a of payload.anomalies) expect(text).toContain(a.title);
  });
});
