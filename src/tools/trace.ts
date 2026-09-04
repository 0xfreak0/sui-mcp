import { z } from "zod";
import { numArg } from "./args.js";
import { gqlQuery } from "../clients/graphql.js";
import { batchResolveNames } from "../utils/names.js";
import { lookupProtocol, lookupProtocolDisplay, prefetchProtocolNames } from "../protocols/registry.js";
import { getLabel, isSink } from "../utils/labels.js";
import { detectBridges, resolvableHit, type BridgeHit } from "../utils/bridge/detect.js";
import { chooseNextHop } from "../utils/trace-hop.js";
import { pricesForRanking } from "../utils/price-providers.js";
import {
  decimalsForCoinType,
  dominantInflowUsd,
  formatUsd,
  PRICE_STALE_THRESHOLD_SEC,
  priceUsdAtTime,
  usdValue,
  type PricePoint,
} from "../utils/valuation.js";
import { collectPackageIds, decodeTransaction } from "../protocols/decoder.js";
import { adaptCommands, adaptBalanceChanges } from "../utils/gql-adapters.js";
import { withArchiveFallback } from "../utils/archive-fallback.js";
import { timestampToIso } from "../utils/formatting.js";
import { errorResult, isNotFound } from "../utils/errors.js";
import { getCachedTransaction, saveTransaction } from "../utils/store.js";
import { getNetwork } from "../config.js";
import type { GqlBalanceChangeNode, GqlCommandNode } from "../utils/gql-adapters.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface BalanceChangeInfo {
  address: string;
  coin_type: string;
  amount: string;
}

interface HopResult {
  hop: number;
  digest: string;
  sender: string | null;
  balance_changes: BalanceChangeInfo[];
  timestamp: string | null;
  checkpoint: string | null;
  protocols: string[];
  /** How the next hop was chosen: direct, swap-follow, or pool-fallback. */
  basis?: string;
  /** Recipients on this hop that the trace did not follow. */
  unfollowed_recipients?: Array<{
    address: string;
    amount: string;
    coin_type: string;
    usd_value: number | null;
  }>;
  actions: string[];
  token_flow: { coin: string; amount: string; raw_type: string }[];
  /** Note about how the next hop was chosen (swap follow-through, pool skip). */
  note?: string;
}

const TX_QUERY = `
  query($digest: String!) {
    transaction(digest: $digest) {
      digest
      sender { address }
      effects {
        status
        timestamp
        checkpoint { sequenceNumber }
        balanceChanges {
          nodes {
            coinType { repr }
            amount
            owner { address }
          }
        }
      }
      kind {
        ... on ProgrammableTransaction {
          commands {
            nodes {
              ... on MoveCallCommand {
                __typename
                function {
                  name
                  module {
                    name
                    package { address }
                  }
                }
              }
              ... on TransferObjectsCommand { __typename }
              ... on SplitCoinsCommand { __typename }
              ... on MergeCoinsCommand { __typename }
              ... on PublishCommand { __typename }
              ... on UpgradeCommand { __typename }
            }
          }
        }
      }
    }
  }
`;

interface GqlTxResult {
  transaction: {
    digest: string;
    sender?: { address: string };
    effects?: {
      status: string;
      timestamp?: string;
      checkpoint?: { sequenceNumber: number };
      balanceChanges?: {
        nodes: GqlBalanceChangeNode[];
      };
    };
    kind?: {
      commands?: {
        nodes: GqlCommandNode[];
      };
    };
  } | null;
}

/**
 * A fetched hop, in a shape that does not depend on which transport answered.
 *
 * GraphQL and gRPC return different structures, and the adapters exist to
 * convert the former into the latter for the decoder. Doing that conversion
 * inside the fetch keeps one shape downstream, which is what makes an archive
 * fallback possible without a second set of consumers.
 */
interface FetchedTx {
  sender: string | null;
  balanceChanges: BalanceChangeInfo[];
  /** Decoder input, already in gRPC form whichever transport was used. */
  grpcBalanceChanges: ReturnType<typeof adaptBalanceChanges>;
  commands: ReturnType<typeof adaptCommands>;
  /** Move calls reduced for bridge detection. */
  callSites: Array<{ packageId: string; module: string; function: string }>;
  timestamp: string | null;
  checkpoint: number | null;
  /**
   * Which transport answered. An archive hop is older than the fullnode keeps;
   * a cache hop was fetched in an earlier session and is safe because a
   * finalized transaction is immutable.
   */
  source: "fullnode" | "archive" | "cache";
}

