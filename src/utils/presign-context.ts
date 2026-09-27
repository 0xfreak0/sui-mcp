/**
 * Context for a pre-sign decode that sends something to another address:
 * what share of the signer's balance of each coin leaves, and whether each
 * recipient has ever appeared on chain. Bytes carry no effects, so the
 * amounts are read from the commands (a SplitCoins amount, a whole coin
 * object, the gas coin), and the balances and first appearances are read
 * now, when the decode runs.
 */

import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import { sui } from "../clients/grpc.js";
import { gqlQuery } from "../clients/graphql.js";
import { targetKey, type FormattedCommand } from "./ptb-anomalies.js";

/** Where a sent coin comes from: the gas coin, or a coin object the PTB takes as input. */
type CoinSource = { gas: true } | { object_id: string };

/** One coin or object a command hands to an address other than the sender. */
export interface PresignSend {
  command: number;
  recipient: string;
  source: CoinSource | null;
  /** Raw amount split off the source; null when the whole coin or object goes. */
  amount: string | null;
  /** For a whole-coin send: the coins merged into the source before the send, each worth its whole balance. */
  merged: CoinSource[];
}

type Arg = Record<string, unknown> & { type?: string };

/** `pay::split_and_transfer(coin, amount, recipient)`: the one framework payout that names its amount. */
const SPLIT_AND_TRANSFER = /^0x0*2::pay::split_and_transfer$/;

/** A MergeCoins destination as a key: `gas`, an input object id, or `r<command>` for an earlier result. */
function coinKey(a: Arg | undefined): string | null {
  if (a?.type === "GasCoin") return "gas";
  if (a?.type === "Input" && typeof a.object_id === "string") return normalizeSuiAddress(a.object_id);
  if (a?.type === "Result") return `r${Number(a.index)}`;
  if (a?.type === "NestedResult") return `r${Number(a.result)}.${Number(a.subresult)}`;
  return null;
}

/**
 * The sends a PTB's commands make to addresses other than `sender`: each
 * object a TransferObjects hands over, resolved to its source coin and
 * amount when it is the gas coin, a coin input, or a SplitCoins result of
 * one; and `pay::split_and_transfer`. A whole coin sent carries every coin a
 * MergeCoins before the send joined into it (`merged`), since the send hands
 * all of them over. A send from any other result, or of a coin that took in
 * anything but input coins or the gas coin, keeps `source` null.
 */
export function presignSends(commands: FormattedCommand[], sender: string): PresignSend[] {
  const self = normalizeSuiAddress(sender);
  const sourceOf = (a: Arg | undefined): CoinSource | null => {
    if (a?.type === "GasCoin") return { gas: true };
    if (a?.type === "Input" && typeof a.object_id === "string") return { object_id: a.object_id };
    return null;
  };
  const valueOf = (a: Arg | undefined) => (typeof a?.value === "string" && /^\d+$/.test(a.value) ? a.value : null);
  const out: PresignSend[] = [];
  // Per destination, what earlier MergeCoins joined into it; null once a
  // source cannot be valued (an earlier command's result).
  const mergedInto = new Map<string, CoinSource[] | null>();
  commands.forEach((c, command) => {
    if (c.type === "MergeCoins") {
      const key = coinKey(c.destination as Arg);
      if (!key) return;
      const sources = ((c.sources ?? []) as Arg[]).map(sourceOf);
      const prior = mergedInto.get(key) ?? [];
      mergedInto.set(key, prior === null || sources.some((x) => x === null) ? null : [...prior, ...(sources as CoinSource[])]);
      return;
    }
    if (c.type === "TransferObjects") {
      const to = c.address?.address;
      if (!to || normalizeSuiAddress(to) === self) return;
      for (const o of (c.objects ?? []) as Arg[]) {
        let source = sourceOf(o);
        let amount: string | null = null;
        const from = o.type === "Result" ? Number(o.index) : o.type === "NestedResult" ? Number(o.result) : null;
        const split = from !== null ? commands[from] : undefined;
        if (split?.type === "SplitCoins") {
          const amounts = ((split.amounts ?? []) as Arg[]).map(valueOf);
          const picked = o.type === "NestedResult" ? [amounts[Number(o.subresult)]] : amounts;
          source = sourceOf(split.coin as Arg);
          amount = picked.every((x) => x !== null && x !== undefined) ? picked.reduce((s, x) => s + BigInt(x!), 0n).toString() : null;
          if (amount === null) source = null;
        }
        const key = coinKey(o);
        const merged = key ? mergedInto.get(key) : undefined;
        // A split result that took in other coins is worth more than its
        // amount; a coin that took in an unvalued result cannot be valued.
        if (merged === null || (merged?.length && amount !== null)) source = null;
        out.push({ command, recipient: normalizeSuiAddress(to), source, amount, merged: source && amount === null ? (merged ?? []) : [] });
      }
    } else if (c.type === "MoveCall" && c.target && SPLIT_AND_TRANSFER.test(targetKey(c.target))) {
      const args = (c.arguments ?? []) as Arg[];
      const to = args[2]?.address;
      if (typeof to !== "string" || normalizeSuiAddress(to) === self) return;
      const amount = valueOf(args[1]);
      out.push({ command, recipient: normalizeSuiAddress(to), source: amount ? sourceOf(args[0]) : null, amount, merged: [] });
    }
  });
  return out;
}

