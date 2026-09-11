/**
 * Whether a committee's signing keys exist anywhere outside the committee.
 *
 * The security question this answers is **key exposure**, and it is not the one
 * I expected to be asking. A key that only ever signs for its multisig has one
 * attack surface: whatever device holds it. A key that is also somebody's
 * everyday wallet has signed arbitrary transactions for arbitrary packages,
 * lives in a browser extension, and has been exposed to every dApp its owner
 * ever connected to. Same threshold, very different risk — and nothing in a
 * `4-of-7` label distinguishes them.
 *
 * Measured over four mainnet governance multisigs: 13 of 19 members had no
 * on-chain footprint at all — never sent a transaction, never appeared in one.
 * One 3-of-6 had zero members with any history.
 *
 * That inverts the reading. Cold keys are not missing data; they are what
 * deliberate key hygiene looks like. The case worth investigating is the
 * reverse — a "committee" whose members are all active existing wallets is
 * more plausibly one operator's alts than several parties.
 *
 * It also bounds what else can be asked. Funding analysis, clustering and
 * activity timing all need an address to have done something, so for a
 * cold-key committee they are not weak signals, they are unavailable. Saying
 * "no two members share a funder" about six addresses with no transactions
 * would be a finding manufactured from an absence.
 */

export interface MemberFootprint {
  address: string;
  /** Has sent a transaction of its own, so it has published a public key. */
  has_sent: boolean;
  /** Appears in any transaction at all, sent or received. */
  has_activity: boolean;
}

export type CommitteeShape = "all_cold" | "all_active" | "mixed" | "unknown";

export interface FootprintSummary {
  members_checked: number;
  cold_members: number;
  active_members: number;
  shape: CommitteeShape;
  /**
   * Whether funding, clustering or timing analysis can say anything about this
   * committee. False when too few members have any history to compare.
   */
  independence_analysable: boolean;
  note: string;
}

/**
 * Summarise a committee's footprints.
 *
 * `independence_analysable` requires at least two members with history, because
 * every relational signal this server has — shared funder, shared sponsor,
 * co-appearance — compares one address against another. One active member has
 * nothing to be compared with.
 */
export function summarizeFootprints(footprints: MemberFootprint[]): FootprintSummary {
  const checked = footprints.length;
  const active = footprints.filter((f) => f.has_activity).length;
  const cold = checked - active;

  const shape: CommitteeShape =
    checked === 0 ? "unknown" : active === 0 ? "all_cold" : cold === 0 ? "all_active" : "mixed";

  const analysable = active >= 2;

  let note: string;
  switch (shape) {
    case "all_cold":
      note =
        `None of the ${checked} committee keys has any on-chain history outside this wallet. That is what deliberate key hygiene looks like — keys generated for this purpose and used for nothing else, so each one's exposure is limited to the device holding it. It also means funding, clustering and timing analysis have nothing to work with here: there is no activity to compare, so nothing follows about whether the holders are independent.`;
      break;
    case "all_active":
      note =
        `All ${checked} committee keys are also ordinary active wallets. Each has signed transactions for other packages and been exposed wherever its owner used it, so a compromise of any holder's everyday wallet is a compromise of a committee key. It is also the shape a single operator's alt-wallets would produce, which is worth ruling out before treating this as ${checked} independent parties.`;
      break;
    case "mixed":
      note =
        `${cold} of ${checked} committee keys have no history outside this wallet; ${active} ${active === 1 ? "is" : "are"} also ${active === 1 ? "an active wallet" : "active wallets"}. The active ones carry the broader exposure and are the ones worth identifying — a key that is somebody's daily wallet has a much larger attack surface than one that only ever signs here.`;
      break;
    default:
      note =
        "No committee member addresses could be derived, so nothing can be said about their exposure.";
  }

  if (!analysable && shape !== "unknown") {
    note += ` Independence cannot be assessed: that needs at least two members with on-chain activity to compare, and ${active === 0 ? "none have any" : "only one does"}.`;
  }

  return {
    members_checked: checked,
    cold_members: cold,
    active_members: active,
    shape,
    independence_analysable: analysable,
    note,
  };
}