/** Pull Move calls out of decoder-shaped commands, for bridge detection. */
function callSitesOf(commands: ReturnType<typeof adaptCommands>) {
  const out: Array<{ packageId: string; module: string; function: string }> = [];
  for (const cmd of commands) {
    const c = (cmd as { command?: { oneofKind?: string; moveCall?: { package?: string; module?: string; function?: string } } }).command;
    if (c?.oneofKind !== "moveCall" || !c.moveCall) continue;
    out.push({
      packageId: c.moveCall.package ?? "",
      module: c.moveCall.module ?? "",
      function: c.moveCall.function ?? "",
    });
  }
  return out;
}

async function fetchTx(digest: string): Promise<FetchedTx | null> {
  // A finalized transaction never changes, so a hit here is always correct and
  // needs no TTL. This is deliberately the only thing about a trace that is
  // cached: the *conclusion* is derived from labels and from how far the chain
  // has grown, both of which move, and a stale conclusion looks identical to a
  // current one. Re-running a trace after adding a label now costs nothing but
  // the recomputation.
  const network = getNetwork();
  const cached = getCachedTransaction<FetchedTx>(network, digest);
  if (cached) return { ...cached, source: "cache" };

  const data = await gqlQuery<GqlTxResult>(TX_QUERY, { digest }).catch(() => null);
  const tx = data?.transaction;

  // GraphQL answers a pruned digest with a hollow record rather than null: the
  // digest, timestamp and checkpoint are present while sender is null and both
  // balance changes and commands are empty. That is far more dangerous than a
  // miss — it renders as a real hop that simply moved nothing, so a trace ends
  // early looking complete. Treat it as absent and let the archive answer.
  const hollow =
    !!tx &&
    !tx.sender?.address &&
    (tx.effects?.balanceChanges?.nodes?.length ?? 0) === 0 &&
    (tx.kind?.commands?.nodes?.length ?? 0) === 0;

  if (tx && !hollow) {
    const bcNodes = tx.effects?.balanceChanges?.nodes ?? [];
    const commands = adaptCommands(tx.kind?.commands?.nodes ?? []);
    const fetched: FetchedTx = {
      sender: tx.sender?.address ?? null,
      balanceChanges: bcNodes.map((n) => ({
        address: n.owner?.address ?? "",
        coin_type: n.coinType?.repr ?? "",
        amount: n.amount ?? "0",
      })),
      grpcBalanceChanges: adaptBalanceChanges(bcNodes),
      commands,
      callSites: callSitesOf(commands),
      timestamp: tx.effects?.timestamp ?? null,
      checkpoint: tx.effects?.checkpoint?.sequenceNumber ?? null,
      source: "fullnode",
    };
    saveTransaction(network, digest, fetched);
    return fetched;
  }

  // The fullnode prunes. A digest it no longer holds is exactly what the
  // archives exist for, and a trace that stops there is the case an
  // investigator most needs to follow — old money is the money worth tracing.
  //
  // The commit that removed this fallback justified it on the archive not
  // returning balance_changes. Measured against mainnet, it returns the same
  // sender, balance changes, commands, timestamp and checkpoint the fullnode
  // does, so that reason no longer holds.
  let res;
  try {
    res = await withArchiveFallback(
      (client) => client.ledgerService.getTransaction({
        digest,
        readMask: {
          paths: ["digest", "transaction", "effects", "balance_changes", "timestamp", "checkpoint"],
        },
      }),
      (r) => !r.transaction,
    );
  } catch (err) {
    // NOT_FOUND means the digest genuinely is not held anywhere, which the
    // caller renders as "could not fetch". Anything else — a malformed digest,
    // an outage — is a different problem and should say what it was rather
    // than be flattened into absence.
    if (isNotFound(err)) return null;
    throw new Error(
      `Could not read transaction ${digest} from the fullnode or the archive: ${(err as Error).message}`,
    );
  }

  const g = res.transaction;
  if (!g) return null;

  const grpcBc = g.balanceChanges ?? [];
  const kind = g.transaction?.kind;
  const commands =
    kind?.data.oneofKind === "programmableTransaction"
      ? kind.data.programmableTransaction.commands
      : [];

  const archived: FetchedTx = {
    sender: g.transaction?.sender ?? null,
    balanceChanges: grpcBc.map((bc) => ({
      address: bc.address ?? "",
      coin_type: bc.coinType ?? "",
      amount: bc.amount ?? "0",
    })),
    grpcBalanceChanges: grpcBc as ReturnType<typeof adaptBalanceChanges>,
    commands: commands as ReturnType<typeof adaptCommands>,
    callSites: callSitesOf(commands as ReturnType<typeof adaptCommands>),
    // gRPC returns a protobuf Timestamp ({seconds, nanos}), not a unix number.
    timestamp: timestampToIso(g.timestamp) ?? null,
    checkpoint: g.checkpoint != null ? Number(g.checkpoint) : null,
    source: "archive",
  };
  // Worth caching most of all: an archive hop is one the fullnode has pruned,
  // so it is both the slowest to fetch and the least likely to become
  // available again.
  saveTransaction(network, digest, archived);
  return archived;
}

