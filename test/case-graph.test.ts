import { describe, it, expect } from "vitest";
import { buildCaseGraph, type CaseTx } from "../src/utils/case-graph.js";
import type { Finding } from "../src/utils/store.js";
import { SUI, USDC } from "./helpers/trace-shapes.js";

const ATTACKER = `0xa1${"1".repeat(62)}`;
const FUNDER = `0xb2${"2".repeat(62)}`;
const RELAYER = `0xc3${"3".repeat(62)}`;
const STRANGER_A = `0xd4${"4".repeat(62)}`;
const STRANGER_B = `0xe5${"5".repeat(62)}`;
const EVM = "0x135477aa627a3bcc3223bde10dd8e7c55a1f645c";

const finding = (f: Partial<Finding>): Finding => ({
  id: 1,
  case_name: "c",
  title: "t",
  detail: null,
  confidence: null,
  evidence_tier: "chain-derived",
  addresses: [],
  evidence: [],
  digests: [],
  ...f,
});

const findings = [
  finding({ id: 1, title: "CCTP exit", addresses: [`sui:mainnet:${ATTACKER}`, `eip155:1:${EVM}`], digests: ["burn"] }),
  finding({ id: 2, title: "Funding", addresses: [`sui:mainnet:${FUNDER}`, `sui:mainnet:${ATTACKER}`], digests: ["fund", "other"] }),
];

const txs: CaseTx[] = [
  {
    digest: "fund",
    sender: FUNDER,
    timestamp: null,
    gas: { payer: FUNDER, net: 1000n },
    changes: [
      { address: FUNDER, amount: "-40000001000", coin_type: SUI },
      { address: ATTACKER, amount: "40000000000", coin_type: SUI },
    ],
  },
  {
    // A CCTP burn of 100,000 USDC that pays its relayer 10 USDC.
    digest: "burn",
    sender: ATTACKER,
    timestamp: null,
    gas: { payer: ATTACKER, net: 0n },
    bridges: ["Circle CCTP"],
    changes: [
      { address: ATTACKER, amount: "-100010000000", coin_type: USDC },
      { address: RELAYER, amount: "10000000", coin_type: USDC },
    ],
  },
  {
    // Two strangers in a cited transaction: not part of the case's flow.
    digest: "other",
    sender: STRANGER_A,
    timestamp: null,
    gas: { payer: STRANGER_A, net: 0n },
    changes: [
      { address: STRANGER_A, amount: "-5", coin_type: SUI },
      { address: STRANGER_B, amount: "5", coin_type: SUI },
    ],
  },
];

describe("buildCaseGraph", () => {
  const g = buildCaseGraph(findings, txs);
  const edge = (from: string, to: string) => g.edges.find((e) => e.from === from && e.to === to);

  it("draws transfers between the case's addresses, with gas removed", () => {
    expect(edge(FUNDER, ATTACKER)?.attrs?.amount).toBe("40000000000");
  });

  it("sends a bridge exit's burned remainder to an exit node, not the relayer's fee twice", () => {
    expect(edge(ATTACKER, "exit:burn")?.attrs?.amount).toBe("100000000000");
    expect(edge(ATTACKER, RELAYER)?.attrs?.amount).toBe("10000000");
  });

  it("links a finding's Sui address to its foreign account as a recorded, dashed link", () => {
    const link = edge(ATTACKER, `eip155:1:${EVM}`);
    expect(link?.dashed).toBe(true);
    expect(g.nodes.find((n) => n.id === `eip155:1:${EVM}`)?.kind).toBe("foreign");
  });

  it("leaves out transfers that touch none of the case's addresses", () => {
    expect(g.nodes.some((n) => n.id === STRANGER_A || n.id === STRANGER_B)).toBe(false);
  });
});
