/**
 * Admission check for the generated attribution files, `disclosed-labels.json`
 * and `validator-labels.json`. Their labels change where fund traces stop, so a
 * sync that writes an unattributed row, an account on the wrong network or an
 * unproven validator custody claim must fail before the data can ship.
 * `test/label-file-check.test.ts` runs it against the files in src/data, which
 * makes CI and the weekly data-sync job refuse such a file.
 */
const ADDRESS = /^0x[0-9a-f]{64}$/;
const ACCOUNT = /^sui:mainnet:0x[0-9a-f]{64}$/;
const categories = new Set(["cex", "bridge", "mixer", "malicious", "protocol", "validator", "defi", "burn", "other"]);

/** Throws on the first inadmissible row; returns the number of labels. */
export function checkLabelFile(file, name) {
  if (!file || typeof file !== "object" || Array.isArray(file) ||
    !file.labels || typeof file.labels !== "object" || Array.isArray(file.labels) ||
    !Array.isArray(file.sources) || file.sources.length === 0) {
    throw new Error(`${name}: missing labels or source records`);
  }
  const sourceIds = new Set();
  for (const source of file.sources) {
    if (typeof source.id !== "string" || typeof source.source_url !== "string" ||
      !source.source_url.startsWith("https://") || !Number.isSafeInteger(source.count) || source.count < 0 ||
      sourceIds.has(source.id)) throw new Error(`${name}: invalid or duplicate source`);
    sourceIds.add(source.id);
  }
  const rows = Object.entries(file.labels);
  if (rows.length === 0) throw new Error(`${name}: empty label set`);
  const bySource = new Map(file.sources.map((source) => [source.id, 0]));
  for (const [account, label] of rows) {
    if (!ACCOUNT.test(account) && !(name === "disclosed-labels.json" && /^eip155:1:0x[0-9a-f]{40}$/.test(account))) {
      throw new Error(`${name}: invalid or unexpected account ${account}`);
    }
    if (!label || typeof label.label !== "string" || !label.label.trim() ||
      !categories.has(label.category) || typeof label.source_id !== "string" ||
      !sourceIds.has(label.source_id) || typeof label.source_url !== "string" ||
      !label.source_url.startsWith("https://") || typeof label.retrieved_at !== "string") {
      throw new Error(`${name}: invalid provenance for ${account}`);
    }
    bySource.set(label.source_id, bySource.get(label.source_id) + 1);
    if (name === "validator-labels.json") {
      const state = label.chain_state;
      if (label.category !== "validator" || label.evidence !== "chain-state" ||
        !state || !Number.isSafeInteger(state.epoch) || !Number.isSafeInteger(state.checkpoint) ||
        state.object_id !== `0x${"0".repeat(63)}5` ||
        (state.operation_cap_holder != null && !ADDRESS.test(state.operation_cap_holder)) ||
        (state.operation_cap_holder != null && state.operation_cap_holder_status !== "direct_owner")) {
        throw new Error(`${name}: invalid validator state for ${account}`);
      }
    }
  }
  for (const source of file.sources) {
    if (bySource.get(source.id) !== source.count) throw new Error(`${name}: ${source.id} count does not match its labelled rows`);
  }
  if (name === "validator-labels.json" && file.epoch !== file.sources[0].epoch) {
    throw new Error(`${name}: inconsistent snapshot epoch`);
  }
  return rows.length;
}