interface TxQueryPage {
  transactions: {
    nodes: Array<{
      digest: string;
      effects?: {
        checkpoint?: { sequenceNumber: number };
        timestamp?: string;
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor?: string };
  };
}

/**
 * The next transaction to follow from `address`.
 *
 * Forward tracing filters on **sentAddress**, not `affectedAddress`. The
 * distinction is the whole correctness of a forward hop: "the next transaction
 * affecting R" is any transaction that touched R, including someone paying R.
 * Following that attributed a third party's transaction to the subject, and —
 * after the custody check was added — made a perfectly intact trace stop with
 * `custody_break` because R had merely *received* something before spending.
 * What a forward trace wants is the next transaction R itself **sent**.
 *
 * Backward keeps `affectedAddress`, because the transaction that funded an
 * address is by definition one someone else sent.
 *
 * `afterCheckpoint` is **exclusive** — verified against mainnet: passing a
 * transaction's own checkpoint excludes it, passing `cp - 1` includes it. The
 * previous code passed `cp`, so anything the recipient did *in the same
 * checkpoint* was skipped. That is not an edge case: same-checkpoint
 * forwarding is what a script does, which is exactly the adversarial pattern a
 * trace is chasing. We ask from `cp - 1` and drop the current digest
 * explicitly.
 */
async function findNextTx(
  address: string,
  atCheckpoint: number | undefined,
  direction: "forward" | "backward",
  excludeDigest: string,
): Promise<string | null> {
  const isForward = direction === "forward";

  const query = isForward
    ? `query($address: SuiAddress!, $first: Int, $afterCheckpoint: Int) {
        transactions(
          filter: { sentAddress: $address, afterCheckpoint: $afterCheckpoint }
          first: $first
        ) {
          nodes { digest }
        }
      }`
    : `query($address: SuiAddress!, $last: Int, $beforeCheckpoint: Int) {
        transactions(
          filter: { affectedAddress: $address, beforeCheckpoint: $beforeCheckpoint }
          last: $last
        ) {
          nodes { digest }
        }
      }`;

  const variables: Record<string, unknown> = { address };
  if (isForward) {
    variables.first = 5;
    // Inclusive of the current checkpoint; the current digest is filtered below.
    variables.afterCheckpoint = atCheckpoint === undefined ? undefined : atCheckpoint - 1;
  } else {
    variables.last = 5;
    variables.beforeCheckpoint = atCheckpoint === undefined ? undefined : atCheckpoint + 1;
  }

  const data = await gqlQuery<TxQueryPage>(query, variables);
  const nodes = data.transactions.nodes ?? [];
  // Take the first that is not the hop we are standing on. Asking for five
  // rather than one is what makes the same-checkpoint case work: the current
  // transaction is usually first in that window.
  const next = nodes.find((n) => n.digest !== excludeDigest);
  return next?.digest ?? null;
}

function shortCoinType(coinType: string): string {
  const parts = coinType.split("::");
  return parts.length >= 3 ? parts[parts.length - 1] : coinType;
}

function formatAmount(amount: string, coinType: string): string {
  const val = BigInt(amount);
  const coin = shortCoinType(coinType);
  const abs = val < 0n ? -val : val;
  const sign = val < 0n ? "-" : "+";

  // Known decimals for common coins
  const KNOWN_DECIMALS: Record<string, number> = {
    SUI: 9, USDC: 6, USDT: 6, DEEP: 6, CETUS: 9, NS: 6,
    WAL: 9, BUCK: 9, NAVX: 9, SCA: 9, BLUE: 9, WETH: 8,
    WBTC: 8, IKA: 9, UP: 6,
  };
  const decimals = KNOWN_DECIMALS[coin];

  if (decimals !== undefined) {
    const divisor = 10n ** BigInt(decimals);
    const whole = abs / divisor;
    const frac = abs % divisor;
    const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
    const formatted = fracStr ? `${whole}.${fracStr}` : whole.toString();
    return `${sign}${formatted} ${coin}`;
  }

  return `${sign}${abs} ${coin} (raw)`;
}

function addrLabel(addr: string, nameMap: Map<string, string>): string {
  return nameMap.get(addr) ?? `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatTimeSpan(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 1) return "< 1 minute";
  if (min < 60) return `${min} minute${min !== 1 ? "s" : ""}`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr !== 1 ? "s" : ""}`;
  const days = Math.round(hr / 24);
  return `${days} day${days !== 1 ? "s" : ""}`;
}

function buildSummary(
  hops: HopResult[],
  direction: string,
  nameMap: Map<string, string>,
): string {
  if (hops.length === 0) return "No hops traced.";

  const lines: string[] = [];
  const first = hops[0];
  const last = hops[hops.length - 1];

  // Header
  lines.push(`FUND TRACE — ${direction.toUpperCase()}`);
  lines.push(`Starting tx: ${first.digest}`);

  // Time range
  if (first.timestamp && last.timestamp && hops.length > 1) {
    const diffMs = Math.abs(new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime());
    lines.push(`Time span: ${formatTimeSpan(diffMs)} across ${hops.length} hops`);
  } else {
    lines.push(`Hops: ${hops.length}`);
  }

  // Protocols
  const allProtocols = new Set<string>();
  for (const hop of hops) for (const p of hop.protocols) allProtocols.add(p);
  if (allProtocols.size > 0) {
    lines.push(`Protocols: ${[...allProtocols].join(", ")}`);
  }

  lines.push("");

  // Per-hop breakdown
  for (const hop of hops) {
    const sender = hop.sender ? addrLabel(hop.sender, nameMap) : "unknown";
    const ts = hop.timestamp ? new Date(hop.timestamp).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "";

    lines.push(`--- Hop ${hop.hop} ${ts ? `(${ts})` : ""} ---`);
    lines.push(`Tx:     ${hop.digest}`);
    lines.push(`Sender: ${sender}`);

    if (hop.actions.length > 0) {
      lines.push(`Action: ${hop.actions.join(", ")}`);
    }

    // Balance changes — separate significant from gas
    const significant: typeof hop.balance_changes = [];
    const gasOnly: typeof hop.balance_changes = [];
    for (const bc of hop.balance_changes) {
      const abs = BigInt(bc.amount) < 0n ? -BigInt(bc.amount) : BigInt(bc.amount);
      if (abs > 1_000_000n) {
        significant.push(bc);
      } else {
        gasOnly.push(bc);
      }
    }

    if (significant.length > 0) {
      lines.push("Flows:");
      for (const bc of significant) {
        const who = addrLabel(bc.address, nameMap);
        lines.push(`  ${who}: ${formatAmount(bc.amount, bc.coin_type)}`);
      }
    }

    if (gasOnly.length > 0 && significant.length === 0) {
      lines.push("Flows:  gas only");
    }

    lines.push("");
  }

  // End-state summary
  const lastHop = hops[hops.length - 1];
  const allCoinsTraced = new Set<string>();
  for (const hop of hops) {
    for (const bc of hop.balance_changes) {
      const abs = BigInt(bc.amount) < 0n ? -BigInt(bc.amount) : BigInt(bc.amount);
      if (abs > 1_000_000n) allCoinsTraced.add(shortCoinType(bc.coin_type));
    }
  }
  if (allCoinsTraced.size > 0) {
    lines.push(`Coins involved: ${[...allCoinsTraced].join(", ")}`);
  }
  if (lastHop.actions.length > 0) {
    lines.push(`Final action: ${lastHop.actions.join(", ")}`);
  }

  return lines.join("\n");
}

export function registerTraceTools(server: McpServer) {
  server.tool(
    "trace_funds",
    "(Advanced — multi-hop) Trace fund flow from a transaction. Follow money forward to recipients or backward to the sender's funding source. Swap-aware (follows value across DEX swaps instead of losing it in the pool), stops at known sinks (exchanges, bridges, mixers, malicious wallets — see manage_labels), and values each hop in USD at block time via Pyth. Returns protocol-decoded actions and a human-readable summary. Makes sequential API calls per hop (up to 10).",
    {
      digest: z.string().describe("Starting transaction digest (Base58)"),
      direction: z
        .enum(["forward", "backward"])
        .describe("Direction to trace: 'forward' follows recipients, 'backward' follows sender"),
      hops: numArg()
        .optional()
        .describe("Max hops to follow (default 3, max 10)"),
      coin_type: z
        .string()
        .optional()
        .describe("Restrict the DISPLAYED balance changes to this coin type (e.g. 0x2::sui::SUI). The trace still follows value across swaps regardless. If omitted, all of each hop's balance changes are shown."),
    },
    async ({ digest, direction, hops, coin_type }) => {
      const maxHops = Math.min(hops ?? 3, 10);
      const traceHops: HopResult[] = [];
      let currentDigest: string | null = digest;
      // Set when a hop's next address is a known fund sink (exchange, bridge,
      // mixer, malicious wallet, burn) — following further would add noise.
      let terminationReason: string | null = null;
      // Bridge exits seen anywhere in the trace, keyed by digest.
      //
      // Detected from the hop's Move calls rather than from a sink label. A
      // bridge does not transfer value to an identifiable wallet — it burns or
      // locks the coin and emits a message — so there is usually no recipient
      // address to label, and `isSink` never fires. The call is the signal
      // that is actually present.
      const bridgeExits: Array<{ digest: string; hits: BridgeHit[] }> = [];
      // Who the next hop's transaction must have been sent by, for the chain to
      // still be about the same funds. Null on the first hop, which has no
      // predecessor to disagree with.
      let expectedSender: string | null = null;
      // Hops the fullnode had pruned. Worth reporting: it tells a reader the
      // trace reached back past the fullnode's retention, which is usually the
      // interesting part of an old case.
      let archiveHops = 0;
      // Hops served from the local transaction cache. Reported so a fast trace
      // is legible as reuse rather than as a different chain read.
      let cacheHops = 0;
      // Addresses already followed. A↔B ping-pong is a common obfuscation
      // pattern, and it passes the custody check on every hop — without this
      // the trace fills maxHops with a two-wallet loop and presents it as a
      // ten-hop chain.
      const visitedAddresses = new Set<string>();
      let custodyBreak: Record<string, unknown> | null = null;
      // The coin we're following. May change mid-trace after a swap (A→B).
      let trackedCoin: string | null = coin_type ?? null;

      // A pool/protocol address is a pass-through, not a real destination —
      // funds routed through a DEX belong to the actor, not the pool.
      const isPassThrough = (addr: string): boolean => {
        // Curated lookup only, deliberately. Treating an address as a
        // pass-through makes the trace walk through it, so widening this with
        // runtime-resolved MVR names would let anyone who registers a name
        // change where a fund trace stops.
        if (lookupProtocol(addr)) return true;
        const cat = getLabel(addr)?.category;
        return cat === "protocol" || cat === "defi";
      };

      for (let hop = 0; hop < maxHops && currentDigest; hop++) {
        let tx: FetchedTx | null;
        try {
          tx = await fetchTx(currentDigest);
        } catch (err) {
          // A transport failure is not an empty trace. On the first hop there
          // is nothing to report, so say why; later, keep what was found and
          // mark it incomplete.
          if (hop === 0) return errorResult((err as Error).message);
          terminationReason = `${(err as Error).message} The trace is incomplete rather than finished.`;
          break;
        }
        if (!tx) {
          // Not found on the fullnode *or* the archive. Breaking silently here
          // produced `hop_count: 0, hops: []` with no error, which a reader
          // takes as "there is nothing to follow" rather than "this could not
          // be fetched" — and on hop 0 those are opposite conclusions.
          if (hop === 0) {
            return errorResult(
              `Could not fetch the starting transaction ${currentDigest} from the fullnode or the archive. ` +
                "Check the digest and the network. This is not evidence that no funds moved.",
            );
          }
          terminationReason =
            `Could not fetch the next transaction (${currentDigest}) from the fullnode or the archive. ` +
            "The trace is incomplete rather than finished — value may have moved beyond this point.";
          break;
        }
        if (tx.source === "archive") archiveHops++;
        if (tx.source === "cache") cacheHops++;

        const sender = tx.sender;
        const allChanges = tx.balanceChanges;
        // What we DISPLAY for the hop. Filter only by the caller's explicit
        // coin_type (a constant), NOT the mutable `trackedCoin`: when the trace
        // auto-switches assets across a swap, the hop's real flows must still be
        // shown — filtering by the switched coin would render swap-follow hops
        // empty (the bug this fixes). Next-hop selection still sees allChanges.
        const displayChanges = coin_type
          ? allChanges.filter((c) => c.coin_type === coin_type)
          : allChanges;

        const checkpointNum = tx.checkpoint ?? undefined;

        // Decode protocol actions
        const commands = tx.commands;
        const grpcBc = tx.grpcBalanceChanges;
        // Per-hop rather than batched: hops are discovered one at a time, so
        // there is no earlier point at which the package set is known.
        await prefetchProtocolNames(collectPackageIds(commands));
        const decoded = decodeTransaction(commands, grpcBc, sender ?? undefined);

        // Detect a bridge exit from this hop's Move calls. Runs after the
        // prefetch so the registry tier can see lineage-resolved packages —
        // an upgraded bridge still identifies.
        const hits = detectBridges(tx.callSites);
        if (hits.length) bridgeExits.push({ digest: currentDigest, hits });

        // Chain of custody. findNextTx asks for the next transaction *affecting*
        // the address we followed, which for a shared contract is some other
        // user's transaction. Without this check the trace keeps walking and
        // attributes a stranger's flows to the subject — confidently, and with
        // no visible seam.
        // Forward only. Backward tracing deliberately walks to the transaction
        // that FUNDED the address, which by definition someone else sent — so
        // requiring the sender to match would fire on every backward hop.
        if (direction === "forward" && expectedSender && sender && sender !== expectedSender) {
          custodyBreak = {
            at_hop: hop + 1,
            digest: currentDigest,
            expected_sender: expectedSender,
            actual_sender: sender,
            meaning:
              "The next transaction on this address was not sent by it. That happens when the trace " +
              "followed a shared contract (a pool or protocol), whose subsequent activity belongs to " +
              "other users. Stopping here rather than attributing their flows to the subject.",
          };
          terminationReason =
            "Chain of custody broken — the following transaction was sent by a different address. " +
            "Stopping trace.";
          break;
        }

        const hopResult: HopResult = {
          hop: hop + 1,
          digest: currentDigest,
          sender,
          balance_changes: displayChanges,
          timestamp: tx.timestamp,
          checkpoint: tx.checkpoint?.toString() ?? null,
          protocols: decoded.protocols,
          actions: decoded.actions,
          token_flow: decoded.token_flow,
        };
        traceHops.push(hopResult);

        // A bridge exit ends the on-chain trace. The coin was burned or locked,
        // so there is no recipient to follow — chooseNextHop would fall back to
        // the sender and findNextTx would return whatever that address did
        // next, which is unrelated activity presented as a continuation of the
        // same funds. The value's next move is on another chain, and
        // resolve_bridge_transfer is how it is followed.
        // Forward only. A bridge exit means value left the chain going forward;
        // a backward trace is asking where the money in this transaction came
        // FROM, which the exit says nothing about. Terminating there cut a
        // four-hop funding walk to one.
        const exitHere =
          direction === "forward"
            ? bridgeExits.find((e) => e.digest === currentDigest)
            : undefined;
        if (exitHere) {
          const protocols = exitHere.hits.map((h) => h.protocol).join(", ");
          terminationReason =
            `Value left Sui via ${protocols}. Stopping: the coin was burned or locked, so nothing ` +
            "on this chain continues it. Run resolve_bridge_transfer on this transaction to pick " +
            "the transfer up on the destination chain.";
          break;
        }

        // Price this hop's coins before choosing, so the next-hop ranking
        // compares value rather than raw units — 1 USDC is 1e6 units and 1 SUI
        // is 1e9, so a raw comparison ranks by decimal places and can follow
        // dust over the real transfer.
        //
        // Current prices, deliberately. Ranking needs *relative* value, and
        // which of five recipients got the most does not become more correct
        // with block-time precision — while historical pricing is Pyth-only
        // and Pyth now bills for it. Coins with no quote fall back to raw
        // magnitude, which is at least consistent within one coin.
        const hopCoins = [...new Set(allChanges.map((c) => c.coin_type))];
        const decisionPrices = await pricesForRanking(hopCoins).catch(
          () => new Map<string, { price: number }>(),
        );
        const valueUsd = (c: { amount: string; coin_type: string }) => {
          const price = decisionPrices.get(c.coin_type)?.price;
          if (price == null) return null;
          return usdValue(c.amount, decimalsForCoinType(c.coin_type), price);
        };

        // Swap-aware, pool-skipping next-hop selection.
        const decision = chooseNextHop({
          sender,
          changes: allChanges,
          actions: decoded.actions,
          direction,
          trackedCoin,
          isPassThrough,
          valueUsd,
        });
        trackedCoin = decision.nextCoinType;
        if (decision.note) hopResult.note = decision.note;
        hopResult.basis = decision.basis;
        // Branches the trace set aside. Reported per hop so "the money went
        // here" is never read off a split that had five other recipients.
        if (decision.unfollowed.length) hopResult.unfollowed_recipients = decision.unfollowed;
        const nextAddress = decision.nextAddress;
        if (nextAddress && visitedAddresses.has(nextAddress)) {
          terminationReason =
            `Cycle detected — value returned to ${nextAddress}, an address already in this trace. ` +
            "Stopping rather than reporting the same wallets again as further hops.";
          break;
        }
        if (nextAddress) visitedAddresses.add(nextAddress);
        // Only meaningful forward: the address we hand on must be the one that
        // sends the next transaction for the chain to still concern these funds.
        expectedSender = direction === "forward" ? nextAddress : null;

        if (!nextAddress) break;

        // Stop at known sinks: once funds reach an exchange, bridge, mixer,
        // malicious wallet, or burn address, further hops are noise.
        if (isSink(nextAddress)) {
          const label = getLabel(nextAddress);
          terminationReason = `Funds reached ${label?.label ?? nextAddress} (${label?.category}) — a known sink. Stopping trace.`;
          // A bridge is the one sink that is not terminal, and a labeled one
          // may carry no curated Move-call marker at all — a relayer forward,
          // an unlisted bridge, or a plain transfer into a deposit address.
          // Detection from calls alone therefore misses exactly the case an
          // investigator created the label for, and the trace reads as "the
          // money stopped here" when it left the chain.
          if (label?.category === "bridge") {
            bridgeExits.push({
              digest: currentDigest,
              hits: [
                {
                  protocol: label.label,
                  resolution: "detect-only",
                  matched: "address-label",
                  note:
                    "Labeled as a bridge. No curated marker fired on this transaction, so the " +
                    "protocol is whatever the label says — try resolve_bridge_transfer on this " +
                    "digest, and follow the value on the destination chain if it cannot resolve it.",
                },
              ],
            });
          }
          break;
        }

        currentDigest = await findNextTx(
          nextAddress,
          checkpointNum,
          direction,
          currentDigest,
        );
      }

      // Collect all unique addresses from hops
      const allAddresses = new Set<string>();
      for (const hop of traceHops) {
        if (hop.sender) allAddresses.add(hop.sender);
        for (const bc of hop.balance_changes) {
          if (bc.address) allAddresses.add(bc.address);
        }
      }

      // Batch-resolve SuiNS names
      const nameMap = await batchResolveNames([...allAddresses]);

      // Build labels from SuiNS names, protocol package IDs, and the
      // attribution registry (exchanges, bridges, malicious wallets, ...).
      const addressLabels: Record<
        string,
        { name?: string; protocol?: string; label?: string; category?: string; confidence?: string; source?: string; is_sink?: boolean }
      > = {};
      for (const addr of allAddresses) {
        const label: (typeof addressLabels)[string] = {};
        const name = nameMap.get(addr);
        if (name) label.name = name;
        // Display-only enrichment of the address label, so an MVR name is fine.
        const proto = lookupProtocolDisplay(addr);
        if (proto) label.protocol = proto.name;
        const known = getLabel(addr);
        if (known) {
          label.label = known.label;
          label.category = known.category;
          label.confidence = known.confidence;
          label.source = known.source;
          label.is_sink = isSink(addr);
          // Prefer explicit attribution over the short-hex fallback in the
          // human summary — "Binance deposit" beats "0x1234…abcd".
          if (!name) nameMap.set(addr, known.label);
        }
        if (label.name || label.protocol || label.label) {
          addressLabels[addr] = label;
        }
      }

      // Value each hop's flows in USD at that hop's block time (Pyth historical
      // oracle). Best-effort: coins without a Pyth feed get a null usd_value,
      // and pricing failures never break the trace.
      const hopPrices: Array<Map<string, PricePoint>> = [];
      const hopUnix: Array<number | null> = [];
      for (const hop of traceHops) {
        const coinTypes = hop.balance_changes.map((bc) => bc.coin_type);
        const unixTs = hop.timestamp ? Math.floor(new Date(hop.timestamp).getTime() / 1000) : null;
        hopUnix.push(unixTs);
        hopPrices.push(await priceUsdAtTime(coinTypes, unixTs ?? undefined));
      }

      let anyStalePrice = false;

      // Enrich hops with names, protocol labels, formatted amounts, and USD value
      const enrichedHops = traceHops.map((hop, i) => {
        const prices = hopPrices[i];
        const blockUnix = hopUnix[i];
        const inflows: Array<{ address: string; usd: number }> = [];
        const balance_changes = hop.balance_changes.map((bc) => {
          const pp = prices.get(bc.coin_type) ?? null;
          const price = pp?.price ?? null;
          const usd = usdValue(bc.amount, decimalsForCoinType(bc.coin_type), price);
          if (price != null && BigInt(bc.amount) > 0n) inflows.push({ address: bc.address, usd });
          // How far is the price we used from the actual block time?
          const ageSec = pp && blockUnix != null ? Math.abs(pp.publishTime - blockUnix) : null;
          const stale = ageSec != null && ageSec > PRICE_STALE_THRESHOLD_SEC;
          if (stale) anyStalePrice = true;
          return {
            ...bc,
            formatted: formatAmount(bc.amount, bc.coin_type),
            name: nameMap.get(bc.address) ?? null,
            protocol: lookupProtocolDisplay(bc.address)?.name ?? null,
            usd_value: price != null ? Number(usd.toFixed(2)) : null,
            // Unit price actually used and the exact Pyth sample time — makes the
            // valuation auditable (it's the transaction-second price, not a daily avg).
            price_usd: price != null ? Number(price.toFixed(price < 1 ? 6 : 4)) : null,
            priced_at: pp ? new Date(pp.publishTime * 1000).toISOString() : null,
            price_age_sec: ageSec,
            price_stale: stale || undefined,
          };
        });
        const hopUsd = dominantInflowUsd(inflows);
        return {
          ...hop,
          sender_name: hop.sender ? nameMap.get(hop.sender) ?? null : null,
          usd_total: hopUsd > 0 ? Number(hopUsd.toFixed(2)) : null,
          balance_changes,
        };
      });

      // USD headline. We do NOT sum across hops — that's the same money moving,
      // so a sum overstates impact. Report the origin and the largest hop.
      const usdTotals = enrichedHops.map((h) => h.usd_total ?? 0);
      const originUsd = usdTotals[0] ?? 0;
      const peakUsd = usdTotals.length ? Math.max(...usdTotals) : 0;

      const baseSummary = buildSummary(traceHops, direction, nameMap);
      const parts = [baseSummary];
      if (peakUsd > 0) {
        const usd = ["Value (USD, at transaction time — Pyth):"];
        if (originUsd > 0) usd.push(`  Origin (hop 1): ${formatUsd(originUsd)}`);
        usd.push(`  Largest single-hop flow: ${formatUsd(peakUsd)}`);
        // Show the unit prices and their exact sample times, so it's visible
        // these are transaction-second prices — not a daily average.
        const shown = new Set<string>();
        for (const bc of enrichedHops[0].balance_changes) {
          if (bc.price_usd == null || shown.has(bc.coin_type)) continue;
          shown.add(bc.coin_type);
          const at = bc.priced_at ? ` (${bc.priced_at.replace("T", " ").slice(0, 19)} UTC)` : "";
          usd.push(`  ${shortCoinType(bc.coin_type)} @ $${bc.price_usd}${at}${bc.price_stale ? " ⚠stale" : ""}`);
        }
        usd.push("  (Later hops are largely the same funds moving; values are not summed.)");
        if (anyStalePrice) {
          usd.push("  ⚠ Some prices are >1h from block time (illiquid feed / Pyth gap) — treat as approximate.");
        }
        parts.push(usd.join("\n"));
      }
      if (terminationReason) parts.push(`⚠ ${terminationReason}`);
      if (custodyBreak) {
        parts.push(
          `⚠ Chain of custody broke at hop ${custodyBreak.at_hop}: expected a transaction from ` +
            `${custodyBreak.expected_sender}, found one sent by ${custodyBreak.actual_sender}. ` +
            `Hops beyond this point were not followed.`,
        );
      }
      if (bridgeExits.length) {
        // Said in the summary as well as the structured payload: a trace that
        // just ends reads as "the money stopped here", which is the wrong
        // conclusion when it actually left the chain.
        const lines = ["🌉 Value left Sui in this trace:"];
        for (const exit of bridgeExits) {
          for (const hit of exit.hits) {
            lines.push(`  ${exit.digest} — ${hit.protocol}: ${hit.note}`);
          }
        }
        parts.push(lines.join("\n"));
      }
      const summary = parts.join("\n\n");

      const fullData = {
        starting_digest: digest,
        direction,
        coin_type: coin_type ?? "all",
        hop_count: enrichedHops.length,
        stopped_at_sink: terminationReason,
        ...(archiveHops ? { hops_served_by_archive: archiveHops } : {}),
        ...(cacheHops ? { hops_from_cache: cacheHops } : {}),
        ...(custodyBreak ? { custody_break: custodyBreak } : {}),
        // Structured, not just prose in the summary, so a caller can chain
        // straight into resolve_bridge_transfer without re-parsing the text.
        ...(bridgeExits.length
          ? {
              bridge_exits: bridgeExits.map((e) => ({
                digest: e.digest,
                protocols: e.hits.map((h) => ({
                  protocol: h.protocol,
                  resolution: h.resolution,
                  matched: h.matched,
                  note: h.note,
                })),
                ...(resolvableHit(e.hits)
                  ? { next_tool: "resolve_bridge_transfer" }
                  : {}),
              })),
            }
          : {}),
        usd: {
          origin: originUsd > 0 ? Number(originUsd.toFixed(2)) : null,
          peak_hop: peakUsd > 0 ? Number(peakUsd.toFixed(2)) : null,
          note: "Per-hop USD at transaction time (Pyth, per-second); not summed across hops (same funds moving). See each balance change's price_usd / priced_at / price_age_sec.",
        },
        hops: enrichedHops,
        address_labels: addressLabels,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: summary,
          },
          {
            type: "text" as const,
            text: JSON.stringify(fullData, null, 2),
          },
        ],
      };
    }
  );
}
