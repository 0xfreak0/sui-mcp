import { chainDisplayName, parseAccountId, SUI_MAINNET, type ChainId } from "./chain-id.js";
import type { EvidenceTier, Finding } from "./store.js";

/**
 * Render a case's findings as Markdown.
 *
 * An investigation currently ends as a chat transcript: the conclusions are
 * real but they live somewhere nobody will read again, and re-deriving them
 * costs as much as the original work. This turns the same findings into a
 * document you can paste into a ticket, a post-mortem or a writeup.
 *
 * Pure — the caller supplies the findings — so the formatting is testable
 * without a database.
 */

/**
 * Split a stored reference into the chain it names and its bare address.
 *
 * Findings written before chain qualification hold a bare address; those are
 * reported as Sui mainnet, matching the store's own backfill. Anything
 * unparseable is passed through with no chain rather than dropped — a report
 * must render whatever was recorded.
 */
export function splitReference(reference: string): { chain: ChainId | null; address: string } {
  if (!reference.includes(":")) return { chain: SUI_MAINNET, address: reference };
  try {
    const parsed = parseAccountId(reference, SUI_MAINNET);
    return { chain: parsed.chain, address: parsed.address };
  } catch {
    return { chain: null, address: reference };
  }
}

/** Short form for readability; full addresses stay in the appendix. */
function shortAddress(a: string): string {
  return a.length > 20 ? `${a.slice(0, 10)}…${a.slice(-6)}` : a;
}

/**
 * Render one address for the body of a report.
 *
 * The chain is named alongside the address rather than left implicit. In a
 * cross-chain case the same-looking hex string can appear on two chains, and a
 * report that shows only `0x5aae…` invites a reader to assume they are the
 * same account — the exact confusion chain qualification exists to prevent.
 */
function renderAddress(reference: string): string {
  const { chain, address } = splitReference(reference);
  const short = `\`${shortAddress(address)}\``;
  return chain ? `${short} — ${chainDisplayName(chain)}` : short;
}

const CONFIDENCE_ORDER = ["high", "medium", "low"] as const;

function confidenceRank(c: string | null): number {
  const i = CONFIDENCE_ORDER.indexOf((c ?? "").toLowerCase() as (typeof CONFIDENCE_ORDER)[number]);
  return i === -1 ? CONFIDENCE_ORDER.length : i;
}

/**
 * Report sections, strongest evidence first. A reader who cannot tell a
 * chain-derived statement from a heuristic one treats them alike, which is how
 * a lead becomes an accusation, so the tier is a section and not a footnote.
 */
const TIER_SECTIONS: Array<{ tier: EvidenceTier | null; heading: string; means: string }> = [
  { tier: "chain-derived", heading: "Chain-derived", means: "Read from Sui itself." },
  { tier: "indexer-attested", heading: "Indexer-attested", means: "A third party asserts it: a lead to confirm, not a finding." },
  { tier: "heuristic", heading: "Heuristic", means: "An inference from patterns. It may be so; it is not established." },
  { tier: null, heading: "Tier not recorded", means: "Saved before findings carried an evidence tier." },
];

export interface CaseReportOptions {
  caseName: string;
  findings: Finding[];
  /** Rendered into the header so a report is reproducible. */
  generatedAt?: number;
  /** Include the full-address appendix (default true). */
  includeAppendix?: boolean;
}

export function renderCaseReport(opts: CaseReportOptions): string {
  const { caseName, findings } = opts;
  const lines: string[] = [];

  lines.push(`# ${caseName}`);
  lines.push("");

  if (findings.length === 0) {
    lines.push("_No findings recorded for this case yet._");
    return lines.join("\n") + "\n";
  }

  const stamp = opts.generatedAt ?? Date.now();
  const first = Math.min(...findings.map((f) => f.created_at ?? stamp));
  const last = Math.max(...findings.map((f) => f.created_at ?? stamp));

  // Every address mentioned anywhere, so the reader can see the scope up front.
  const allAddresses = [...new Set(findings.flatMap((f) => f.addresses))];

  lines.push(
    `${findings.length} finding${findings.length === 1 ? "" : "s"} · ` +
      `${allAddresses.length} address${allAddresses.length === 1 ? "" : "es"} · ` +
      `recorded ${new Date(first).toISOString().slice(0, 16).replace("T", " ")} – ` +
      `${new Date(last).toISOString().slice(0, 16).replace("T", " ")} UTC`,
  );
  lines.push("");

  for (const section of TIER_SECTIONS) {
    // Highest confidence first within a tier: a reader skimming should hit
    // the solid claims before the speculative ones, not encounter them in the
    // order they occurred.
    const inTier = findings
      .filter((f) => f.evidence_tier === section.tier)
      .sort(
        (a, b) =>
          confidenceRank(a.confidence) - confidenceRank(b.confidence) ||
          (a.created_at ?? 0) - (b.created_at ?? 0),
      );
    if (inTier.length === 0) continue;

    lines.push(`## ${section.heading}`);
    lines.push("");
    lines.push(`_${section.means}_`);
    lines.push("");

    for (const f of inTier) {
      lines.push(`### ${f.title}`);
      lines.push("");
      lines.push(
        [
          `**Evidence tier:** ${f.evidence_tier ?? "not recorded"}`,
          ...(f.confidence ? [`**Confidence:** ${f.confidence}`] : []),
        ].join(" · "),
      );
      lines.push("");
      if (f.detail) {
        lines.push(f.detail);
        lines.push("");
      }
      if (f.addresses.length) {
        lines.push("**Addresses**");
        lines.push("");
        for (const a of f.addresses) lines.push(`- ${renderAddress(a)}`);
        lines.push("");
      }
      if (f.digests.length) {
        lines.push("**Transactions**");
        lines.push("");
        for (const d of f.digests) lines.push(`- \`${d}\``);
        lines.push("");
      }
      if (f.evidence.length) {
        // Evidence is what makes a finding checkable rather than asserted —
        // it is the difference between a report and an opinion.
        lines.push("**Evidence**");
        lines.push("");
        for (const e of f.evidence) lines.push(`- ${e}`);
        lines.push("");
      }
    }
  }

  if (opts.includeAppendix !== false && allAddresses.length) {
    lines.push("## Appendix: full addresses");
    lines.push("");
    // Grouped by chain so a reader can see at a glance which chains the case
    // spans, and so two addresses that differ only by chain never sit
    // adjacent and unlabeled.
    const byChain = new Map<string, string[]>();
    for (const a of allAddresses) {
      const { chain, address } = splitReference(a);
      const heading = chain ? chainDisplayName(chain) : "Unrecognised chain";
      const bucket = byChain.get(heading);
      if (bucket) bucket.push(address);
      else byChain.set(heading, [address]);
    }
    for (const [heading, addresses] of byChain) {
      lines.push(`### ${heading}`);
      lines.push("");
      for (const a of addresses) lines.push(`- \`${a}\``);
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("");
  lines.push(
    `_Generated by [sui-analytics-mcp](https://github.com/0xfreak0/sui-mcp) at ` +
      `${new Date(stamp).toISOString()}._`,
  );

  return lines.join("\n") + "\n";
}
