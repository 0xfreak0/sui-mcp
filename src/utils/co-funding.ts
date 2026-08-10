/**
 * Detect addresses funded by the *same transaction*.
 *
 * Sharing a funder is weak evidence: everyone who withdrew from an exchange
 * shares one. Sharing a single funding transaction is a different claim — one
 * PTB paid several addresses in one signed action, so whoever built it held
 * every recipient in mind at once. There is no innocent way for two unrelated
 * wallets to appear in the same payout.
 *
 * This is why it is reported separately from `shared_funders` rather than as a
 * stronger flavour of it: the two support different conclusions, and collapsing
 * them would let the weaker one borrow the stronger one's confidence.
 *
 * Pure, so the grouping is testable without walking any funding chains.
 */

export interface CoFundingStep {
  address: string;
  funded_by: string;
  funding_tx?: string;
  /** Null when the chain walk could not resolve a time for the hop. */
  timestamp?: string | null;
  amount?: string;
}

export interface CoFundingGroup {
  funding_tx: string;
  funder: string;
  /** Addresses paid by this one transaction, in the order encountered. */
  addresses: string[];
  timestamp: string | null;
  /** Distinct amounts paid. One value means every recipient got the same. */
  amounts: string[];
  /** True when every recipient received an identical amount. */
  uniform_amount: boolean;
}

/**
 * Group funding steps by transaction digest, keeping only digests that paid
 * more than one distinct address.
 *
 * `subjects` restricts the result to transactions touching at least two of the
 * addresses under investigation. Without it a batch that walks several hops
 * would surface co-funding among intermediates the caller never asked about,
 * which is noise at the top level of a report.
 */
export function detectCoFunding(
  steps: CoFundingStep[],
  subjects?: Iterable<string>,
): CoFundingGroup[] {
  const subjectSet = subjects ? new Set(subjects) : null;
  const byTx = new Map<string, { funder: string; seen: Map<string, CoFundingStep> }>();

  for (const s of steps) {
    // "unknown" is the walker's marker for a funder it could not resolve;
    // grouping on it would join unrelated addresses under a non-existent tx.
    if (!s.funding_tx || s.funded_by === "unknown") continue;
    const entry = byTx.get(s.funding_tx) ?? { funder: s.funded_by, seen: new Map() };
    // First write wins: one digest has one set of recipients, and a repeated
    // address in a chain walk is the same payment seen twice.
    if (!entry.seen.has(s.address)) entry.seen.set(s.address, s);
    byTx.set(s.funding_tx, entry);
  }

  const groups: CoFundingGroup[] = [];
  for (const [funding_tx, { funder, seen }] of byTx) {
    if (seen.size < 2) continue;
    const addresses = [...seen.keys()];
    if (subjectSet && addresses.filter((a) => subjectSet.has(a)).length < 2) continue;

    const steps = [...seen.values()];
    const amounts = [...new Set(steps.map((s) => s.amount).filter((a): a is string => !!a))];
    groups.push({
      funding_tx,
      funder,
      addresses,
      timestamp: steps.find((s) => s.timestamp)?.timestamp ?? null,
      amounts,
      // Identical amounts to every recipient is the signature of a scripted
      // payout rather than a person sending what each address happened to need.
      uniform_amount: amounts.length === 1 && steps.length > 1,
    });
  }

  // Widest payout first: a transaction paying six addresses says more than one
  // paying two.
  return groups.sort((a, b) => b.addresses.length - a.addresses.length);
}