export interface PresignContext {
  /** Per coin type, what the commands send to other addresses, against the sender's balance now. */
  coins: Array<{ coin_type: string; sent: string; sender_balance: string | null; share_of_balance: number | null }>;
  /** Objects other than coins sent whole, and sends whose amount the bytes do not state. */
  objects_sent: string[];
  unresolved_sends: number;
  /** Each recipient's first transaction on chain, null when none affects it; absent when its history could not be read (see `unread`). */
  recipients: Array<{ address: string; first_seen?: string | null; first_digest?: string | null }>;
  /** Recipients past the first {@link MAX_RECIPIENTS}, whose history was not read. */
  recipients_not_read?: number;
  /** Reads that failed, named so an absent figure is not read as zero or as a fresh address. */
  unread: string[];
  note: string;
}

const COIN_TYPE = /^0x0*2::coin::Coin<(.+)>$/;
/** Recipients whose first transaction is read: one aliased GraphQL document. */
const MAX_RECIPIENTS = 20;
const SUI = normalizeStructTag("0x2::sui::SUI");

/** Recipients' first transactions, read in one aliased GraphQL document. */
async function firstSeen(addresses: string[]): Promise<Map<string, { at: string | null; digest: string } | null>> {
  const doc =
    "query {" +
    addresses.map((a, i) => `a${i}: transactions(filter: { affectedAddress: "${a}" }, first: 1) { nodes { digest effects { timestamp } } }`).join(" ") +
    "}";
  type Page = { nodes: Array<{ digest: string; effects?: { timestamp?: string | null } | null }> };
  const res = await gqlQuery<Record<string, Page>>(doc);
  return new Map(
    addresses.map((a, i) => {
      const n = res[`a${i}`]?.nodes?.[0];
      return [a, n ? { at: n.effects?.timestamp ?? null, digest: n.digest } : null];
    }),
  );
}

/**
 * Read what the sends amount to against the sender's balances now, and when
 * each recipient first appeared. `gasCoins` are the gas payment's coin ids,
 * whose whole balance a send of the gas coin hands over (less the fee).
 */
