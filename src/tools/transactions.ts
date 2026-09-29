import { z } from "zod";
import { assignSignerRoles } from "../utils/multisig.js";
import { isDigest, invalidDigestMessage, normalizeDigest } from "../utils/digest.js";
import { boolArg, numArg, addressArg, refinePoint } from "./args.js";
import { sui } from "../clients/grpc.js";
import { formatStatus, describeFailure, formatGas, bigintToString, timestampToIso, foldRepeats } from "../utils/formatting.js";
import { errorResult } from "../utils/errors.js";
import { withArchiveFallback } from "../utils/archive-fallback.js";
import type { GrpcTypes } from "@mysten/sui/grpc";
import { gqlQuery } from "../clients/graphql.js";
import { collectPackageIds, decodeTransaction, routeLoops, type RouteHop } from "../protocols/decoder.js";
import { describeRouteLoops } from "../utils/route-loop-cost.js";
import { prefetchProtocolNames, lookupProtocol, lookupProtocolDisplay, readProtocolCustody, type ProtocolCustodyRead } from "../protocols/registry.js";
import { originIncomplete, protocolsSignedBy } from "../protocols/package-custody.js";
import { fetchEventJson, packageOfEventType } from "../utils/event-json.js";
import { displayCoin, prefetchCoinScale } from "../utils/valuation.js";
import { isSponsorGasChange } from "../utils/sponsor-gas.js";
import { fetchTransactions, MAX_DIGESTS } from "../utils/multi-tx.js";
import {
  type ObjectChangesByKind,
  createdFor,
  custodyChanges,
  listObjectChanges,
  mutatedCapabilities,
  readGrpcObjectChanges,
  summarizeObjectChanges,
  type ObjectMovement,
} from "../utils/object-flow.js";
import {
  EXECUTED_OBJECT_PATHS,
  commandsOmittedView,
  executedObjects,
  selectCommands,
  ptbDataFromBcs,
  resolvePtb,
  type CommandsOmitted,
  type ResolvedPtb,
} from "../utils/ptb-resolve.js";
import { commandInputIndices, eventCommands, objectMatcher } from "../utils/command-attribution.js";
import { gasSource, readAddressBalanceOps, readFundsWithdrawals } from "../utils/address-balance.js";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { describeWindow, resolveWindow } from "../utils/checkpoint-time.js";
import { COMMANDS_SELECTION, completeTxConnections, type GqlConnection } from "../utils/tx-connections.js";
import type { GqlCommandNode } from "../utils/gql-adapters.js";
import {
  BOTH_WAYS_PAGE_INFO,
  orderedPage,
  orderedPageArgs,
  shownRange,
  type BothWaysPageInfo,
  type ListOrder,
} from "../utils/pagination.js";
import {
  fetchPackageVersions,
  versionScopeNote,
  type PackageVersion,
  type VersionScope,
} from "../utils/package-versions.js";
import {
  decodeFanoutCursor,
  encodeFanoutCursor,
  mergeVersionPages,
  type VersionPage,
  type VersionStream,
} from "../utils/version-fanout.js";
import { capPayload, pageAt, resultUri, type ListCap } from "../utils/output-cap.js";
import { EVENT_FOLD_BUDGET, foldEvents } from "../utils/event-fold.js";
import { isPlumbingPackage } from "../utils/system-packages.js";
import { signedFieldReadings } from "../utils/signed-int.js";
import { getNetwork } from "../config.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Why a package whose publisher this call did not read may be unnamed. */
const PROTOCOLS_UNCHECKED_NOTE =
  "The publisher of these packages was not read, so they are not named after a curated protocol whose key published them. past_bound are beyond the per-call bound; read_failed are retried on the next call.";

/** Characters of events one full-view page lists; `event_offset` continues from the next position. */
const FULL_EVENT_BUDGET = 40_000;

const DYNAMIC_FIELD = /^0x0*2::dynamic_field::Field</;

/**
 * Changed dynamic fields of one type and version folded into one row with
 * every id. A table's entries share a type that names its key and value,
 * and a PTB that walks a tick map or an order book touches hundreds of them.
 * Every other row stays as is.
 */
function foldFieldChanges(byKind: ObjectChangesByKind): Record<string, unknown[]> {
  return Object.fromEntries(
    Object.entries(byKind).map(([kind, rows]) => {
      const out: Array<(typeof rows)[number] | { type: string; version: string | null; count: number; object_ids: string[] }> = [];
      const groups = new Map<string, { type: string; version: string | null; count: number; object_ids: string[] }>();
      for (const r of rows) {
        if (!r.type || !DYNAMIC_FIELD.test(r.type)) {
          out.push(r);
          continue;
        }
        const key = `${r.type} ${r.version}`;
        let g = groups.get(key);
        if (!g) {
          g = { type: r.type, version: r.version, count: 0, object_ids: [] };
          groups.set(key, g);
          out.push(g);
        }
        g.count++;
        g.object_ids.push(r.object_id);
      }
      return [kind, out.map((r) => ("count" in r && r.count === 1 ? { object_id: r.object_ids[0], type: r.type, version: r.version } : r))];
    }),
  );
}


/**
 * Curated-only resolver for object types, matching what `trace.ts` passes at
 * its own `readGrpcObjectChanges` call site. The display tier includes MVR
 * names anyone can register, and this resolver gates a `defi-position`
 * promotion rather than only naming something.
 */
function protocolForObjectType(packageId: string): { name: string } | null {
  const p = lookupProtocol(packageId);
  return p ? { name: p.name } : null;
}

interface QueriedTx {
  digest: string;
  sender?: { address: string };
  gasInput?: { gasSponsor?: { address: string } | null };
  kind?: { commands?: GqlConnection<GqlCommandNode> };
  effects?: {
    status: string;
    gasEffects?: {
      gasSummary?: {
        computationCost: string;
        storageCost: string;
        storageRebate: string;
      };
    };
    checkpoint?: { sequenceNumber: number };
    timestamp?: string;
  };
}

/**
 * Aliased version connections per request. The service refuses a document of
 * more than 300 query nodes, and each alias repeats the fragment: about 26
 * nodes each, 38 with commands selected. 10 aliases fit under the limit
 * without commands and 5 with them.
 */
const versionAliasesPerRequest = (includeFunctions: boolean) => (includeFunctions ? 5 : 10);

function queriedTxFragment(includeFunctions: boolean): string {
  // Commands are only selected on request: they multiply response size on a
  // page of 50, and most callers only want the digest list.
  const kind = includeFunctions ? `kind { ... on ProgrammableTransaction { ${COMMANDS_SELECTION} } }` : "";
  return `fragment T on Transaction { digest sender { address } gasInput { gasSponsor { address } } ${kind} effects { status gasEffects { gasSummary { computationCost storageCost storageRebate } } checkpoint { sequenceNumber } timestamp } }`;
}

/**
 * Read one page per package version with aliased connections, `fn`'s package
 * swapped for each version's address.
 */
