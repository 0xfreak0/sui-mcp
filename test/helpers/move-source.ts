/**
 * Declarations read from Move source text: function signatures, struct and
 * enum abilities, constants. Enough of Move 2024 for the Sui framework
 * sources under `test/fixtures/sui-framework`, and nothing more: bodies are
 * kept as text, types as written.
 *
 * Types are resolved to `module::Name` through the module's own declarations
 * and its `use` lines, so `TreasuryCap<T>` in `token.move` reads as
 * `coin::TreasuryCap`. A name no `use` line or declaration covers keeps `?`
 * as its module.
 */

export type Visibility = "public" | "public(package)" | "public(friend)" | "private";
export type TakenBy = "&mut" | "&" | "value";

export interface MoveParam {
  name: string;
  /** The type as written, without the reference. */
  type: string;
  takes: TakenBy;
  /** `module::Name` of the outermost type, `?::Name` when unresolved, or the primitive name. */
  base: string;
}

export interface MoveTypeParam {
  name: string;
  phantom: boolean;
  constraints: string[];
}

export interface MoveFunction {
  module: string;
  name: string;
  visibility: Visibility;
  entry: boolean;
  macro: boolean;
  native: boolean;
  testOnly: boolean;
  typeParams: MoveTypeParam[];
  params: MoveParam[];
  /** The return type as written, "" for none. */
  returns: string;
  /** The `///` lines above the declaration, without the slashes. */
  doc: string;
  /** Body text with comments and literals blanked, null for a native function. */
  body: string | null;
  line: number;
}

export interface MoveStruct {
  module: string;
  name: string;
  kind: "struct" | "enum";
  abilities: string[];
  typeParams: MoveTypeParam[];
  /** Field names, or variant names for an enum; positional fields are numbered. */
  fields: string[];
  testOnly: boolean;
  line: number;
}

export interface MoveConstant {
  module: string;
  name: string;
  /** The value expression as written. */
  value: string;
  line: number;
}

export interface MoveModule {
  /** Module name without its address, e.g. `coin`. */
  name: string;
  functions: MoveFunction[];
  structs: MoveStruct[];
  constants: MoveConstant[];
}

/**
 * The source with comments and string literals replaced by spaces, so offsets
 * and line numbers still match the original.
 */
export function blankCommentsAndLiterals(src: string): string {
  const out = src.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"') {
      let k = i + 1;
      while (k < src.length && src[k] !== '"') k += src[k] === "\\" ? 2 : 1;
      blank(i, k + 1);
      i = k + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

/** The index just past the bracket that closes the one at `open`. */
function closeOf(code: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "<": ">", "{": "}", "[": "]" };
  const o = code[open]!;
  const c = pairs[o]!;
  let depth = 0;
  for (let k = open; k < code.length; k++) {
    if (code[k] === o) depth++;
    else if (code[k] === c && --depth === 0) return k + 1;
  }
  throw new Error(`unbalanced ${o} at offset ${open}`);
}

