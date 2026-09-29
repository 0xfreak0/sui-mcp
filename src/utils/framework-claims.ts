/**
 * Claims about the Sui framework (`0x2`) source that a rule in this server
 * relies on, stated as data beside the rule each one justifies.
 * `test/sui-framework.test.ts` checks every claim against the framework
 * sources pinned under `test/fixtures/sui-framework`, so a wrong reading of
 * the framework, or a framework change, fails the suite and names the claim.
 *
 * Names are `module::name` in `0x2`; a type is its `module::Name` without
 * type arguments, or a primitive such as `address`.
 */

/** How a function takes a parameter. */
export type TakenBy = "&mut" | "&" | "value";

/** A framework function, and what a rule relies on about it. An unset field claims nothing. */
export interface FunctionClaim {
  fn: string;
  visibility?: "public" | "public(package)" | "private";
  entry?: boolean;
  /** Parameter types, each with how every parameter of that type is taken. */
  takes?: Record<string, TakenBy>;
  /** Parameter types by position, for a rule that reads arguments by index. */
  paramAt?: Record<number, string>;
  /** Each type parameter's exact constraints. */
  typeParams?: Record<string, string[]>;
  /** Framework functions the body calls, by name. */
  calls?: string[];
  /** A phrase the doc comment contains. */
  doc?: string;
  /** The rule this justifies. */
  why: string;
}

/** A framework struct or enum, and what a rule relies on about it. */
export interface StructClaim {
  struct: string;
  /** The exact ability set. */
  abilities?: string[];
  /** Field names in order (variant names for an enum); positional fields are numbered from 0. */
  fields?: string[];
  why: string;
}

/** A named constant the framework declares, `module::NAME`. */
export interface ConstantClaim {
  constant: string;
  /** The address the constant holds, in any spelling. */
  address?: string;
  /** The value as the source writes it, for a number. */
  value?: string;
  why: string;
}

export type FrameworkClaim = FunctionClaim | StructClaim | ConstantClaim;

/**
 * Functions as a note cites them: `coin::mint and mint_balance`. A module is
 * named where it changes from the previous function's.
 */
export function citeFunctions(fns: string[]): string {
  let module = "";
  const names = fns.map((fn) => {
    const [mod, name] = fn.split("::");
    const cited = mod === module ? name! : fn;
    module = mod!;
    return cited;
  });
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "");
}