async function readVersionPages(
  streams: VersionStream[],
  filter: Record<string, unknown>,
  fn: string,
  order: ListOrder,
  size: number,
  includeFunctions: boolean,
): Promise<Array<VersionPage<QueriedTx> | null>> {
  const rest = fn.split("::").slice(1);
  const pages: Array<VersionPage<QueriedTx> | null> = streams.map(() => null);
  const active = streams.map((s, i) => ({ s, i })).filter(({ s }) => !s.done);
  const perRequest = versionAliasesPerRequest(includeFunctions);
  for (let start = 0; start < active.length; start += perRequest) {
    const chunk = active.slice(start, start + perRequest);
    const decls = chunk.map((_, k) => `$f${k}: TransactionFilter, $c${k}: String`).join(", ");
    const paging = order === "newest" ? (k: number) => `last: $n, before: $c${k}` : (k: number) => `first: $n, after: $c${k}`;
    const fields = chunk
      .map((_, k) => `v${k}: transactions(filter: $f${k}, ${paging(k)}) { edges { cursor node { ...T } } ${BOTH_WAYS_PAGE_INFO} }`)
      .join(" ");
    const variables: Record<string, unknown> = { n: size };
    chunk.forEach(({ s }, k) => {
      variables[`f${k}`] = { ...filter, function: [s.address, ...rest].join("::") };
      variables[`c${k}`] = s.cursor;
    });
    const r = await gqlQuery<Record<string, { edges: Array<{ cursor: string; node: QueriedTx }>; pageInfo: BothWaysPageInfo } | null>>(
      `query ($n: Int, ${decls}) { ${fields} } ${queriedTxFragment(includeFunctions)}`,
      variables,
    );
    chunk.forEach(({ i }, k) => {
      const conn = r[`v${k}`];
      if (!conn) return;
      pages[i] = {
        edges: conn.edges,
        hasMore: order === "newest" ? conn.pageInfo.hasPreviousPage : conn.pageInfo.hasNextPage,
      };
    });
  }
  return pages;
}

/** One object movement as `get_transaction` reports it. */
function movementOut(m: ObjectMovement) {
  return {
    object_id: m.object_id,
    type: m.type_short ?? m.type,
    kind: m.kind,
    // The owner kind travels with the address. A kiosk-held NFT is owned by
    // the Kiosk object, and a bare address would read a kiosk id as a wallet.
    // `trace.ts` renders the same movement as "kiosk/object 0x…" and the two
    // tools must not disagree about who a party is.
    from: m.from ? { kind: m.from.kind, address: m.from.address } : null,
    to: m.to ? { kind: m.to.kind, address: m.to.address } : null,
    category: m.category,
    ...(m.high_consequence ? { high_consequence: true } : {}),
    ...(m.renounced ? { renounced: true } : {}),
    ...(m.opened ? { opened: true } : {}),
    ...(m.source_unrecorded ? { source_unrecorded: true } : {}),
    ...(m.protocol ? { protocol: m.protocol } : {}),
    // The note states what a capability actually grants. `high_consequence:
    // true` alone says a finding exists without saying what it is, and
    // `trace.ts` carries the full movement for exactly this reason.
    ...(m.note ? { note: m.note } : {}),
  };
}

/**
 * An event that places an order which can rest on the book: its struct name
 * mentions both placing and an order (DeepBook's OrderPlaced, a wrapper's
 * PlaceLimitOrderEvent). A taker order filled at once emits OrderFilled and
 * no OrderPlaced; a wrapper event that says its order was not put on the
 * book (`maker_injected` false) does not count.
 */
function placesOrder(eventType: string | undefined, json: unknown): boolean {
  const name = eventType?.split("<")[0]!.split("::").at(-1) ?? "";
  if (!/order/i.test(name) || !/place/i.test(name)) return false;
  return !(json !== null && typeof json === "object" && (json as Record<string, unknown>).maker_injected === false);
}