export async function readPresignContext(sender: string, sends: PresignSend[], gasCoins: string[]): Promise<PresignContext> {
  const unread: string[] = [];
  const idsOf = (xs: Array<CoinSource | null>) => xs.flatMap((x) => (x && "object_id" in x ? [normalizeSuiAddress(x.object_id)] : []));
  const objectIds = [...new Set([...sends.flatMap((s) => idsOf([s.source, ...s.merged])), ...gasCoins.map((id) => normalizeSuiAddress(id))])];
  const allRecipients = [...new Set(sends.map((s) => s.recipient))];
  const recipients = allRecipients.slice(0, MAX_RECIPIENTS);
  const [objects, seen] = await Promise.all([
    objectIds.length
      ? sui.getObjects({ objectIds, include: { json: true } }).then(
          (r) => r.objects,
          (err: unknown) => {
            unread.push(`input objects: ${err instanceof Error ? err.message : String(err)}`);
            return [];
          },
        )
      : Promise.resolve([]),
    firstSeen(recipients).catch((err: unknown) => {
      unread.push(`recipient history: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }),
  ]);
  const coinOf = new Map<string, { coin_type: string; balance: bigint } | { object_type: string }>();
  objects.forEach((o, i) => {
    // Results come back in request order; an error is named, never valued at zero.
    if (o instanceof Error) unread.push(`object ${objectIds[i]}: ${o.message}`);
  });
  for (const o of objects) {
    if (o instanceof Error) continue;
    const coin = COIN_TYPE.exec(o.type)?.[1];
    const json: unknown = o.json;
    const balance = json && typeof json === "object" && "balance" in json ? json.balance : undefined;
    if (coin && typeof balance === "string" && /^\d+$/.test(balance)) coinOf.set(normalizeSuiAddress(o.objectId), { coin_type: normalizeStructTag(coin), balance: BigInt(balance) });
    else coinOf.set(normalizeSuiAddress(o.objectId), { object_type: o.type });
  }
  // The whole balance of each coin: the gas payment for the gas coin, the
  // object for an input; null when one of them was not read as a coin.
  const wholeBalance = (src: CoinSource): { coin_type: string; balance: bigint } | null => {
    if ("gas" in src) {
      if (!gasCoins.length) return null;
      let total = 0n;
      for (const id of gasCoins) {
        const c = coinOf.get(normalizeSuiAddress(id));
        if (!c || !("balance" in c)) return null;
        total += c.balance;
      }
      return { coin_type: SUI, balance: total };
    }
    const c = coinOf.get(normalizeSuiAddress(src.object_id));
    return c && "balance" in c ? c : null;
  };

  const sent = new Map<string, bigint>();
  const objectsSent: string[] = [];
  let unresolved = 0;
  for (const s of sends) {
    if (!s.source) {
      unresolved++;
      continue;
    }
    const src = s.source;
    if (s.amount !== null) {
      // A split names its amount; only its coin type is needed.
      const c = "object_id" in src ? coinOf.get(normalizeSuiAddress(src.object_id)) : undefined;
      const coinType = "gas" in src ? SUI : c && "balance" in c ? c.coin_type : null;
      if (coinType === null) unresolved++;
      else sent.set(coinType, (sent.get(coinType) ?? 0n) + BigInt(s.amount));
      continue;
    }
    const other = "object_id" in src ? coinOf.get(normalizeSuiAddress(src.object_id)) : undefined;
    if ("object_id" in src && other && !("balance" in other) && !s.merged.length) {
      objectsSent.push(`${src.object_id} (${other.object_type})`);
      continue;
    }
    // A whole coin hands over its balance and every coin merged into it.
    const parts = [src, ...s.merged].map(wholeBalance);
    if (parts.some((p) => p === null) || new Set(parts.map((p) => p!.coin_type)).size !== 1) {
      unresolved++;
      continue;
    }
    const coinType = parts[0]!.coin_type;
    sent.set(coinType, (sent.get(coinType) ?? 0n) + parts.reduce((t, p) => t + p!.balance, 0n));
  }

  const balances = await Promise.all(
    [...sent.keys()].map((coinType) =>
      sui.getBalance({ owner: sender, coinType }).then(
        (r) => BigInt(r.balance.balance),
        (err: unknown) => {
          unread.push(`${coinType} balance: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        },
      ),
    ),
  );
  const coins = [...sent].map(([coin_type, amount], i) => {
    const balance = balances[i];
    return {
      coin_type,
      sent: amount.toString(),
      sender_balance: balance === null ? null : balance.toString(),
      share_of_balance: balance === null || balance === 0n ? null : Number((Number(amount) / Number(balance)).toFixed(4)),
    };
  });
  return {
    coins,
    objects_sent: objectsSent,
    unresolved_sends: unresolved,
    recipients: recipients.map((address) => {
      if (!seen) return { address };
      const f = seen.get(address);
      return { address, first_seen: f?.at ?? null, first_digest: f?.digest ?? null };
    }),
    ...(allRecipients.length > recipients.length ? { recipients_not_read: allRecipients.length - recipients.length } : {}),
    unread,
    note:
      "Read now, not when the bytes were built. share_of_balance is what the commands send against the sender's whole balance of that coin today (1 is all of it; above 1 the sender no longer holds that much, so the bytes would fail as built); a whole coin sent counts its balance and every coin merged into it before the send (the gas coin: every gas payment coin), and one whose coins could not all be read is counted in unresolved_sends, never as zero. first_seen is the recipient's first transaction on chain; null with first_digest null means no transaction has ever affected that address. Neither reads the intent: an exchange deposit is also a large share to an address seen before.",
  };
}
