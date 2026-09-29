import { readFileSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const gqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery }));

const { addSessionLabel, allLabels, describeLabel, getLabel, inferredLabelNote, isSink, labelProvenance, loadInferredLabels, removeSessionLabel } =
  await import("../src/utils/labels.js");
const { classifyDepositAddress } = await import("../src/utils/deposit.js");
const { runWithNetwork } = await import("../src/config.js");
const { registerLabelTools } = await import("../src/tools/labels.js");

const tools = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>>();
registerLabelTools({ tool: (name: string, _d: string, _s: unknown, h: never) => tools.set(name, h) } as never);
const manageLabels = async (args: Record<string, unknown>) =>
  JSON.parse((await runWithNetwork("mainnet", () => tools.get("manage_labels")!(args))).content[0]!.text);

const shipped = JSON.parse(readFileSync(new URL("../src/data/deposit-labels.json", import.meta.url), "utf8"));
const disclosed = JSON.parse(readFileSync(new URL("../src/data/disclosed-labels.json", import.meta.url), "utf8"));
// A disclosed exchange wallet: public, named by the exchange itself.
const DISCLOSED_KEY = Object.keys(disclosed.labels).find((k) => k.startsWith("sui:mainnet:") && disclosed.labels[k].category === "cex")!;
const DISCLOSED = DISCLOSED_KEY.slice("sui:mainnet:".length);
const ZERO = "0x" + "0".repeat(64);

// Synthetic addresses only.
const DEPOSIT = "0x" + "d1".repeat(32);
const NO_EVIDENCE = "0x" + "d2".repeat(32);
const PAYER = "0x" + "c1".repeat(32);
const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

const inferredFrom = {
  swept_to: DISCLOSED,
  sweep_count: 4,
  evidence_txs: ["sweep1", "sweep2", "sweep3"],
  first_sweep_at: "2026-09-01T00:00:00.000Z",
  last_sweep_at: "2026-09-02T00:00:00.000Z",
};
const entry = (label: string) => ({
  label,
  category: "cex",
  entity: "ExchangeA",
  evidence: "sweep-pattern",
  confidence: "medium",
  retrieved_at: "2026-09-28",
  inferred_from: inferredFrom,
});

loadInferredLabels({
  labels: {
    [`sui:mainnet:${DEPOSIT}`]: entry("ExchangeA deposit address (inferred)"),
    [DISCLOSED_KEY]: entry("collides with a disclosed wallet"),
    [`sui:mainnet:${ZERO}`]: entry("collides with a curated label"),
    // A label in this tier without its evidence is not loaded.
    [`sui:mainnet:${NO_EVIDENCE}`]: { label: "no evidence", category: "cex", entity: "ExchangeA" },
  },
});

afterEach(() => removeSessionLabel(DEPOSIT));
afterAll(() => loadInferredLabels(shipped));

describe("inferred deposit labels", () => {
  it("read as inferred, with their evidence, and stop a trace like an exchange", () => {
    const label = getLabel(DEPOSIT)!;
    expect(label).toMatchObject({ source: "inferred", category: "cex", confidence: "medium", evidence: "sweep-pattern" });
    expect(labelProvenance(label)?.inferred_from?.evidence_txs).toEqual(["sweep1", "sweep2", "sweep3"]);
    expect(inferredLabelNote(label)).toContain("sweep3");
    expect(isSink(DEPOSIT)).toBe(true);
  });

  it("never override a disclosed or curated label", () => {
    const hot = getLabel(DISCLOSED)!;
    expect(hot.source).toBe("disclosed");
    expect(hot.inferred_from).toBeUndefined();
    expect(inferredLabelNote(hot)).toBeUndefined();
    expect(getLabel(ZERO)).toMatchObject({ source: "curated", category: "burn" });
    const listed = runWithNetwork("mainnet", () => allLabels());
    expect(listed.find((l) => l.account === DISCLOSED_KEY)?.source).toBe("disclosed");
    expect(listed.find((l) => l.address === ZERO)?.source).toBe("curated");
    // Listed after every other tier, so a capped list keeps the rest.
    expect(listed.at(-1)?.source).toBe("inferred");
  });

  it("lose to a label added in the session", () => {
    addSessionLabel(DEPOSIT, { label: "Investigator's own", category: "other" }, false);
    expect(getLabel(DEPOSIT)).toMatchObject({ source: "session", label: "Investigator's own" });
    removeSessionLabel(DEPOSIT);
    expect(getLabel(DEPOSIT)?.source).toBe("inferred");
  });

  it("are not loaded without the sweeps they rest on", () => {
    expect(getLabel(NO_EVIDENCE)).toBeNull();
  });

  it("apply on mainnet only", () => {
    expect(runWithNetwork("testnet", () => getLabel(DEPOSIT))).toBeNull();
  });

  it("say they are inferred in a one-line rendering", () => {
    expect(describeLabel(getLabel(DEPOSIT)!)).toBe("ExchangeA deposit address (inferred) [cex; ExchangeA; sweep-pattern]");
  });

  it("are not exported, so an import cannot turn one into a top-tier session label", async () => {
    const exported = await manageLabels({ action: "export" });
    const accounts = exported.labels.map((l: { address: string }) => l.address);
    expect(accounts).not.toContain(`sui:mainnet:${DEPOSIT}`);
    expect(accounts).toContain(DISCLOSED_KEY);
    expect(exported.inferred_not_exported).toBeGreaterThan(0);
  });
});

describe("classify_deposit_address and an inferred destination", () => {
  it("does not count an inferred deposit label as an exchange destination", async () => {
    // PAYER empties itself into DEPOSIT twice. With the inferred label counted
    // as an exchange, PAYER would read as a deposit address itself.
    const sweep = (digest: string, at: string) => ({
      digest,
      sender: { address: PAYER },
      gasInput: { gasSponsor: { address: PAYER } },
      effects: {
        timestamp: at,
        balanceChanges: {
          nodes: [
            { amount: "-100", owner: { address: PAYER }, coinType: { repr: SUI } },
            { amount: "100", owner: { address: DEPOSIT }, coinType: { repr: SUI } },
          ],
        },
      },
    });
    const fund = (digest: string, at: string) => ({
      digest,
      sender: { address: DISCLOSED },
      gasInput: { gasSponsor: { address: DISCLOSED } },
      effects: {
        timestamp: at,
        balanceChanges: {
          nodes: [
            { amount: "-100", owner: { address: DISCLOSED }, coinType: { repr: SUI } },
            { amount: "100", owner: { address: PAYER }, coinType: { repr: SUI } },
          ],
        },
      },
    });
    gqlQuery.mockResolvedValue({
      address: { balances: { nodes: [{ coinType: { repr: SUI }, totalBalance: "0" }], pageInfo: { hasNextPage: false } } },
      transactions: {
        nodes: [
          fund("f1", "2026-09-01T00:00:00Z"),
          sweep("s1", "2026-09-01T00:01:00Z"),
          fund("f2", "2026-09-01T00:02:00Z"),
          sweep("s2", "2026-09-01T00:03:00Z"),
        ],
        pageInfo: { hasPreviousPage: false },
      },
    });
    const result = await runWithNetwork("mainnet", () =>
      classifyDepositAddress(PAYER, { measureSponsor: false, measureDestination: false }),
    );
    expect(result.hot_wallet).toBe(DEPOSIT);
    expect(result.checks.destination_is_exchange).not.toBe(true);
    expect(result.verdict).not.toBe("likely");
    expect(result.exchange?.inferred_from).toBeDefined();
  });
});
