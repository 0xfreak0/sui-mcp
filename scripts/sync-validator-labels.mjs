#!/usr/bin/env node
/**
 * Regenerate current mainnet validator labels from SuiSystemState (0x5).
 * Only active validators receive labels. Names and project URLs are validators'
 * own on-chain metadata, not independent verification of an organization.
 * An operation cap's embedded authorizer names its validator, NOT its holder;
 * only the cap object's owner at the recorded checkpoint proves direct custody.
 *
 * Run: node scripts/sync-validator-labels.mjs
 * A failed/incomplete validator-set or cap read preserves the last snapshot
 * with `stale: true` on its source and rows, then exits nonzero.
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capOwnership, suiAddress, validatorRow } from "./lib/validator-labels.mjs";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "../src/data/validator-labels.json");
const GRAPHQL = "https://graphql.mainnet.sui.io/graphql";
const SYSTEM_OBJECT = suiAddress("0x5");
const SOURCE_URL = `https://suivision.xyz/object/${SYSTEM_OBJECT}`;
const MAX_PAGES = 20;
const CAP_BATCH = 10;
const TODAY = new Date().toISOString().slice(0, 10);

async function query(document, variables = {}) {
 const response = await fetch(GRAPHQL, {
  method: "POST",
  headers: { "content-type": "application/json", "user-agent": "sui-mcp validator-label sync" },
  body: JSON.stringify({ query: document, variables }),
  signal: AbortSignal.timeout(30_000),
 });
 if (!response.ok) throw new Error(`mainnet GraphQL returned HTTP ${response.status}`);
 const body = await response.json();
 if (body.errors?.length || !body.data) {
  throw new Error(`mainnet GraphQL: ${body.errors?.map((e) => e.message).join("; ") ?? "no data"}`);
 }
 return body.data;
}

async function activeValidators() {
 const start = await query(`query { checkpoint { sequenceNumber } epoch { epochId } }`);
 const checkpoint = start.checkpoint?.sequenceNumber;
 const epoch = start.epoch?.epochId;
 if (!Number.isSafeInteger(checkpoint) || !Number.isSafeInteger(epoch)) {
  throw new Error("mainnet checkpoint or epoch unavailable");
 }
 const rows = [];
 let cursor = null;
 for (let page = 0; page < MAX_PAGES; page++) {
  const data = await query(`query($epoch: UInt53!, $after: String) {
      epoch(epochId: $epoch) { epochId validatorSet {
        activeValidators(first: 50, after: $after) {
          nodes { contents { json } }
          pageInfo { hasNextPage endCursor }
        }
      } }
    }`, { epoch, after: cursor });
  const connection = data.epoch?.validatorSet?.activeValidators;
  if (data.epoch?.epochId !== epoch || !connection || !Array.isArray(connection.nodes)) {
   throw new Error(`validator set unavailable in epoch ${epoch}`);
  }
  rows.push(...connection.nodes);
  if (!connection.pageInfo?.hasNextPage) {
   if (rows.length === 0) throw new Error("active validator set was empty");
   return { epoch, checkpoint, rows };
  }
  const next = connection.pageInfo.endCursor;
  if (!next || next === cursor) throw new Error("active validator pagination has no advancing cursor");
  cursor = next;
 }
 throw new Error(`active validator set exceeded ${MAX_PAGES} pages`);
}

async function readCaps(rows, checkpoint) {
 const caps = new Map();
 const present = rows.filter((row) => row.operation_cap_id);
 for (let from = 0; from < present.length; from += CAP_BATCH) {
  const batch = present.slice(from, from + CAP_BATCH);
  const fields = batch.map((row, i) => `c${i}: object(address: "${row.operation_cap_id}", atCheckpoint: $cp) {
      version previousTransaction { digest }
      owner { __typename
        ... on AddressOwner { address { address } }
        ... on ConsensusAddressOwner { address { address } }
        ... on ObjectOwner { address { address } }
      }
      asMoveObject { contents { type { repr } json } }
    }`).join("\n");
  const data = await query(`query($cp: UInt53!) { ${fields} }`, { cp: checkpoint });
  for (let i = 0; i < batch.length; i++) caps.set(batch[i].operation_cap_id, data[`c${i}`] ?? null);
 }
 return caps;
}

function writeSnapshot(snapshot) {
 const payload = `${JSON.stringify(snapshot, null, 2)}\n`;
 let previous;
 try { previous = readFileSync(OUT, "utf8"); }
 catch (error) { if (error.code !== "ENOENT") throw error; }
 if (payload === previous) return;
 const temp = `${OUT}.${process.pid}.tmp`;
 try { writeFileSync(temp, payload); renameSync(temp, OUT); }
 catch (error) { try { unlinkSync(temp); } catch { } throw error; }
}

async function main() {
 const { epoch, checkpoint, rows } = await activeValidators();
 const validators = [];
 const excluded = { invalid_address_or_name: 0, duplicate_address: 0 };
 const seen = new Set();
 for (const node of rows) {
  const row = validatorRow(node);
  if (!row) { excluded.invalid_address_or_name++; continue; }
  if (seen.has(row.address)) { excluded.duplicate_address++; continue; }
  seen.add(row.address);
  validators.push(row);
 }
 if (Object.values(excluded).some(Boolean)) {
  throw new Error(`active set contains invalid/duplicate validator rows: ${JSON.stringify(excluded)} (previous snapshot retained)`);
 }
 const caps = await readCaps(validators, checkpoint);
 const end = await query(`query { epoch { epochId } }`);
 if (end.epoch?.epochId !== epoch) throw new Error("epoch changed during sync; previous snapshot retained");

 const labels = {};
 const capStatusCounts = {};
 for (const row of validators.sort((a, b) => a.address.localeCompare(b.address))) {
  const ownership = capOwnership(caps.get(row.operation_cap_id), row);
  capStatusCounts[ownership.operation_cap_holder_status] = (capStatusCounts[ownership.operation_cap_holder_status] ?? 0) + 1;
  labels[`sui:mainnet:${row.address}`] = {
   label: `${row.name} (Sui validator)`,
   category: "validator",
   entity: row.name,
   evidence: "chain-state",
   source_id: "sui-mainnet-active-validators",
   source_url: SOURCE_URL,
   retrieved_at: TODAY,
   confidence: "high",
   notes: "Active validator membership is on-chain; name and project URL are validator-supplied metadata, not verified organization ownership. Snapshot is valid for the recorded epoch and checkpoint; refresh before treating it as current.",
   chain_state: {
    object_id: SYSTEM_OBJECT,
    epoch,
    checkpoint,
    ...(row.staking_pool_id ? { staking_pool_id: row.staking_pool_id } : {}),
    ...(row.project_url ? { project_url: row.project_url } : {}),
    ...(row.operation_cap_id ? { operation_cap_id: row.operation_cap_id, operation_cap_source_url: `https://suivision.xyz/object/${row.operation_cap_id}` } : {}),
    operation_cap_holder_status: ownership.operation_cap_holder_status,
    ...(ownership.operation_cap_holder ? { operation_cap_holder: ownership.operation_cap_holder, operation_cap_owner_kind: ownership.operation_cap_owner_kind } : {}),
    ...(ownership.operation_cap_owner_object ? { operation_cap_owner_object: ownership.operation_cap_owner_object } : {}),
    ...(ownership.operation_cap_object_version != null ? { operation_cap_object_version: ownership.operation_cap_object_version } : {}),
    ...(ownership.operation_cap_source_tx ? {
     operation_cap_source_tx: ownership.operation_cap_source_tx,
     operation_cap_source_tx_url: `https://suivision.xyz/txblock/${ownership.operation_cap_source_tx}`,
    } : {}),
   },
  };
 }
 const generated = {
  _comment: "GENERATED by scripts/sync-validator-labels.mjs. Mainnet active validators only, from SuiSystemState (0x5). Name and URL are self-declared. A holder is asserted only for a matching operation cap directly owned by an address/consensus address at source_checkpoint; object ownership does not identify a human holder. An older snapshot must not be treated as current if a subsequent sync fails.",
  generated_at: TODAY,
  checkpoint,
  epoch,
  sources: [{
   id: "sui-mainnet-active-validators", evidence: "chain-state", source_url: SOURCE_URL,
   retrieved_at: TODAY, epoch, checkpoint,
   active_validator_count: rows.length, count: validators.length,
   excluded, operation_cap_status_counts: capStatusCounts,
  }],
  labels,
 };
 // Publish only after the complete set, cap reads and epoch continuity are proven.
 writeSnapshot(generated);
 console.log(`mainnet epoch ${epoch}, checkpoint ${checkpoint}: ${validators.length}/${rows.length} active validators; cap ownership ${JSON.stringify(capStatusCounts)}; exclusions ${JSON.stringify(excluded)}`);
}

try {
 await main();
} catch (error) {
 // Keep the last successful labels for provenance, but never claim they are
 // still the current active set when this source cannot be refreshed.
 let previous;
 try { previous = JSON.parse(readFileSync(OUT, "utf8")); }
 catch (readError) { if (readError.code !== "ENOENT") throw readError; }
 if (previous?.labels && Array.isArray(previous.sources)) {
  previous.stale = true;
  previous.stale_since ??= TODAY;
  for (const source of previous.sources) source.stale = true;
  for (const label of Object.values(previous.labels)) {
   if (label.chain_state) label.chain_state.stale = true;
  }
  writeSnapshot(previous);
 }
 throw error;
}
