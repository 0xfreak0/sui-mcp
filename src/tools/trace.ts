import { z } from "zod";
import { gqlQuery } from "../clients/graphql.js";
import { batchResolveNames } from "../utils/names.js";
import { lookupProtocol, lookupProtocolDisplay, prefetchProtocolNames } from "../protocols/registry.js";
import { getLabel, isSink } from "../utils/labels.js";
import { detectBridges, resolvableHit, type BridgeHit } from "../utils/bridge/detect.js";
import { chooseNextHop } from "../utils/trace-hop.js";
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

interface FetchedTx {
  sender: string | null;
  balanceChanges: BalanceChangeInfo[];
  balanceChangeNodes: GqlBalanceChangeNode[];
  commandNodes: GqlCommandNode[];
  timestamp: string | null;
  checkpoint: number | null;
}

async function fetchTx(digest: string): Promise<FetchedTx | null> {
  const data = await gqlQuery<GqlTxResult>(TX_QUERY, { digest });
  const tx = data.transaction;
  if (!tx) return null;

  const bcNodes = tx.effects?.balanceChanges?.nodes ?? [];
  const balanceChanges = bcNodes.map((n) => ({
    address: n.owner?.address ?? "",
    coin_type: n.coinType?.repr ?? "",
    amount: n.amount ?? "0",
  }));

  return {
    sender: tx.sender?.address ?? null,
    balanceChanges,
    balanceChangeNodes: bcNodes,
    commandNodes: tx.kind?.commands?.nodes ?? [],
    timestamp: tx.effects?.timestamp ?? null,
    checkpoint: tx.effects?.checkpoint?.sequenceNumber ?? null,
  };
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

async function findNextTx(
  address: string,
  afterCheckpoint?: number,
  direction: "forward" | "backward" = "forward",
): Promise<string | null> {
  const isForward = direction === "forward";
  const query = isForward
    ? `query($address: SuiAddress!, $first: Int, $afterCheckpoint: Int) {
        transactions(
          filter: { affectedAddress: $address, afterCheckpoint: $afterCheckpoint }
          first: $first
        ) {
          nodes { digest effects { checkpoint { sequenceNumber } timestamp } }
          pageInfo { hasNextPage endCursor }
        }
      }`
    : `query($address: SuiAddress!, $last: Int, $beforeCheckpoint: Int) {
        transactions(
          filter: { affectedAddress: $address, beforeCheckpoint: $beforeCheckpoint }
          last: $last
        ) {
          nodes { digest effects { checkpoint { sequenceNumber } timestamp } }
          pageInfo { hasNextPage endCursor }
        }
      }`;

  const variables: Record<string, unknown> = { address };
  if (isForward) {
    variables.first = 1;
    variables.afterCheckpoint = afterCheckpoint;
  } else {
    variables.last = 1;
    variables.beforeCheckpoint = afterCheckpoint;
  }

  const data = await gqlQuery<TxQueryPage>(query, variables);
  const node = data.transactions.nodes[0];
  return node?.digest ?? null;
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
      hops: z
        .number()
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
        const tx = await fetchTx(currentDigest);
        if (!tx) break;

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
        const commands = adaptCommands(tx.commandNodes);
        const grpcBc = adaptBalanceChanges(tx.balanceChangeNodes);
        // Per-hop rather than batched: hops are discovered one at a time, so
        // there is no earlier point at which the package set is known.
        await prefetchProtocolNames(collectPackageIds(commands));
        const decoded = decodeTransaction(commands, grpcBc, sender ?? undefined);

        // Detect a bridge exit from this hop's Move calls. Runs after the
        // prefetch so the registry tier can see lineage-resolved packages —
        // an upgraded bridge still identifies.
        const hits = detectBridges(
          tx.commandNodes
            .filter((n) => n.function)
            .map((n) => ({
              packageId: n.function!.module.package.address,
              module: n.function!.module.name,
              function: n.function!.name,
            })),
        );
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

        // Price this hop's coins before choosing, so the next-hop ranking
        // compares value rather than raw units — 1 USDC is 1e6 units and 1 SUI
        // is 1e9, so a raw comparison ranks by decimal places and can follow
        // dust over the real transfer. Best-effort: coins with no Pyth feed
        // fall back to raw magnitude, which is at least consistent per coin.
        const hopCoins = [...new Set(allChanges.map((c) => c.coin_type))];
        const hopUnixTs = tx.timestamp ? Math.floor(Date.parse(tx.timestamp) / 1000) : undefined;
        const decisionPrices = await priceUsdAtTime(hopCoins, hopUnixTs).catch(
          () => new Map<string, { price: number } | undefined>(),
        );
        const valueUsd = (c: { amount: string; coin_type: string }) => {
          const price = (decisionPrices as Map<string, { price: number } | undefined>).get(
            c.coin_type,
          )?.price;
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
