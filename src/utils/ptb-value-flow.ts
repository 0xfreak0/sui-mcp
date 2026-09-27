/**
 * Which calls in a resolved PTB take value in or hand value out, read from
 * the program's own data flow and the called functions' declared types.
 *
 * Value is what the signer can lose: the gas coin, an owned or receiving
 * object, a funds withdrawal from an address balance, and any coin, balance
 * or token, whether a command split it off or a call returned it. A shared
 * object passed by reference is state the call reads or writes, not value the
 * signer hands over. A call whose signature could not be read carries no
 * declared types, so its results count as value: the check assumes the
 * worse case rather than miss one.
 *
 * Pure, over the `commands` and `inputs` that `resolvePtb` (ptb-resolve.ts)
 * returns.
 */

import { normalizeSuiAddress } from "@mysten/sui/utils";
import type { FormattedCommand } from "./ptb-anomalies.js";

const FRAMEWORK = normalizeSuiAddress("0x2");
const VALUE_TYPE_PREFIXES = [`${FRAMEWORK}::coin::Coin<`, `${FRAMEWORK}::balance::Balance<`, `${FRAMEWORK}::token::Token<`];

/** Input kinds that hold the signer's own value or authority. */
const OWNED_INPUT_KINDS: Record<string, string> = {
  ImmOrOwnedObject: "an owned object",
  Receiving: "an object sent to the signer's object",
  FundsWithdrawal: "a withdrawal from an address balance",
};

/** A resolved input as `resolvePtb` lists it. */
export interface FormattedInput {
  type?: string;
  object_type?: string | null;
  mutable?: boolean;
  [k: string]: unknown;
}

type Arg = { type?: string; index?: number; result?: number; subresult?: number; address?: string; value_type?: string } & Record<string, unknown>;

/** A declared type that holds value: a coin, balance or token, or a vector of them. */
export function carriesValue(type: string): boolean {
  const inner = type.startsWith("vector<") ? type.slice("vector<".length) : type;
  return VALUE_TYPE_PREFIXES.some((p) => inner.startsWith(p));
}

/** What an argument hands the call, when that is value; null otherwise. */
function argValue(arg: Arg, commands: FormattedCommand[], inputs: FormattedInput[], depth = 0): string | null {
  if (arg.type === "GasCoin") return "the gas coin";
  if (arg.type === "Input") return OWNED_INPUT_KINDS[inputs[arg.index ?? -1]?.type ?? ""] ?? null;
  if (arg.type !== "Result" && arg.type !== "NestedResult") return null;
  const from = arg.type === "Result" ? arg.index : arg.result;
  const source = from === undefined ? undefined : commands[from];
  if (!source) return null;
  switch (source.type) {
    case "SplitCoins":
    case "MergeCoins":
      return "a coin";
    case "Publish":
      return "an UpgradeCap";
    case "MakeMoveVec":
      // Nested vectors are one level deep in any real PTB; the bound keeps a malformed one finite.
      return depth < 4 && ((source.elements as Arg[] | undefined) ?? []).some((e) => argValue(e, commands, inputs, depth + 1) !== null)
        ? "a vector of coins or objects"
        : null;
    case "MoveCall": {
      const returns = source.returns as string[] | undefined;
      if (!returns) return `a result of ${source.target} (signature unread)`;
      const declared = returns[arg.type === "Result" ? 0 : (arg.subresult ?? 0)];
      return declared !== undefined && carriesValue(declared) ? "a coin or balance" : null;
    }
    default:
      return null;
  }
}

export interface CallValue {
  /** Command index. */
  index: number;
  target: string;
  /** Why the call counts as taking value in, empty when it does not. */
  takes: string[];
  /** Why the call counts as handing value out, empty when it does not. */
  gives: string[];
}

/**
 * Value in and out of each Move call. A call hands value out when it
 * declares a coin, balance or token among its returns (or its signature is
 * unread and a later command uses its result), or when it names an address
 * other than the sender. With the transaction's effects, `gainers` lists the
 * addresses other than the sender that gained a coin or an object, and a
 * named address counts only when it is one of them; without effects, before
 * signing, any other address counts.
 */
export function callValues(
  commands: FormattedCommand[],
  inputs: FormattedInput[],
  opts: { sender?: string; gainers?: ReadonlySet<string> } = {},
): CallValue[] {
  const sender = opts.sender ? normalizeSuiAddress(opts.sender) : null;
  const usedResults = new Set<number>();
  for (const c of commands) {
    for (const a of commandArgs(c)) {
      if (a.type === "Result" && a.index !== undefined) usedResults.add(a.index);
      if (a.type === "NestedResult" && a.result !== undefined) usedResults.add(a.result);
    }
  }
  const out: CallValue[] = [];
  commands.forEach((c, index) => {
    if (c.type !== "MoveCall" || !c.target) return;
    const args = (c.arguments ?? []) as Arg[];
    const takes = [...new Set(args.map((a) => argValue(a, commands, inputs)).filter((v): v is string => v !== null))];
    const gives: string[] = [];
    const returns = c.returns as string[] | undefined;
    if (returns?.some(carriesValue)) gives.push("returns a coin or balance");
    else if (!returns && usedResults.has(index)) gives.push("returns a result a later command uses (signature unread)");
    for (const a of args) {
      if (!a.address || !/^0x[0-9a-fA-F]{1,64}$/.test(a.address)) continue;
      const to = normalizeSuiAddress(a.address);
      if (to === sender || (opts.gainers && !opts.gainers.has(to))) continue;
      gives.push(opts.gainers ? `names ${to}, which gained in this transaction` : `names ${to}`);
    }
    out.push({ index, target: c.target, takes, gives: [...new Set(gives)] });
  });
  return out;
}

/** Every argument a command takes, in any of the shapes `resolvePtb` gives. */
function commandArgs(c: FormattedCommand): Arg[] {
  const lists: unknown[] = [c.arguments, c.objects, c.amounts, c.sources, c.elements];
  const singles: unknown[] = [c.address, c.coin, c.destination, c.ticket];
  return [...lists.flatMap((l) => (Array.isArray(l) ? l : [])), ...singles.filter((s) => s && typeof s === "object")] as Arg[];
}
