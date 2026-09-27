/**
 * Per-tool output budgets for the case pass, in characters of the tool's text.
 * A call over its tool's budget fails. Tokens are estimated as chars / 4.
 *
 * - A tool not listed has DEFAULT_BUDGET, the size past which Claude Code
 *   writes a result to a file and shows the model a preview.
 * - A capped tool (src/utils/output-cap.ts) has the budget its summary view is
 *   sized to, with room for flagged rows, which survive any cap.
 * - A call with `detail: "full"` is the caller's opt-in to the whole answer
 *   and has FULL_BUDGET, the maxResultSizeChars ceiling. An explicit
 *   `commands` pick narrows events, inputs and object changes with the
 *   commands, and has PICK_BUDGET.
 * - A tool listed under UNCAPPED returns its whole answer by design; its budget
 *   is the largest result the cases measured, so growth still fails.
 */
export const DEFAULT_BUDGET = 50_000;
export const FULL_BUDGET = 500_000;
/** A `commands` pick: a few commands with their events, inputs and objects, more than the default holds on a large PTB. */
export const PICK_BUDGET = 60_000;

export const TOOL_BUDGETS = {
  // Every bridge exit is listed, so an attacker with many exits needs room
  // past the default.
  summarize_address_flows: 75_000,
  find_funding_sources: 50_000,
  list_nfts: 30_000,
  // Every coin in token_flow and balance changes is listed, so a transaction
  // that moves many coins needs room past the default.
  get_transaction: 60_000,
  decode_ptb: 60_000,
  // Each list keeps about 40k in all.
  summarize_incident_losses: 45_000,
  // Each transaction's lists share about 30k, and the batch's own rows come
  // on top.
  get_transactions: 45_000,
  // Rows fill about 35k, and failed and lookalike rows survive past it.
  get_transaction_history: 45_000,
  build_timeline: 45_000,
};

/** Whole answers by design. */
export const UNCAPPED = {
  // max_sample_lines is the caller's own size; the largest sample a case
  // asks for sets the budget.
  diff_package_upgrade: 70_000,
};

/** The budget one call is held to. */
export function budgetFor(tool, args = {}) {
  if (args.detail === "full") return FULL_BUDGET;
  if (Array.isArray(args.commands)) return PICK_BUDGET;
  return TOOL_BUDGETS[tool] ?? UNCAPPED[tool] ?? DEFAULT_BUDGET;
}

/** `61k` for 61,234. */
export function kchars(n) {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

export const tokens = (chars) => Math.round(chars / 4);

/**
 * The closing size report for a case-pass `--summary` file: totals, the
 * tools/list cost, every case's total, every call over its budget, and the
 * calls closest to theirs. Returns printable lines.
 */
export function sizeReport(summary, { nearest = 5 } = {}) {
  const pct = (c) => `${Math.round((100 * c.chars) / c.budget)}%`;
  const call = (c) => `${c.case}/${c.check} ${c.tool} ${kchars(c.chars)} of ${kchars(c.budget)} (${pct(c)}) ≈ ${kchars(c.tokens)} tokens`;
  const lines = [
    `${summary.cases} case(s), ${summary.checks} call(s), ${kchars(summary.chars)} chars ≈ ${kchars(summary.tokens)} tokens`,
  ];
  const lists = Object.entries(summary.tools_list ?? {}).map(([k, t]) => `${k} ${t.tools} tools ≈ ${kchars(t.tokens)} tokens`);
  if (lists.length) lines.push(`tools/list: ${lists.join("; ")}`);
  lines.push("per case, largest first:");
  for (const c of [...summary.per_case].sort((a, b) => b.chars - a.chars))
    lines.push(`  ${c.case.padEnd(36)} ${String(c.calls).padStart(3)} calls ${kchars(c.chars).padStart(6)} chars ≈ ${kchars(c.tokens).padStart(5)} tokens`);
  const measured = summary.calls.filter((c) => !c.timed_out);
  const over = measured.filter((c) => c.chars > c.budget).sort((a, b) => b.chars / b.budget - a.chars / a.budget);
  const known = over.filter((c) => c.status === "known").length;
  lines.push(`over budget: ${over.length} call(s)${over.length ? `, ${known} of them in a known_defect check` : ""}`);
  for (const c of over) lines.push(`  ${call(c)}${c.status === "known" ? " [known defect]" : ""}`);
  const within = measured.filter((c) => c.chars <= c.budget).sort((a, b) => b.chars / b.budget - a.chars / a.budget);
  if (within.length) {
    lines.push(`nearest their budget, of ${within.length} within it:`);
    for (const c of within.slice(0, nearest)) lines.push(`  ${call(c)}`);
  }
  const timedOut = summary.calls.filter((c) => c.timed_out);
  if (timedOut.length) lines.push(`timed out, size not measured: ${timedOut.map((c) => `${c.case}/${c.check}`).join(", ")}`);
  return lines;
}