export function registerTransactionTools(server: McpServer) {
  server.tool(
    "get_transaction",
    "Get a Sui transaction by its digest. Returns sender, status, gas, balance changes, protocol-aware decoded actions (e.g. 'swap on Cetus', 'deposit on Suilend'), and events WITH their decoded fields — so there is no need to hand-write GraphQL to read an event's values. An event field holding a number in the top half of the u256 range also gets its two's-complement reading under `signed_readings` (a signed fee or PnL stored unsigned), and with detail: 'full' a u64, u128 or u256 pure value with its top bit set carries `signed_value`Protocols are identified from the events as well as the Move calls, which matters when a transaction calls an obfuscated wrapper: `protocols_from_events_only` marks that case. A package with no curated or Move Registry name is named after the curated protocol whose key published it (`protocols_unchecked` lists packages whose publisher was not read), and a `balance_changes` row whose address signed a curated protocol's packages carries `publisher_key_of`, which shows a fee paid to that team's keyFunds can move without any coin object: `address_balance_ops` lists every deposit to and withdrawal from an address balance, `funds_withdrawals` the address-balance withdrawals the transaction requested, and `gas_source` whether gas came from coins or the gas owner's address balance. `created_for` lists objects minted to someone other than the sender; coins are never listed there, and when no other object moved `coins_delivered_to` names the addresses other than the sender that gained coins. `mutated_capabilities` lists a sender-owned capability the call mutated in place (a nonce, a rate limit) without changing its owner — the authorising capability itself, present even when nothing changed hands. `route_loops` appears when a router path swaps a coin away and back within the route (USDC → USDT → USDC before the real hop): the `actions` indices of the loop, its coins, and what the round trip cost by the pools' own swap events, or null with the reason. Pass detail: 'full' for the PTB's inputs, each command's arguments resolved (the object with its version and type, a pure value decoded with the called function's declared type, the command a Result came from) and the id and type of every changed object by kind.",
    {
      digest: z.string().describe("Transaction digest (Base58)"),
      max_event_field_bytes: numArg()
        .int()
        .min(0)
        .max(500_000)
        .optional()
        .describe(
          "Optional byte cap on decoded event fields. UNSET BY DEFAULT: every event is decoded. Past about 20k characters the summary view folds events that differ only in amounts into one row (count, emission indices, shared fields, and each varying field's total, min and max) and caps the rows, keeping every event a non-framework package the transaction called emitted; `omitted` says so, and detail: 'full' lists every event. Set this only when you knowingly want to bound the payload — anything skipped is reported — or set 0 to skip decoding entirely.",
        ),
      detail: z
        .enum(["summary", "full"])
        .optional()
        .describe(
          "'summary' (default): object_changes as counts, and no inputs or commands; created_for, object_transfers, balance_changes and coins_delivered_to list what fits about 20k characters, every capability, the sender's changes and each coin's largest credit and debit first, and `omitted` states the rest. 'full' lists every row and adds the PTB's `inputs` (object id, version read and type; pure values decoded with the type the called function declares), `commands` with every argument resolved (an input's object or value, the command a Result came from, the gas coin), paged at about 30k characters with Move calls into non-framework packages kept first, and object_changes.by_kind: every changed object's id, type and version, grouped as created, mutated, unwrapped, wrapped and deleted.",
        ),
      commands: z
        .array(numArg().int().min(0))
        .max(100)
        .optional()
        .describe("With detail: 'full', exact command indices to list, e.g. [3, 7], instead of the first page. Events and object changes narrow to those commands where the transaction attributes them (an event to the Move call that emitted it, an object to the commands that take it or return its type); `events_omitted` and `object_changes_omitted` state what was left out."),
      event_offset: numArg()
        .int()
        .min(0)
        .optional()
        .describe("With detail: 'full', the position in the listed events (after any `commands` narrowing) to start the event page at. The full view lists about 40k characters of events per page, and `events_page.next_call` carries the next offset."),
    },
    async ({ digest: rawDigest, max_event_field_bytes, detail, commands: pick, event_offset }) => {
      const full = detail === "full" || pick !== undefined;
      const digest = normalizeDigest(rawDigest);
      // Decoded fields are not rationed by default: every event is decoded,
      // and the summary view folds and caps the list only past
      // EVENT_FOLD_BUDGET, saying so under `omitted`. Rationing the fields
      // themselves is the caller's call to make.
      const fieldBudget = max_event_field_bytes ?? Number.POSITIVE_INFINITY;

      // Checked here so a typo comes back as "that is not a digest" rather than
      // a thrown transport error about Base58, and so it is never mistaken for
      // the transaction not existing. get_transactions checks the same way.
      if (!isDigest(digest)) return errorResult(invalidDigestMessage(digest));

      const req = {
        digest,
        readMask: {
          paths: [
            "digest", "transaction", "effects", "events",
            "checkpoint", "timestamp", "balance_changes",
            // Who authorised this transaction. For a multisig this is the only
            // place the per-transaction signer set exists: the committee is
            // fixed, but WHICH members signed varies transaction to
            // transaction, and that is the question a treasury drain asks.
            "signatures",
            // The type of an input the effects do not list (an immutable one).
            ...(full ? EXECUTED_OBJECT_PATHS : []),
          ],
        },
      };
      // Pruned digests come back as a NOT_FOUND throw, which the helper's catch
      // path routes to the archive. The emptiness predicate is belt-and-braces.
      const res: GrpcTypes.GetTransactionResponse = await withArchiveFallback(
        (client) => client.ledgerService.getTransaction(req),
        (r) => !r.transaction,
      );

      const tx = res.transaction;
      const effects = tx?.effects;
      const transaction = tx?.transaction;
      const kind = transaction?.kind;
      const sender = transaction?.sender;

      // Protocol-aware decoding.
      //
      // `commandCount` is reported because an empty `actions` array has more
      // than one cause: a transaction that ran no commands, and commands that
      // could not be decoded. An empty PTB carries `commands` as an empty
      // array, so the count is real rather than inferred from its absence.
      //
      // `kindUnreadable` covers a third case: a transaction present in the
      // response with no readable kind. A nonexistent or pruned digest throws
      // NOT_FOUND instead and never reaches here. The case is labelled so an
      // empty `actions` never stands for it silently.
      let decoded;
      let commandCount: number | null = null;
      let kindUnreadable = false;
      let calledPackages: string[] = [];
      // Protocols the EVENTS implicate, which the call targets can miss
      // entirely. Both the defining package of each event type and the emitting
      // package are resolved: the definer is the informative one when a wrapper
      // is in play, the emitter is worth naming when it happens to be known.
      const eventPackages = [
        ...new Set(
          (tx?.events?.events ?? [])
            .flatMap((e: GrpcTypes.Event) => [packageOfEventType(e.eventType), e.packageId ?? null])
            .filter((p): p is string => Boolean(p)),
        ),
      ];
      // Publishers of the called and event packages, in the same request, so a
      // package a curated protocol's key published is named as in
      // analyze_attack_tx and decode_ptb.
      let publishers: ProtocolCustodyRead | null = null;
      if (kind?.data.oneofKind === "programmableTransaction") {
        const ptb = kind.data.programmableTransaction;
        commandCount = ptb.commands?.length ?? 0;
        calledPackages = collectPackageIds(ptb.commands);
        await prefetchProtocolNames([...calledPackages, ...eventPackages]);
        publishers = await readProtocolCustody([...calledPackages, ...eventPackages]);
        await prefetchCoinScale((tx?.balanceChanges ?? []).map((bc) => bc.coinType).filter((t): t is string => !!t));
        decoded = decodeTransaction(ptb.commands, tx?.balanceChanges, sender, { custodyFor: publishers.custodyFor });
      } else if (kind?.data.oneofKind) {
        decoded = {
          protocols: [] as string[],
          actions: [`System transaction: ${kind.data.oneofKind}`],
          token_flow: [] as { coin: string; amount: string; raw_type: string }[],
          route_hops: [] as RouteHop[],
        };
      } else {
        kindUnreadable = true;
        decoded = {
          protocols: [] as string[],
          actions: [] as string[],
          token_flow: [] as { coin: string; amount: string; raw_type: string }[],
          route_hops: [] as RouteHop[],
        };
      }

      // What the transaction touched, which is the only evidence that anything
      // happened when it moved no coin and ran no command. The response
      // already carries `changedObjects`, so this reads data already paid for.
      //
      // `lookupProtocol`, not the display resolver: `readGrpcObjectChanges`
      // uses it to promote a type to `defi-position`, which may only happen
      // behind a curated vouch. `trace.ts` passes the curated one at its own
      // call site and the two must not disagree.
      const changedObjects = effects?.changedObjects ?? [];
      const objectMovements = readGrpcObjectChanges(changedObjects, protocolForObjectType);
      const custody = custodyChanges(objectMovements);
      const deliveredOnCreation = createdFor(objectMovements, sender);
      // Coins never appear in `custody` or `deliveredOnCreation`: they are
      // tracked by balance change. When nothing else moved, "no object changed
      // custody" is still false for a coin created for someone else, which is
      // how a drain pays its beneficiary. A gas payer's storage rebate is not
      // a delivery.
      const coinRecipients = [
        ...new Set(
          (tx?.balanceChanges ?? [])
            .filter(
              (bc) =>
                bc.address &&
                bc.address !== sender &&
                BigInt(bc.amount ?? "0") > 0n &&
                !isSponsorGasChange(bc.address, bc.coinType ?? "", sender, transaction?.gasPayment?.owner),
            )
            .map((bc) => bc.address!),
        ),
      ];
      // Capabilities that authorised this call by mutating themselves in
      // place (a nonce, a rate limit) rather than changing hands. Neither
      // `custody` nor `deliveredOnCreation` sees these, since both require an
      // owner change, so this is the only place a privileged call names the
      // capability that authorised it.
      const mutatedCaps = mutatedCapabilities(changedObjects, protocolForObjectType);
      const objectSummary = summarizeObjectChanges(changedObjects);
      // Address balances hold funds without a coin object, so what they did is
      // read from the accumulator writes and the transaction's inputs. Both
      // ride the response already fetched.
      const addressBalanceOps = readAddressBalanceOps(changedObjects);
      const ptbInputs =
        kind?.data.oneofKind === "programmableTransaction"
          ? kind.data.programmableTransaction.inputs ?? []
          : [];
      const fundsWithdrawals = readFundsWithdrawals(ptbInputs);
      const gas =
        kind?.data.oneofKind === "programmableTransaction" && transaction?.gasPayment
          ? gasSource(transaction.gasPayment.objects ?? [])
          : null;

      // The PTB with every argument resolved, read from the transaction's own
      // BCS by the resolver decode_ptb uses, so the two tools describe a PTB
      // the same way.
      let resolved: ResolvedPtb | null = null;
      let unresolvedReason: string | null = null;
      if (full && kind?.data.oneofKind === "programmableTransaction") {
        const bcsValue = transaction?.bcs?.value;
        try {
          const read = bcsValue ? ptbDataFromBcs(new Uint8Array(bcsValue)) : null;
          if (read?.data) resolved = await resolvePtb(read.data, executedObjects(tx));
          else if (read === null) unresolvedReason = "The response carried no transaction bytes to decode the PTB from.";
          else unresolvedReason = read.unread ?? "The transaction bytes hold no programmable PTB.";
        } catch (err) {
          unresolvedReason = `The transaction bytes did not decode: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      // Who authorised this transaction. The gRPC `UserSignature` carries the
      // signature's own BCS, so the shared parser handles it and one code path
      // covers both transports. Roles are assigned by derivation: a signature
      // that derives to neither the sender nor the gas sponsor authorized in
      // the sender's place (an address alias or a protocol-level substitution).
      const signers = assignSignerRoles(
        sender,
        transaction?.gasPayment?.owner,
        (tx?.signatures ?? [])
          .map((s) => (s.bcs?.value ? Buffer.from(s.bcs.value).toString("base64") : ""))
          .filter(Boolean),
      );
      const authorization = signers.signatures.map((sig) => ({
        role: sig.role,
        scheme: sig.scheme,
        ...(sig.address ? { address: sig.address } : {}),
        ...(sig.multisig
          ? {
              multisig: {
                shape: sig.multisig.members.every((m) => m.weight === 1)
                  ? `${sig.multisig.threshold}-of-${sig.multisig.members.length}`
                  : `threshold ${sig.multisig.threshold} of ${sig.multisig.total_weight} weight`,
                threshold: sig.multisig.threshold,
                // The point of reading signatures per transaction: WHICH keys
                // authorised THIS one. The committee is fixed for the life of
                // the address, so this is the only thing that varies.
                signed_by: sig.multisig.members
                  .filter((m) => m.signed_source_tx)
                  .map((m) => ({ index: m.index, address: m.address, weight: m.weight })),
                did_not_sign: sig.multisig.members
                  .filter((m) => !m.signed_source_tx)
                  .map((m) => ({ index: m.index, address: m.address, weight: m.weight })),
              },
            }
          : {}),
        ...(sig.zklogin ? { zklogin: sig.zklogin } : {}),
      }));

      const rawEvents = tx?.events?.events ?? [];

      // Decoded event contents, which gRPC does not carry. One extra request,
      // and only when there is something to decode.
      const parsed =
        rawEvents.length > 0 && fieldBudget > 0 ? await fetchEventJson(digest) : null;
      // Joined by position, which is emission order on both transports. Guarded
      // on length: attaching fields from a mismatched list would put one event's
      // values under another's type, which is worse than omitting them.
      const parsedUsable = parsed !== null && parsed.length === rawEvents.length;

      // Decoded fields are attached in order until a byte budget is spent.
      //
      // The budget bounds the caller's context: an event-heavy transaction can
      // carry tens of kilobytes of decoded fields, and a multi-hop trace would
      // spend its whole budget on event bodies. Types and senders are cheap and
      // always useful, so they are never dropped; only the decoded values are
      // rationed, and what was skipped is reported rather than silently missing.
      let spent = 0;
      let fieldsOmitted = 0;
      const events = rawEvents.map((e: GrpcTypes.Event, i: number) => {
        const base = {
          package_id: e.packageId,
          module: e.module,
          event_type: e.eventType,
          sender: e.sender,
        };
        if (!parsedUsable) {
          // A zero budget skips the lookup entirely, and every event counts
          // as omitted: the reader asked for no fields, not for no disclosure.
          if (fieldBudget === 0) fieldsOmitted++;
          return base;
        }
        const json = parsed![i].json;
        const size = JSON.stringify(json ?? null).length;
        if (spent + size > fieldBudget) {
          fieldsOmitted++;
          return base;
        }
        spent += size;
        // A number in the top half of the u256 range is a signed value's two's
        // complement far more often than an amount; its reading goes beside it.
        const signed = signedFieldReadings(json);
        return { ...base, parsed: json, ...(signed ? { signed_readings: signed } : {}) };
      });
      const orderEvents = rawEvents.some((e, i) => placesOrder(e.eventType, parsedUsable ? parsed![i].json : null));

      if (eventPackages.length > 0) await prefetchProtocolNames(eventPackages);
      const fromEvents = [
        ...new Set(
          eventPackages
            .map((p) => lookupProtocolDisplay(p, { custody: publishers?.custodyFor.has(normalizeSuiAddress(p)) ?? false })?.name)
            .filter((n): n is string => Boolean(n)),
        ),
      ];
      // Named by their events but not by their calls. Reported separately
      // rather than folded in, because the gap is itself the finding: a
      // transaction whose calls are unreadable and whose events name a known
      // protocol is what a wrapper or router looks like.
      const onlyFromEvents = fromEvents.filter((n) => !decoded.protocols.includes(n));
      const allProtocols = [...new Set([...decoded.protocols, ...fromEvents])];
      const balanceChanges = tx?.balanceChanges?.map((bc: GrpcTypes.BalanceChange) => {
        const signed = bc.address ? protocolsSignedBy(bc.address) : [];
        return {
          address: bc.address,
          coin_type: bc.coinType,
          amount: bc.amount,
          ...(signed.length ? { publisher_key_of: signed } : {}),
        };
      });
      const custodyUnread = publishers ? originIncomplete(publishers.unread) : null;
      // Round trips inside a router path and what each cost, from the pools'
      // own swap events in this response. Absent when no path loops or the
      // transaction failed, since a failed one's swaps were reverted.
      const succeeded = effects?.status?.success === true;
      const loops = succeeded ? routeLoops(decoded.route_hops) : [];
      if (loops.length) await prefetchCoinScale(loops.map((l) => l.hops[0].coin_in));
      const routeLoopReports = describeRouteLoops(loops, decoded.route_hops, {
        success: succeeded,
        commands: kind?.data.oneofKind === "programmableTransaction" ? kind.data.programmableTransaction.commands : [],
        events:
          rawEvents.length === 0
            ? []
            : parsedUsable
              ? rawEvents.map((e, i) => ({ type: e.eventType ?? "", package_id: e.packageId, module: e.module, json: parsed![i].json }))
              : { unread: fieldBudget === 0 ? "max_event_field_bytes: 0 skipped the event fields" : "the transaction's event fields could not be read" },
        objects: changedObjects,
      });

      const body: Record<string, unknown> = {
        digest: tx?.digest,
        sender,
        status: formatStatus(effects?.status),
        // Why it failed, from data already in `effects`. Absent on
        // success, so a reader never has to check a field that says
        // nothing.
        ...(describeFailure(effects?.status)
          ? { failure: describeFailure(effects?.status) }
          : {}),
        timestamp: timestampToIso(tx?.timestamp),
        protocols: allProtocols,
        ...(onlyFromEvents.length
          ? {
              protocols_from_events_only: onlyFromEvents,
              protocol_attribution_note:
                "These protocols were identified from the transaction's EVENTS, not its Move calls — the calls alone did not name them. That gap is usually a wrapper or router package sitting in front of the real protocol, which is worth a look: a package chooses its own name, but the events it emits carry the type of whoever defined them.",
            }
          : {}),
        ...(custodyUnread
          ? {
              protocols_unchecked: {
                ...custodyUnread,
                note: PROTOCOLS_UNCHECKED_NOTE,
              },
            }
          : {}),
        ...(balanceChanges?.some((b) => "publisher_key_of" in b)
          ? {
              publisher_key_note:
                "A balance_changes row with publisher_key_of belongs to an address that published or upgraded that curated protocol's packages, so the coins moved to or from that team's key. It says whose key it is, not why the coins moved.",
            }
          : {}),
        actions: decoded.actions,
        ...(commandCount !== null ? { command_count: commandCount } : {}),
        ...(routeLoopReports.length ? { route_loops: routeLoopReports } : {}),
        ...(resolved
          ? {
              // Filled below, once the rest of the response is sized.
              commands: [],
              commands_omitted: undefined,
              inputs: resolved.inputs,
              ...(resolved.signatures_unavailable.length
                ? {
                    signatures_unavailable: resolved.signatures_unavailable,
                    signatures_unavailable_note:
                      "The signatures of these Move functions could not be read, so their pure arguments are shown as bytes and their results carry no declared type.",
                  }
                : {}),
            }
          : {}),
        ...(unresolvedReason ? { inputs_unavailable: unresolvedReason } : {}),
        // The default view moves inputs and object ids behind an
        // argument; the response names it so nothing is silently absent.
        ...(!full && commandCount
          ? {
              detail_note:
                "Pass detail: 'full' for each command's resolved arguments, the PTB's inputs, and the id and type of every changed object that object_changes counts.",
            }
          : {}),
        // Stated outright, because an empty `actions` would
        // otherwise cover this case, a decode failure and an
        // unreadable kind alike.
        ...(commandCount === 0
          ? {
              empty_transaction_note:
                "This transaction ran no commands, which is not a decode failure: it executed and committed, and its only on-chain effect is whatever object_changes and object_transfers report below. Read those before concluding nothing happened. An empty transaction is used to advance the version of whatever object paid for it, and to publish a sender's public key for the first time.",
            }
          : {}),
        ...(kindUnreadable
          ? {
              kind_unreadable_note:
                "The transaction kind could not be read, so no actions could be derived. That is a failed read, NOT a transaction that did nothing — do not report it as inactivity.",
            }
          : {}),
        token_flow: decoded.token_flow,
        // Reported always, because "no coin moved" is only an absence
        // of value when nothing else moved either. A balance change
        // nets coins and address balances, so an NFT, a capability or
        // a DeFi position changes hands without producing one.
        object_changes: full ? { ...objectSummary, by_kind: listObjectChanges(changedObjects) } : objectSummary,
        // The two counts describe different universes and a reader
        // comparing them would otherwise be misled. `changed` counts
        // every object effect, including the coin that paid and any
        // dynamic field the transaction walked; `object_transfers`
        // keeps only what changed hands. Address-balance writes are
        // not objects and are not counted.
        ...(objectSummary.changed > 0 && custody.length === 0 && deliveredOnCreation.length === 0
          ? coinRecipients.length
            ? {
                coins_delivered_to: coinRecipients,
                object_changes_note:
                  "No object other than a coin changed custody here (object_transfers and created_for are both empty, and coins are never listed there). Coins did: every address in coins_delivered_to, other than the sender, gained coins in this transaction, and balance_changes has the amounts. `changed` also counts the coin that paid for the transaction, any dynamic field it touched, and a capability mutated in place without changing hands (see mutated_capabilities below if present).",
              }
            : {
                object_changes_note:
                  "No object changed custody here (object_transfers and created_for are both empty). `changed` counts every object effect, including the coin that paid for the transaction, any dynamic field it touched, and a capability mutated in place without changing hands (see mutated_capabilities below if present), so a non-zero count here is not by itself evidence that anything of value moved. Coins are tracked in balance_changes instead, not here.",
              }
          : {}),
        ...(custody.length ? { object_transfers: custody.map(movementOut) } : {}),
        ...(deliveredOnCreation.length
          ? {
              created_for: deliveredOnCreation.map(movementOut),
              created_for_note:
                "These objects were created in this transaction and handed to an owner other than the sender. A mint delivered to someone else moves no coin, so it produces no balance change. A newly created COIN delivered to someone else is not listed here: it is tracked in balance_changes instead, which covers every coin regardless of who receives it.",
            }
          : {}),
        ...(mutatedCaps.length
          ? {
              mutated_capabilities: mutatedCaps.map(movementOut),
              mutated_capabilities_note:
                "These capabilities were mutated (version bumped) without changing owner, which is how a privileged call authorises itself without moving custody. They do not appear in object_transfers or created_for because custody did not change; this is the only place the transaction names which capability it used.",
            }
          : {}),
        ...(addressBalanceOps.length ? { address_balance_ops: addressBalanceOps } : {}),
        ...(fundsWithdrawals.length
          ? {
              funds_withdrawals: fundsWithdrawals,
              funds_withdrawals_note:
                "Each entry is an input authorising a withdrawal from the sender's or the gas sponsor's address balance, up to `amount`. What was actually withdrawn is in address_balance_ops and balance_changes.",
            }
          : {}),
        ...(authorization.length ? { authorization } : {}),
        ...(signers.signer_is_sender === false
          ? {
              signer_is_sender: false,
              authorized_by: signers.authorized_by,
              signer_note:
                "The sender's own key did not sign this transaction. It was authorized by the address(es) in authorized_by, acting for the sender through an address alias or a protocol-level substitution, so it is not evidence of what the sender's owner did.",
            }
          : {}),
        ...(authorization.some((a) => a.multisig)
          ? {
              authorization_note:
                "This transaction was authorised by a multisig. `signed_by` is the set of keys that signed THIS transaction — the committee itself is fixed for the life of the address, so a member under `did_not_sign` is still authorised and may have signed others. Use analyze_multisig for which keys are live across the wallet's history.",
            }
          : {}),
        gas: formatGas(effects?.gasUsed),
        ...(gas ? { gas_source: gas.source, ...(gas.coins.length ? { gas_coins: gas.coins } : {}) } : {}),
        epoch: bigintToString(effects?.epoch),
        checkpoint: bigintToString(tx?.checkpoint),
        event_count: events.length,
        ...(orderEvents
          ? {
              order_events_note:
                "Order events here describe this transaction only: a filled amount is what matched in it. An order that rests on the book fills later in other traders' transactions, which do not touch the owner's account object, so this transaction cannot say whether the order has filled, been cancelled or been withdrawn since. query_transactions with affected_object set to the account object (the event's owner or balance manager) and after_checkpoint set to this checkpoint lists the owner's later transactions with it, such as a cancel or a withdrawal.",
            }
          : {}),
        ...(fieldsOmitted
          ? {
              event_fields_omitted: fieldsOmitted,
              event_fields_budget_note: fieldBudget === 0
                ? `Decoded fields for all ${fieldsOmitted} event(s) were skipped because you set max_event_field_bytes=0. Their types and senders are still listed. Remove the cap to see them; this response is NOT the complete event data.`
                : `Decoded fields for ${fieldsOmitted} event(s) were omitted because you set max_event_field_bytes=${fieldBudget} and it was spent. Their types and senders are still listed. Remove the cap to see them — this response is NOT the complete event data.`,
            }
          : {}),
        ...(rawEvents.length > 0 && fieldBudget > 0 && !parsedUsable
          ? {
              event_fields_note:
                "Decoded event fields could not be attached — the parsed-contents lookup failed or returned a different number of events, and guessing the alignment would file one event's values under another's type. Event types and senders below are unaffected.",
            }
          : {}),
        events,
        balance_changes: balanceChanges,
      };
      if (Array.isArray(body.created_for)) body.created_for_count = body.created_for.length;
      if (balanceChanges?.length) body.balance_change_count = balanceChanges.length;

      if (full) {
        const stored: Record<string, unknown> = resolved ? { ...body, commands: resolved.commands } : { ...body };
        const paged: Record<string, number[]> = {};
        let chosen: Array<Record<string, unknown>> | null = null;
        let commandsOmitted: CommandsOmitted | null = null;
        if (resolved) {
          const { page, omitted, missing } = selectCommands(resolved.commands, { indices: pick });
          body.commands = page;
          if (missing.length) body.commands_not_found = missing;
          if (omitted || pick) paged.commands = page.map((c) => c.index as number);
          if (pick) chosen = page;
          commandsOmitted = omitted;
        }

        // Each event names the command that emitted it, or the commands it
        // can have come from, and every changed object keeps its row.
        const byCommand = resolved ? eventCommands(events, resolved.commands) : null;
        const eventRows = byCommand
          ? events.map((e, i) => ({ ...e, ...(byCommand[i].length === 1 ? { command: byCommand[i][0] } : { commands: byCommand[i] }) }))
          : events;
        const eventIndex = new Map<unknown, number>(eventRows.map((e, i) => [e, i]));
        const allChanges = listObjectChanges(changedObjects);
        stored.events = eventRows;
        stored.object_changes = { ...objectSummary, by_kind: allChanges };

        let shownEvents = eventRows;
        let shownChanges = allChanges;
        if (chosen) {
          const picked = new Set(chosen.map((c) => c.index as number));
          if (byCommand) {
            shownEvents = eventRows.filter((_, i) => byCommand[i].some((c) => picked.has(c)));
            const leftFrom = [...new Set(byCommand.filter((cs) => !cs.some((c) => picked.has(c))).flat())].sort((a, b) => a - b);
            if (shownEvents.length < eventRows.length) {
              paged.events = shownEvents.map((e) => eventIndex.get(e)!);
              body.events_omitted = {
                count: eventRows.length - shownEvents.length,
                from_commands: leftFrom,
                // Without `commands` every event is listed, paged by position.
                next_call: { tool: "get_transaction", args: { digest, detail: "full" } },
              };
            }
          } else if (eventRows.length) {
            body.events_not_narrowed = "The events could not be matched to the commands in emission order, so every event is listed.";
          }
          // The PTB's inputs narrow to those the chosen commands take, each
          // with its index.
          const used = new Set(chosen.flatMap(commandInputIndices));
          if (resolved && used.size < resolved.inputs.length) {
            body.inputs = resolved.inputs.flatMap((input, index) => (used.has(index) ? [{ index, ...input }] : []));
            paged.inputs = [...used].sort((a, b) => a - b);
            body.inputs_omitted = { count: resolved.inputs.length - used.size, next_call: { tool: "get_transaction", args: { digest, detail: "full" } } };
          }
          const belongs = objectMatcher(chosen);
          const left: Record<string, number> = {};
          shownChanges = Object.fromEntries(
            Object.entries(allChanges).map(([kind, rows]) => {
              const kept = rows.filter((r) => belongs(r, kind));
              if (kept.length < rows.length) {
                left[kind] = rows.length - kept.length;
                paged[`object_changes.by_kind.${kind}`] = rows.flatMap((r, i) => (kept.includes(r) ? [i] : []));
              }
              return [kind, kept];
            }),
          );
          if (Object.keys(left).length) {
            body.object_changes_omitted = {
              count: Object.values(left).reduce((s, n) => s + n, 0),
              by_kind: left,
              note: "Changed objects none of these commands takes as an argument, and created objects of a type none of them returns. A dynamic field reached inside a call is never an argument, so it is listed only without `commands`.",
              next_call: { tool: "get_transaction", args: { digest, detail: "full" } },
            };
          }
        }
        body.object_changes = { ...objectSummary, by_kind: foldFieldChanges(shownChanges) };

        // Events page by position in the listed events, so every event is
        // one call away however many a single command emitted, with or
        // without the store.
        const offset = event_offset ?? 0;
        const eventPage = pageAt(shownEvents, offset, FULL_EVENT_BUDGET);
        body.events = eventPage.rows;
        const eventsPaged = offset > 0 || eventPage.next !== null;
        if (eventsPaged) paged.events = eventPage.rows.map((e) => eventIndex.get(e)!);
        const { payload, resultId } = capPayload(
          "get_transaction",
          { digest, detail: "full", ...(pick ? { commands: pick } : {}), ...(event_offset ? { event_offset } : {}) },
          body,
          {},
          { full: false, stored, paged, next_call: { tool: "get_transaction", args: { digest, detail: "full" } } },
        );
        if (eventsPaged) {
          payload.events_page = {
            offset,
            listed: eventPage.rows.length,
            of: shownEvents.length,
            ...(eventPage.next !== null
              ? { next_call: { tool: "get_transaction", args: { digest, detail: "full", ...(pick ? { commands: pick } : {}), event_offset: eventPage.next } } }
              : {}),
            ...(resultId ? { page: resultUri(resultId, { path: "events", omitted: true }) } : {}),
          };
        }
        const out: Record<string, unknown> = {
          ...(commandsOmitted || body.events_omitted || body.object_changes_omitted || body.inputs_omitted || eventsPaged ? { truncated: true } : {}),
          ...payload,
          ...(commandsOmitted ? { commands_omitted: commandsOmittedView(commandsOmitted, digest, resultId) } : {}),
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
      }

      // The summary view caps the object and coin lists. Counts above cover
      // every row. Capabilities survive any budget, and so do, in SUI and
      // verified coins, the sender's changes and each coin's largest credit
      // and debit: a coin an impostor can mint says nothing by its amount.
      const extremes = new Set<unknown>();
      const byCoin = new Map<string, { up?: { amount: bigint; row: unknown }; down?: { amount: bigint; row: unknown } }>();
      for (const row of balanceChanges ?? []) {
        const amount = BigInt(row.amount ?? "0");
        const e = byCoin.get(row.coin_type ?? "") ?? {};
        if (amount > 0n && (!e.up || amount > e.up.amount)) e.up = { amount, row };
        if (amount < 0n && (!e.down || amount < e.down.amount)) e.down = { amount, row };
        byCoin.set(row.coin_type ?? "", e);
      }
      for (const e of byCoin.values()) for (const x of [e.up, e.down]) if (x) extremes.add(x.row);
      const trusted = (coinType: string | undefined) => Boolean(coinType) && displayCoin(coinType!).verified !== false;
      type Moved = { category?: string };
      type Change = { address?: string; coin_type?: string };
      type FoldRow = { package_id?: string; index?: number; indices?: number[]; count?: number };
      // Events past the budget fold by type and fields apart from amounts;
      // the rows then fit the cap, keeping every event a non-framework package
      // this transaction called emitted.
      const called = new Set(calledPackages.map((p) => normalizeSuiAddress(p)).filter((p) => !isPlumbingPackage(p)));
      const eventFold = JSON.stringify(events).length > EVENT_FOLD_BUDGET ? foldEvents(events) : null;
      const shown = eventFold?.folded ? { ...body, events: eventFold.rows } : body;
      const { payload } = capPayload(
        "get_transaction",
        { digest },
        shown,
        {
          events: {
            budget: EVENT_FOLD_BUDGET,
            keepOrder: true,
            keep: (e: FoldRow) => Boolean(e.package_id) && called.has(normalizeSuiAddress(e.package_id!)),
            // A folded row stands for its member events in the stored, unfolded list.
            ...(eventFold?.folded
              ? { weight: (e: FoldRow) => e.count ?? 1, covers: (e: FoldRow) => e.indices ?? [e.index!] }
              : {}),
          } satisfies ListCap<FoldRow>,
          created_for: { budget: 6_000, keepOrder: true, keep: (m: Moved) => m.category === "capability" } satisfies ListCap<Moved>,
          object_transfers: { budget: 8_000, keepOrder: true, keep: (m: Moved) => m.category === "capability" } satisfies ListCap<Moved>,
          token_flow: {
            budget: 4_000,
            keepOrder: true,
            keep: (t: { raw_type: string }) => trusted(t.raw_type),
          } satisfies ListCap<{ raw_type: string }>,
          balance_changes: {
            budget: 5_000,
            keepOrder: true,
            keep: (b: Change) => trusted(b.coin_type) && (b.address === sender || extremes.has(b)),
          } satisfies ListCap<Change>,
          coins_delivered_to: { budget: 2_000, keepOrder: true },
        },
        {
          full: false,
          stored: body,
          next_call: { tool: "get_transaction", repeat_with: { detail: "full" } },
          ...(eventFold?.folded ? { folded: { events: { entries: events.length, rows: eventFold.rows.length } } } : {}),
        },
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
    }
  );

  server.tool(
    "get_transactions",
    "Read up to 50 Sui transactions in ONE call, given their digests. Returns sender, status, timing, balance changes, Move call targets in order and events WITH their decoded fields for each, plus the protocols involved, named as get_transaction names them. Use this whenever you hold several digests at once — the outputs of a fan-out, the evidence on a cluster edge, a set of hops to compare — instead of calling get_transaction repeatedly; ten digests go from ten round trips to one. Digests that could not be read come back in `not_found` rather than being dropped. The default view lists each transaction's events, Move calls and balance changes up to its share of about 30k characters, keeping the sender's own balance changes; `event_count` and `move_call_count` count every one, and `omitted` states what each list left out, with detail: 'full' listing all. For ONE transaction, or for a transaction with more than 50 events, prefer get_transaction: it pages events to the end.",
    {
      digests: z
        .array(z.string())
        .min(1)
        .max(MAX_DIGESTS)
        .describe(`Transaction digests, Base58 (1-${MAX_DIGESTS}). Duplicates are collapsed.`),
      detail: z
        .enum(["summary", "full"])
        .optional()
        .describe("'summary' (default): each transaction's events, Move calls and balance changes fit its share of about 30k characters. 'full': every one."),
    },
    async ({ digests, detail }) => {
      try {
        const { found, not_found, invalid, packages } = await fetchTransactions(digests);
        // With no well-formed digest there is nothing to report but the
        // refusal, and a success with zero transactions reads as a lookup.
        if (invalid.length > 0 && found.length === 0 && not_found.length === 0) {
          return errorResult(
            `None of the digests is Base58: ${invalid.slice(0, 5).map((d) => JSON.stringify(d.slice(0, 60))).join(", ")}.`,
          );
        }

        // One prefetch for the whole batch, then synchronous lookups. Protocols
        // come from the Move call targets AND the event types, since a
        // transaction calling an obfuscated wrapper is named only by its events.
        // Publishers are read too, so a package a curated protocol's key
        // published is named as get_transaction names it.
        if (packages.length > 0) await prefetchProtocolNames(packages);
        const custody = await readProtocolCustody(packages);
        const custodyUnread = originIncomplete(custody.unread);
        const nameOf = (pkg: string) => lookupProtocolDisplay(pkg, { custody: custody.custodyFor.has(normalizeSuiAddress(pkg)) })?.name;
        const protocolsFor = (tx: (typeof found)[number]) => {
          const names = new Set<string>();
          for (const call of tx.move_calls) {
            const n = nameOf(call.split("::")[0]);
            if (n) names.add(n);
          }
          for (const ev of tx.events) {
            const pkg = packageOfEventType(ev.type);
            const n = pkg ? nameOf(pkg) : undefined;
            if (n) names.add(n);
          }
          return [...names];
        };

        const payload = {
          requested: digests.length,
          returned: found.length,
          ...(custodyUnread ? { protocols_unchecked: { ...custodyUnread, note: PROTOCOLS_UNCHECKED_NOTE } } : {}),
          ...(invalid.length
            ? {
                invalid_digests: invalid,
                invalid_note:
                  "These are not Base58 and were never sent. They are reported rather than silently dropped, and rejecting them here is deliberate: the server refuses an entire batch over one malformed key, so a single typo would otherwise return nothing at all.",
              }
            : {}),
          ...(not_found.length
            ? {
                not_found,
                not_found_note:
                  "These digests returned nothing from GraphQL. Do NOT read that as 'the transaction does not exist' — this batch path has no archive fallback, so a pruned transaction looks identical to a wrong digest. get_transaction DOES fall back to the archive and will often return these; retry each one there before concluding anything. Old digests are pruned continuously, so a digest that resolved minutes ago can land here.",
              }
            : {}),
          transactions: found.map((t) => ({ ...t, move_call_count: t.move_calls.length, protocols: protocolsFor(t) })),
        };
        // Each transaction's events, Move calls and balance changes share
        // the budget evenly; the sender's own changes survive it.
        const share = (total: number, floor: number) => Math.max(floor, Math.floor(total / Math.max(1, found.length)));
        type Change = { address: string };
        type Event = { type: string | null };
        const { payload: out } = capPayload(
          "get_transactions",
          { digests },
          payload,
          Object.fromEntries(
            found.flatMap((t, i) => [
              [`transactions.${i}.events`, { budget: share(14_000, 700), keepOrder: true, brief: (e: Event) => e.type } satisfies ListCap<Event>],
              [`transactions.${i}.move_calls`, { budget: share(10_000, 500), keepOrder: true } satisfies ListCap<never>],
              [
                `transactions.${i}.balance_changes`,
                { budget: share(5_000, 300), keepOrder: true, keep: (b: Change) => b.address === t.sender } satisfies ListCap<Change>,
              ],
            ]),
          ),
          { full: detail === "full", next_call: { tool: "get_transactions", repeat_with: { detail: "full" } } },
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.tool(
    "query_transactions",
    "Query raw Sui transactions with specific filters (sender, affected address/object, function, time or checkpoint range). Note: only ONE of affected_address, affected_object, or function can be used per query (Sui GraphQL limitation). Newest first by default; each page reports its `order`, `oldest_shown`/`newest_shown` and the resolved `window`, and `next_cursor` goes back as `cursor` with the same `order` and filters. For human-readable wallet activity, prefer get_transaction_history instead.\n\nVERSIONS: a `function` filter matches calls made through that exact package version, and each version of an upgraded package sees its own share of the calls. `function_scope` names the lineage when the package has other versions; `all_versions: true` reads every version as one merged list.\n\nATTRIBUTION WARNING: the `function` filter matches any transaction containing that call, including PTBs where it is one leg among several protocols. A transaction's balance changes cover the WHOLE PTB, so summing them per protocol over-attributes: a big Cetus swap in the same PTB will be counted as your protocol's volume. Set include_functions to see every Move call in each transaction, and prefer the protocol's own events (query_events) when measuring per-protocol flow.",
    {
      sender: addressArg().optional().describe("Filter by sender address"),
      affected_address: addressArg()
        .optional()
        .describe("Filter by affected address (sender, sponsor, or recipient). Mutually exclusive with affected_object and function."),
      affected_object: addressArg()
        .optional()
        .describe("Filter by affected object ID. Mutually exclusive with affected_address and function."),
      function: z
        .string()
        .optional()
        .describe("Filter by Move function (e.g. 0x2::coin::transfer or 0x2::pay). Mutually exclusive with affected_address and affected_object."),
      after_checkpoint: z
        .union([z.string(), z.number()])
        .superRefine(refinePoint)
        .optional()
        .describe("Only transactions after this point: a checkpoint number, or an ISO 8601 time (2026-08-07T00:00:00Z), which includes transactions at that time"),
      before_checkpoint: z
        .union([z.string(), z.number()])
        .superRefine(refinePoint)
        .optional()
        .describe("Only transactions before this point: a checkpoint number, or an ISO 8601 time, which includes transactions at that time"),
      order: z
        .enum(["newest", "oldest"])
        .optional()
        .describe("'newest' (default) starts at the most recent match and pages back; 'oldest' starts at the earliest and pages forward."),
      limit: numArg().int().min(1).max(50).optional().describe("Max results (default 20, max 50)"),
      cursor: z.string().optional().describe("`next_cursor` from the previous page. Pass the same `order` and filters."),
      include_functions: boolArg()
        .optional()
        .describe(
          "Return every Move call in each transaction, so you can see whether the filtered package was the whole transaction or one leg of a multi-protocol PTB. With `function`, each row adds `matched_calls` (the calls the filter names, at its own granularity: that function, that module or the whole package, through the named version or, with `all_versions`, any version) and `total_calls`.",
        ),
      all_versions: boolArg()
        .optional()
        .describe(
          "With `function`: read calls made through every version of the package's lineage, merged into one list (default false). Without it only the named version is read.",
        ),
    },
    async ({
      sender,
      affected_address,
      affected_object,
      function: fn,
      after_checkpoint,
      before_checkpoint,
      order,
      limit,
      cursor,
      include_functions,
      all_versions,
    }) => {
      // Sui GraphQL only allows one of these per query
      const exclusiveFilters = [
        affected_address && "affected_address",
        affected_object && "affected_object",
        fn && "function",
      ].filter(Boolean);

      if (exclusiveFilters.length > 1) {
        return errorResult(
          `Only one of [affected_address, affected_object, function] can be specified per query. Got: ${exclusiveFilters.join(", ")}. Use separate queries for each filter.`
        );
      }

      if (all_versions && !fn) {
        return errorResult("all_versions applies to a `function` filter. Pass function as well.");
      }

      try {
        const direction = order ?? "newest";
        const size = limit ?? 20;
        const window = await resolveWindow(after_checkpoint, before_checkpoint);

        const filterParts: Record<string, unknown> = {};
        if (sender) filterParts.sentAddress = sender;
        if (affected_address) filterParts.affectedAddress = affected_address;
        if (affected_object) filterParts.affectedObject = affected_object;
        if (fn) filterParts.function = fn;
        if (window.after?.checkpoint != null) filterParts.afterCheckpoint = window.after.checkpoint;
        if (window.before?.checkpoint != null) filterParts.beforeCheckpoint = window.before.checkpoint;

        let nodes: QueriedTx[];
        let hasNextPage: boolean;
        let nextCursor: string | null;
        let versions: PackageVersion[] | null = null;
        let functionScope: VersionScope | null = null;

        if (fn && all_versions) {
          versions = await fetchPackageVersions(fn.split("::")[0]);
        }

        if (fn && all_versions && versions && versions.length > 1) {
          const streams = cursor
            ? decodeFanoutCursor(cursor, direction)
            : versions.map((v): VersionStream => ({ address: v.address, done: false }));
          if (!streams) {
            return errorResult(
              "cursor is not an all_versions cursor for this order. Pass the next_cursor of a previous all_versions page, with the same order.",
            );
          }
          const pages = await readVersionPages(streams, filterParts, fn, direction, size, !!include_functions);
          const merged = mergeVersionPages(
            streams,
            pages,
            direction,
            size,
            (n) => n.digest,
            (n) => n.effects?.checkpoint?.sequenceNumber,
          );
          nodes = merged.nodes;
          hasNextPage = merged.has_next_page;
          nextCursor = merged.has_next_page ? encodeFanoutCursor(direction, merged.streams) : null;
        } else {
          const [data, scope] = await Promise.all([
            gqlQuery<{ transactions: { nodes: QueriedTx[]; pageInfo: BothWaysPageInfo } }>(
              `query($filter: TransactionFilter, $first: Int, $after: String, $last: Int, $before: String) {
                transactions(filter: $filter, first: $first, after: $after, last: $last, before: $before) {
                  nodes { ...T }
                  ${BOTH_WAYS_PAGE_INFO}
                }
              } ${queriedTxFragment(!!include_functions)}`,
              {
                filter: Object.keys(filterParts).length > 0 ? filterParts : undefined,
                ...orderedPageArgs(direction, size, cursor),
              },
            ),
            fn && !all_versions ? versionScopeNote(fn, "function") : Promise.resolve(null),
          ]);
          functionScope = scope;
          const page = orderedPage(data.transactions.nodes, data.transactions.pageInfo, direction);
          nodes = page.nodes;
          hasNextPage = page.has_next_page;
          nextCursor = page.next_cursor;
        }

        // Every Move call, not the first page of 50 commands: a PTB split
        // across more reads as fewer protocol legs than it has.
        const commands = include_functions
          ? await completeTxConnections(nodes.map((n) => ({ digest: n.digest, commands: n.kind?.commands })))
          : null;
        // Calls into any version of the filtered lineage count as matched,
        // narrowed to the module and function when the filter names them.
        const [fnPackage, fnModule, fnName] = fn ? fn.split("::") : [];
        const lineage = new Set(
          (versions ?? []).map((v) => normalizeSuiAddress(v.address)).concat(fnPackage ? [normalizeSuiAddress(fnPackage)] : []),
        );
        const matchesFilter = (c: GqlCommandNode) =>
          lineage.has(normalizeSuiAddress(c.function!.module.package.address)) &&
          (!fnModule || c.function!.module.name === fnModule) &&
          (!fnName || c.function!.name === fnName);

        const transactions = nodes.map((n, i) => {
          const sponsor = n.gasInput?.gasSponsor?.address ?? null;
          const callNodes = (commands?.[i].commands ?? []).filter((c) => c.function);
          const calls = callNodes.map(
            (c) => `${c.function!.module.package.address}::${c.function!.module.name}::${c.function!.name}`,
          );

          return {
            digest: n.digest,
            sender: n.sender?.address,
            status: n.effects?.status,
            checkpoint: n.effects?.checkpoint?.sequenceNumber,
            timestamp: n.effects?.timestamp,
            gas_sponsor: sponsor,
            // Sponsorship is one of the stronger coordination signals on Sui: a
            // swarm of wallets whose gas is paid by one address is not organic.
            // The sponsor equals the sender for ordinary self-paid transactions.
            gas_sponsored: sponsor !== null && sponsor !== n.sender?.address,
            ...(include_functions
              ? {
                  move_calls: foldRepeats(calls),
                  ...(commands?.[i].commandsTruncated ? { move_calls_truncated: true } : {}),
                  // How much of this PTB the filter accounts for, so
                  // over-attribution is visible instead of assumed.
                  ...(fn
                    ? {
                        matched_calls: callNodes.filter(matchesFilter).length,
                        total_calls: calls.length,
                      }
                    : {}),
                }
              : {}),
          };
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  order: direction,
                  window: describeWindow(after_checkpoint, before_checkpoint, window),
                  ...shownRange(nodes.map((n) => n.effects?.timestamp)),
                  ...(all_versions && versions
                    ? { versions_read: versions.map((v) => ({ package: v.address, version: v.version })) }
                    : {}),
                  ...(functionScope ? { function_scope: functionScope } : {}),
                  transactions,
                  has_next_page: hasNextPage,
                  next_cursor: nextCursor,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

}