/** Split on commas outside any bracket or lambda type (`|A, B| -> C`). */
function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let lambda = false;
  let start = 0;
  for (let k = 0; k < text.length; k++) {
    const ch = text[k];
    if (ch === "<" || ch === "(" || ch === "[" || ch === "{") depth++;
    else if ((ch === ">" && text[k - 1] !== "-") || ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "|" && depth === 0) lambda = !lambda;
    else if (ch === "," && depth === 0 && !lambda) {
      parts.push(text.slice(start, k));
      start = k + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const ident = (s: string) => s.replace(/`/g, "");

function parseTypeParams(text: string): MoveTypeParam[] {
  return splitTop(text.slice(1, -1)).map((p) => {
    const phantom = /^phantom\s+/.test(p);
    const [name, cons] = p.replace(/^phantom\s+/, "").split(":");
    return {
      name: name!.trim(),
      phantom,
      constraints: cons ? cons.split("+").map((c) => c.trim()).filter(Boolean) : [],
    };
  });
}

/**
 * `use` lines: local name -> `module::Name`, and module aliases -> module.
 * Starts from the aliases Move 2024 gives every Sui module without a `use`.
 */
function readUses(code: string): { types: Map<string, string>; modules: Map<string, string> } {
  const types = new Map<string, string>([
    ["UID", "object::UID"],
    ["ID", "object::ID"],
    ["TxContext", "tx_context::TxContext"],
    ["Option", "option::Option"],
  ]);
  const modules = new Map<string, string>(["object", "transfer", "tx_context", "option", "vector"].map((m) => [m, m]));
  const addMember = (mod: string, member: string) => {
    const [name, alias] = member.split(/\s+as\s+/).map((s) => s.trim());
    if (name === "Self") modules.set(alias ?? mod, mod);
    else types.set(alias ?? name!, `${mod}::${name}`);
  };
  for (const m of code.matchAll(/(?:^|[;{}\s])use\s+(\w+)::(\w+)(?:::([^;]+))?;/g)) {
    const mod = m[2]!;
    const rest = m[3]?.trim();
    if (!rest) {
      modules.set(mod, mod);
    } else if (rest.startsWith("{")) {
      for (const member of splitTop(rest.slice(1, -1))) addMember(mod, member);
    } else if (/^\w+(\s+as\s+\w+)?$/.test(rest)) {
      addMember(mod, rest);
    } else {
      const alias = /^as\s+(\w+)$/.exec(rest);
      if (alias) modules.set(alias[1]!, mod);
    }
  }
  return { types, modules };
}

const PRIMITIVES: Record<string, true> = {
  u8: true, u16: true, u32: true, u64: true, u128: true, u256: true, bool: true, address: true, signer: true, vector: true,
};

/** Parse every declaration of one `.move` file. */
export function parseMoveModule(src: string): MoveModule {
  const code = blankCommentsAndLiterals(src);
  const header = /\bmodule\s+(\w+)::(\w+)\s*[;{]/.exec(code);
  if (!header) throw new Error("no module declaration");
  const moduleName = header[2]!;
  const lines = src.split("\n");
  const lineAt = (offset: number) => src.slice(0, offset).split("\n").length;
  const uses = readUses(code);

  const structs: MoveStruct[] = [];
  const functions: MoveFunction[] = [];
  const constants: MoveConstant[] = [];

  // Attributes immediately before an offset, read backwards over `#[...]` groups.
  const attributesBefore = (offset: number): string => {
    let k = offset;
    let attrs = "";
    for (;;) {
      while (k > 0 && /\s/.test(code[k - 1]!)) k--;
      if (code[k - 1] !== "]") return attrs;
      let depth = 0;
      let j = k - 1;
      for (; j >= 0; j--) {
        if (code[j] === "]") depth++;
        else if (code[j] === "[" && --depth === 0) break;
      }
      if (code[j - 1] !== "#") return attrs;
      attrs = code.slice(j - 1, k) + attrs;
      k = j - 1;
    }
  };
  const isTestOnly = (attrs: string) => /#\[\s*(?:test_only|test)\b/.test(attrs) || /[\s,[(]test_only\b/.test(attrs);

  // `///` lines above the declaration, skipping attributes, including ones
  // spread over several lines (`#[` ... `]`), read from the bottom up.
  const docAbove = (line: number): string => {
    const doc: string[] = [];
    let inAttribute = false;
    for (let l = line - 2; l >= 0; l--) {
      const t = lines[l]!.trim();
      if (inAttribute) {
        if (t.startsWith("#[")) inAttribute = false;
      } else if (t.startsWith("///")) {
        doc.unshift(t.replace(/^\/\/\/\s?/, ""));
      } else if (t === "]") {
        inAttribute = true;
      } else if (!t.startsWith("#[") && !t.startsWith("//")) {
        break;
      }
    }
    return doc.join("\n");
  };

  const typeBase = (type: string, generics: MoveTypeParam[]): string => {
    if (type.startsWith("|")) return type;
    const head = type.replace(/<[\s\S]*$/, "").trim();
    const parts = head.split("::").map(ident);
    if (parts.length === 1) {
      const n = parts[0]!;
      if (PRIMITIVES[n] || generics.some((g) => g.name === n)) return n;
      if (declared.has(n)) return `${moduleName}::${n}`;
      return uses.types.get(n) ?? `?::${n}`;
    }
    if (parts.length === 2) return `${uses.modules.get(parts[0]!) ?? parts[0]}::${parts[1]}`;
    return `${parts[parts.length - 2]}::${parts[parts.length - 1]}`;
  };

  // Local type names first, so a type used before its declaration resolves.
  const declared = new Set<string>();
  for (const m of code.matchAll(/\b(?:struct|enum)\s+(\w+)/g)) declared.add(m[1]!);

  for (const m of code.matchAll(/\b(public\s+)?(struct|enum)\s+(\w+)/g)) {
    const start = m.index!;
    let k = start + m[0].length;
    const skipWs = () => {
      while (/\s/.test(code[k] ?? "")) k++;
    };
    skipWs();
    let typeParams: MoveTypeParam[] = [];
    if (code[k] === "<") {
      const end = closeOf(code, k);
      typeParams = parseTypeParams(code.slice(k, end));
      k = end;
      skipWs();
    }
    let abilities: string[] = [];
    let fields: string[] = [];
    const readHas = () => {
      const has = /^has\s+([\w\s,]+?)\s*(?=[{;(]|$)/.exec(code.slice(k));
      if (has) {
        abilities = has[1]!.split(",").map((a) => a.trim()).filter(Boolean);
        k += has[0].length;
        skipWs();
      }
    };
    readHas();
    if (code[k] === "(") {
      const end = closeOf(code, k);
      fields = splitTop(code.slice(k + 1, end - 1)).map((_, i) => String(i));
      k = end;
      skipWs();
      readHas();
    } else if (code[k] === "{") {
      const end = closeOf(code, k);
      const inner = code.slice(k + 1, end - 1);
      fields = splitTop(inner).map((f) => ident(f.split(/[:({\s]/)[0]!.trim())).filter(Boolean);
    }
    structs.push({
      module: moduleName,
      name: m[3]!,
      kind: m[2] as "struct" | "enum",
      abilities,
      typeParams,
      fields,
      testOnly: isTestOnly(attributesBefore(start)),
      line: lineAt(start),
    });
  }

  for (const m of code.matchAll(/(?:^|[\s;{}])const\s+(\w+)\s*:[^=]*=/g)) {
    const from = m.index! + m[0].length;
    const value = squash(src.slice(from, code.indexOf(";", from)));
    constants.push({ module: moduleName, name: m[1]!, value, line: lineAt(m.index! + m[0].indexOf("const")) });
  }

  const FUN = /\b(?:(public)\s*(\(\s*(?:package|friend)\s*\))?\s+)?(?:(entry)\s+)?(?:(native)\s+)?(?:(macro)\s+)?fun\s+(`?\w+`?)/g;
  for (const m of code.matchAll(FUN)) {
    const start = m.index!;
    // `public use fun a as T.b;` is a method alias, not a declaration.
    if (/\buse\s+$/.test(code.slice(0, start))) continue;
    let k = start + m[0].length;
    const skipWs = () => {
      while (/\s/.test(code[k] ?? "")) k++;
    };
    skipWs();
    let typeParams: MoveTypeParam[] = [];
    if (code[k] === "<") {
      const end = closeOf(code, k);
      typeParams = parseTypeParams(code.slice(k, end));
      k = end;
      skipWs();
    }
    if (code[k] !== "(") throw new Error(`${moduleName}::${m[6]}: expected ( at line ${lineAt(k)}`);
    const pend = closeOf(code, k);
    const params = splitTop(code.slice(k + 1, pend - 1)).map((p): MoveParam => {
      const colon = p.indexOf(":");
      const name = ident(p.slice(0, colon).replace(/^mut\s+/, "").trim());
      let type = squash(p.slice(colon + 1));
      let takes: TakenBy = "value";
      if (/^&\s*mut\s/.test(type)) {
        takes = "&mut";
        type = type.replace(/^&\s*mut\s+/, "");
      } else if (type.startsWith("&")) {
        takes = "&";
        type = type.slice(1).trim();
      }
      return { name, type, takes, base: typeBase(type, typeParams) };
    });
    k = pend;
    skipWs();
    let returns = "";
    if (code[k] === ":") {
      const rstart = k + 1;
      let depth = 0;
      while (k < code.length) {
        const ch = code[k]!;
        if (ch === "<" || ch === "(") depth++;
        else if (ch === ">" || ch === ")") depth--;
        else if ((ch === "{" || ch === ";") && depth === 0) break;
        k++;
      }
      returns = squash(code.slice(rstart, k));
    }
    let body: string | null = null;
    if (code[k] === "{") body = code.slice(k, closeOf(code, k));
    const vis: Visibility = !m[1] ? "private" : m[2] ? (m[2].includes("package") ? "public(package)" : "public(friend)") : "public";
    const line = lineAt(start);
    functions.push({
      module: moduleName,
      name: ident(m[6]!),
      visibility: vis,
      entry: !!m[3],
      native: !!m[4],
      macro: !!m[5],
      testOnly: isTestOnly(attributesBefore(start)),
      typeParams,
      params,
      returns,
      doc: docAbove(line),
      body,
      line,
    });
  }

  return { name: moduleName, functions, structs, constants };
}

/** Callable from a transaction or from another package: `public`, or any `entry`. Test-only code is excluded. */
export function isCallable(f: MoveFunction): boolean {
  return !f.testOnly && (f.visibility === "public" || f.entry);
}
