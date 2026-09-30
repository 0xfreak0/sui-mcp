import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentSuiAccount } from "../src/utils/chain-id.js";
import { measureFanout } from "../src/utils/fanout.js";
import { getCachedFanout, resetStore } from "../src/utils/store.js";
import { gqlPage, pagedTxConnection } from "./helpers/service-shapes.js";

const { gqlQuery } = vi.hoisted(() => ({ gqlQuery: vi.fn() }));
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery }));

const SUBJECT = `0x${"aa".repeat(32)}`;
const SUI = "0x2::sui::SUI";
const TOKEN = "0xcafe::coin::COIN";
const party = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const change = (address: string, amount: string, coin = TOKEN) => ({
  owner: { address }, amount, coinType: { repr: coin },
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sui-fanout-pages-"));
  vi.stubEnv("SUI_STORE_PATH", join(dir, "store.db"));
  resetStore();
  gqlQuery.mockReset();
});
afterEach(() => {
  resetStore();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("fan-out balance-change completion", () => {
  it("refuses an incomplete measurement without caching it, then measures and caches a complete retry", async () => {
    // The subject sponsors 21 wallets and pays them among 99 recipients. Its
    // debit sorts onto page two: page one alone looks narrow and like a relayer.
    const payout = pagedTxConnection("payout", [
      ...Array.from({ length: 99 }, (_, i) => change(party(i + 1), "100")),
      change(SUBJECT, "-9900"),
    ], "balanceChanges");
    const history = {
      transactions: {
        nodes: [
          ...Array.from({ length: 21 }, (_, i) => ({
            digest: `sponsor-${i}`,
            sender: { address: party(i + 1) },
            gasInput: { gasSponsor: { address: SUBJECT } },
            effects: { balanceChanges: gqlPage([]) },
          })),
          {
            digest: "inflow",
            sender: { address: party(100) },
            effects: { balanceChanges: gqlPage([change(SUBJECT, "100", SUI), change(party(100), "-100", SUI)]) },
          },
          { digest: "payout", sender: { address: SUBJECT }, effects: { balanceChanges: payout.first } },
        ],
        pageInfo: { hasPreviousPage: false, startCursor: "history" },
      },
    };
    let continuationAvailable = false;
    gqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown>) => {
      if (vars.digest === "payout" && !continuationAvailable) throw new Error("continuation unavailable");
      return payout.respond(query, vars) ?? history;
    });

    const failure = await measureFanout(SUBJECT, 50).then(() => null, (error: unknown) => error);
    expect.soft(failure).toBeInstanceOf(Error);
    if (failure instanceof Error) expect(failure.message).toMatch(/incomplete.*balance|balance.*incomplete/i);
    expect.soft(getCachedFanout(currentSuiAccount(SUBJECT))).toBeNull();

    continuationAvailable = true;
    const complete = await measureFanout(SUBJECT, 50);
    expect(complete).toMatchObject({
      recipient_count: 99,
      sender_count: 1,
      counterparty_count: 100,
      classification: "distributor",
      out_in_ratio: 99,
      flow_shape: "disperser",
      sponsored_address_count: 21,
      sponsored_and_paid_count: 21,
      sponsor_shape: "operator",
      truncated: false,
    });
    gqlQuery.mockRejectedValue(new Error("network unavailable after successful measurement"));
    const cached = await measureFanout(SUBJECT, 50);
    expect(cached).toMatchObject({ ...complete, cached: true });
  });
});
