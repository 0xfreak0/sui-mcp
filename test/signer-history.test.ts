import { describe, it, expect } from "vitest";
import { summarizeSigners, signerHistoryNote, type SignerObservation } from "../src/utils/signer-history.js";
import type { MultisigCommittee } from "../src/utils/multisig.js";

const committee = (n: number, threshold: number): MultisigCommittee => ({
  threshold,
  members: Array.from({ length: n }, (_, i) => ({
    index: i,
    scheme: "ed25519" as const,
    weight: 1,
    address: `0xm${i}`,
    signed_source_tx: false,
  })),
  total_weight: n,
  signed_weight: 0,
  bitmap: 0,
});

const obs = (signers: number[], timestamp?: string, digest = `0xd${signers.join("")}`): SignerObservation => ({
  digest,
  signers,
  timestamp,
});

/**
 * Shaped after the real mainnet 4-of-7: three signer sets across eight
 * transactions, members 3 and 4 in every one, members 5 and 6 in none.
 */
const realWorld4of7: SignerObservation[] = [
  ...Array.from({ length: 4 }, (_, i) => obs([0, 1, 3, 4], `2025-07-2${i}`, `0xa${i}`)),
  ...Array.from({ length: 2 }, (_, i) => obs([1, 2, 3, 4], `2025-07-3${i}`, `0xb${i}`)),
  ...Array.from({ length: 2 }, (_, i) => obs([0, 2, 3, 4], `2025-09-1${i}`, `0xc${i}`)),
];

describe("summarizeSigners", () => {
  it("finds the keys that have never signed", () => {
    const h = summarizeSigners(committee(7, 4), realWorld4of7);
    expect(h.dormant_members).toEqual([5, 6]);
    expect(h.members[5].never_signed).toBe(true);
    expect(h.members[0].never_signed).toBe(false);
  });

  it("finds the keys present in every transaction", () => {
    const h = summarizeSigners(committee(7, 4), realWorld4of7);
    expect(h.always_present).toEqual([3, 4]);
  });

  it("counts distinct signer sets, most frequent first", () => {
    const h = summarizeSigners(committee(7, 4), realWorld4of7);
    expect(h.signer_sets).toHaveLength(3);
    expect(h.signer_sets[0]).toMatchObject({ members: [0, 1, 3, 4], count: 4 });
  });

  it("reports each member's share of the examined transactions", () => {
    const h = summarizeSigners(committee(7, 4), realWorld4of7);
    expect(h.transactions_examined).toBe(8);
    expect(h.members[3].signed_share).toBe(1);
    expect(h.members[0].signed_share).toBe(0.75);
    expect(h.members[5].signed_share).toBe(0);
  });

  /**
   * GraphQL returns newest-first, so a naive "last write wins" would report
   * the newest timestamp as the first signature.
   */
  it("orders first and last signature by time, not by arrival", () => {
    const h = summarizeSigners(committee(2, 1), [
      obs([0], "2026-05-01"),
      obs([0], "2025-01-01"),
      obs([0], "2025-09-01"),
    ]);
    expect(h.members[0].first_signed).toBe("2025-01-01");
    expect(h.members[0].last_signed).toBe("2026-05-01");
  });

  it("says whether the active keys alone can meet the threshold", () => {
    // 3 and 4 alone are weight 2, short of a threshold of 4 — but 0,1,2,3,4 all
    // sign at some point, which is weight 5.
    expect(summarizeSigners(committee(7, 4), realWorld4of7).active_signers_meet_threshold).toBe(true);
    // Only one key active against a threshold of 2.
    expect(
      summarizeSigners(committee(3, 2), [obs([0]), obs([0])]).active_signers_meet_threshold,
    ).toBe(false);
  });

  /**
   * With nothing examined, "every member signed every transaction" is
   * vacuously true and would print as a finding.
   */
  it("claims nothing from an empty history", () => {
    const h = summarizeSigners(committee(3, 2), []);
    expect(h.transactions_examined).toBe(0);
    expect(h.always_present).toEqual([]);
    expect(h.active_signers_meet_threshold).toBe(false);
    expect(h.dormant_members).toEqual([0, 1, 2]);
  });

  it("ignores a signer index outside the committee", () => {
    const h = summarizeSigners(committee(2, 1), [obs([0, 9])]);
    expect(h.members).toHaveLength(2);
    expect(h.members[0].signed_count).toBe(1);
  });
});

describe("signerHistoryNote", () => {
  it("refuses to read a pattern from a single transaction", () => {
    const h = summarizeSigners(committee(7, 4), [obs([0, 1, 3, 4])]);
    expect(signerHistoryNote(h, 4)).toContain("says nothing");
  });

  it("says nothing at all from an empty history", () => {
    expect(signerHistoryNote(summarizeSigners(committee(3, 2), []), 2)).toContain("nothing follows");
  });

  it("calls out dormant keys with the count they rest on", () => {
    const n = signerHistoryNote(summarizeSigners(committee(7, 4), realWorld4of7), 4)!;
    expect(n).toContain("8 transactions");
    expect(n).toContain("5, 6");
  });

  it("calls out keys the wallet cannot move without", () => {
    expect(signerHistoryNote(summarizeSigners(committee(7, 4), realWorld4of7), 4)!).toContain(
      "cannot currently move without",
    );
  });

  it("flags a single fixed signer combination", () => {
    const h = summarizeSigners(committee(3, 2), [obs([0, 1]), obs([0, 1]), obs([0, 1])]);
    expect(signerHistoryNote(h, 2)!).toContain("fixed operating set");
  });

  it("says nothing when every key signs and the sets vary", () => {
    const h = summarizeSigners(committee(3, 2), [obs([0, 1]), obs([1, 2]), obs([0, 2])]);
    expect(signerHistoryNote(h, 2)).toBeUndefined();
  });
});
