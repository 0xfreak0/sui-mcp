/**
 * Fingerprints of each function in a Move module, so a function's code can be
 * matched across modules that differ elsewhere.
 *
 * Instructions name what they touch by index into the module's tables, and
 * those indices shift whenever the module gains or loses a function, a struct
 * or a constant. Each function is rewritten with every index resolved to what
 * it names: a call as `module::function` with its type arguments, a struct or
 * enum as `module::Name`, a field by struct and field name, a constant by type
 * and value bytes, a variant by enum, name and tag, and each signature as its
 * types. Locals, branch offsets and immediates stay as they are. Visibility
 * and the entry flag are reported beside the hash rather than in it, so a body
 * whose visibility changed still matches and the change can be stated.
 *
 * Addresses are dropped, as {@link moduleFingerprint} zeroes them: a module of
 * the queried package is written without one, a framework package (an address
 * below 0x10000) by its address, and any other package as `ext`. The same
 * source published at another address therefore gives the same fingerprints.
 *
 * Reads the Sui binary format at bytecode versions 5 to 7 (7 adds enums,
 * variants and jump tables). The version word may carry a flavour byte in its
 * top eight bits.
 */

import { createHash } from "node:crypto";

const MOVE_MAGIC = [0xa1, 0x1c, 0xeb, 0x0b];
const MIN_VERSION = 5;
const MAX_VERSION = 7;
/** Deepest type nesting read; the Move verifier's own bound is lower. */
const MAX_TYPE_DEPTH = 256;

/** `TableType` in the Move binary format. */
const T = {
  MODULE_HANDLES: 0x1,
  DATATYPE_HANDLES: 0x2,
  FUNCTION_HANDLES: 0x3,
  FUNCTION_INST: 0x4,
  SIGNATURES: 0x5,
  CONSTANT_POOL: 0x6,
  IDENTIFIERS: 0x7,
  ADDRESS_IDENTIFIERS: 0x8,
  STRUCT_DEFS: 0xa,
  STRUCT_DEF_INST: 0xb,
  FUNCTION_DEFS: 0xc,
  FIELD_HANDLE: 0xd,
  FIELD_INST: 0xe,
  ENUM_DEFS: 0x11,
  ENUM_DEF_INST: 0x12,
  VARIANT_HANDLES: 0x13,
  VARIANT_INST_HANDLES: 0x14,
} as const;

/** `FunctionDefinition` extra flag bits. */
const NATIVE = 0x2;
const ENTRY = 0x4;

const VISIBILITY: Record<number, string> = { 0: "private", 1: "public", 3: "package" };

/** One function of a module. */
export interface ModuleFunction {
  name: string;
  /** Visibility, with ` entry` appended for an entry function: `private`, `public`, `package`. */
  declared: string;
  /** Instructions in its body; null for a native function. */
  instructions: number | null;
  /**
   * The function's signature and body with every table index resolved, one
   * line per part and instruction. Visibility and the entry flag are left
   * out: they are `declared`, so a body made public later still matches.
   */
  canonical: string;
}

/** A function's code hash and how it is declared. */
export interface FunctionCode {
  code: string;
  declared: string;
}

class Malformed extends Error {}

class Cursor {
  constructor(
    private readonly bytes: Uint8Array,
    public pos: number,
    private readonly end: number,
  ) {}

  get done(): boolean {
    return this.pos >= this.end;
  }

  u8(): number {
    if (this.pos >= this.end) throw new Malformed();
    return this.bytes[this.pos++];
  }

  uleb(): number {
    let value = 0;
    for (let shift = 0; shift < 64; shift += 7) {
      const b = this.u8();
      value += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) {
        if (!Number.isSafeInteger(value)) throw new Malformed();
        return value;
      }
    }
    throw new Malformed();
  }

  take(n: number): Uint8Array {
    if (this.pos + n > this.end) throw new Malformed();
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  hex(n: number): string {
    return Buffer.from(this.take(n)).toString("hex");
  }
}

const at = <X>(list: X[], i: number): X => {
  if (i >= list.length) throw new Malformed();
  return list[i];
};

interface Fields {
  datatype: number;
  fields: string[];
}
interface Enum {
  datatype: number;
  variants: string[];
}
interface Inst {
  index: number;
  typeArgs: number;
}

/**
 * Every function of a module, or null when the bytes are not a Move module
 * this can read: bad magic, an unsupported version, a table running past the
 * end, an unknown opcode or type tag, or an index outside its table.
 */
export function moduleFunctions(bytes: Uint8Array): ModuleFunction[] | null {
  try {
    return readModule(bytes);
  } catch (err) {
    if (err instanceof Malformed) return null;
    throw err;
  }
}

/** Each function's code hash and declaration by name, or null when {@link moduleFunctions} cannot read the module. */
export function functionFingerprints(bytes: Uint8Array): Map<string, FunctionCode> | null {
  const fns = moduleFunctions(bytes);
  if (!fns) return null;
  return new Map(fns.map((f) => [f.name, { code: createHash("sha256").update(f.canonical).digest("hex"), declared: f.declared }]));
}

function readModule(bytes: Uint8Array): ModuleFunction[] {
  if (bytes.length < 9 || MOVE_MAGIC.some((b, i) => bytes[i] !== b)) throw new Malformed();
  const version = (bytes[4] | (bytes[5] << 8) | (bytes[6] << 16)) >>> 0;
  if (version < MIN_VERSION || version > MAX_VERSION) throw new Malformed();

  const header = new Cursor(bytes, 8, bytes.length);
  const count = header.uleb();
  const tables = new Map<number, { start: number; end: number }>();
  const ranges: Array<{ offset: number; length: number; kind: number }> = [];
  for (let t = 0; t < count; t++) {
    const kind = header.u8();
    ranges.push({ kind, offset: header.uleb(), length: header.uleb() });
  }
  const base = header.pos;
  let contentEnd = base;
  for (const r of ranges) {
    const start = base + r.offset;
    const end = start + r.length;
    if (end > bytes.length || tables.has(r.kind)) throw new Malformed();
    tables.set(r.kind, { start, end });
    contentEnd = Math.max(contentEnd, end);
  }
  // The self module handle's index follows the table contents.
  const selfModule = new Cursor(bytes, contentEnd, bytes.length).uleb();

  /** Read every entry of a table with `one`; an absent table has none. */
  const each = <X>(kind: number, one: (c: Cursor) => X): X[] => {
    const range = tables.get(kind);
    if (!range) return [];
    const c = new Cursor(bytes, range.start, range.end);
    const out: X[] = [];
    while (!c.done) out.push(one(c));
    return out;
  };

  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const identifiers = each(T.IDENTIFIERS, (c) => {
    try {
      return utf8.decode(c.take(c.uleb()));
    } catch {
      throw new Malformed();
    }
  });
  const addrRange = tables.get(T.ADDRESS_IDENTIFIERS);
  const addresses: string[] = [];
  if (addrRange) {
    if ((addrRange.end - addrRange.start) % 32 !== 0) throw new Malformed();
    const c = new Cursor(bytes, addrRange.start, addrRange.end);
    while (!c.done) addresses.push(c.hex(32));
  }
  const moduleHandles = each(T.MODULE_HANDLES, (c) => ({ address: c.uleb(), name: at(identifiers, c.uleb()) }));
  const self = at(moduleHandles, selfModule);
  const selfAddress = at(addresses, self.address);
  const moduleRef = (i: number): string => {
    const m = at(moduleHandles, i);
    const address = at(addresses, m.address);
    if (address === selfAddress) return m.name;
    // Framework packages sit at small addresses and are the same code everywhere.
    if (/^0{60}/.test(address)) return `0x${address.replace(/^0+/, "") || "0"}::${m.name}`;
    return `ext::${m.name}`;
  };

  const datatypes = each(T.DATATYPE_HANDLES, (c) => {
    const name = `${moduleRef(c.uleb())}::${at(identifiers, c.uleb())}`;
    c.uleb(); // abilities
    const params = c.uleb();
    for (let p = 0; p < params; p++) {
      c.uleb(); // constraints
      c.uleb(); // is_phantom
    }
    return name;
  });

  const type = (c: Cursor, depth = 0): string => {
    if (depth > MAX_TYPE_DEPTH) throw new Malformed();
    const tag = c.u8();
    switch (tag) {
      case 0x1: return "bool";
      case 0x2: return "u8";
      case 0x3: return "u64";
      case 0x4: return "u128";
      case 0x5: return "address";
      case 0x6: return `&${type(c, depth + 1)}`;
      case 0x7: return `&mut ${type(c, depth + 1)}`;
      case 0x8: return at(datatypes, c.uleb());
      case 0x9: return `T${c.uleb()}`;
      case 0xa: return `vector<${type(c, depth + 1)}>`;
      case 0xb: {
        const name = at(datatypes, c.uleb());
        const arity = c.uleb();
        if (arity === 0) throw new Malformed();
        const args: string[] = [];
        for (let a = 0; a < arity; a++) args.push(type(c, depth + 1));
        return `${name}<${args.join(", ")}>`;
      }
      case 0xc: return "signer";
      case 0xd: return "u16";
      case 0xe: return "u32";
      case 0xf: return "u256";
      default: throw new Malformed();
    }
  };
  const signatures = each(T.SIGNATURES, (c) => {
    const n = c.uleb();
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(type(c));
    return out.join(", ");
  });
  const constants = each(T.CONSTANT_POOL, (c) => {
    const t = type(c);
    return `${t} 0x${c.hex(c.uleb())}`;
  });
  const fieldList = (c: Cursor): string[] => {
    const n = c.uleb();
    const names: string[] = [];
    for (let f = 0; f < n; f++) {
      names.push(at(identifiers, c.uleb()));
      type(c);
    }
    return names;
  };
  const structs: Fields[] = each(T.STRUCT_DEFS, (c) => {
    const datatype = c.uleb();
    const flag = c.u8();
    if (flag === 0x1) return { datatype, fields: [] };
    if (flag !== 0x2) throw new Malformed();
    return { datatype, fields: fieldList(c) };
  });
  const enums: Enum[] = each(T.ENUM_DEFS, (c) => {
    const datatype = c.uleb();
    if (c.u8() !== 0x2) throw new Malformed();
    const n = c.uleb();
    const variants: string[] = [];
    for (let v = 0; v < n; v++) {
      variants.push(at(identifiers, c.uleb()));
      fieldList(c);
    }
    return { datatype, variants };
  });
  const inst = (c: Cursor): Inst => ({ index: c.uleb(), typeArgs: c.uleb() });
  const structInsts = each(T.STRUCT_DEF_INST, inst);
  const enumInsts = each(T.ENUM_DEF_INST, inst);
  const functionHandles = each(T.FUNCTION_HANDLES, (c) => {
    const module = c.uleb();
    const name = at(identifiers, c.uleb());
    const params = c.uleb();
    const returns = c.uleb();
    const n = c.uleb();
    const abilities: number[] = [];
    for (let p = 0; p < n; p++) abilities.push(c.uleb());
    return { ref: `${moduleRef(module)}::${name}`, name, params, returns, abilities };
  });
  const functionInsts = each(T.FUNCTION_INST, inst);
  const fieldHandles = each(T.FIELD_HANDLE, (c) => ({ owner: c.uleb(), field: c.uleb() }));
  const fieldInsts = each(T.FIELD_INST, inst);
  const variantHandles = each(T.VARIANT_HANDLES, (c) => ({ index: c.uleb(), tag: c.uleb() }));
  const variantInsts = each(T.VARIANT_INST_HANDLES, (c) => ({ index: c.uleb(), tag: c.uleb() }));

  const args = (sig: number) => `<${at(signatures, sig)}>`;
  const structName = (i: number) => at(datatypes, at(structs, i).datatype);
  const structInst = (i: number) => {
    const s = at(structInsts, i);
    return structName(s.index) + args(s.typeArgs);
  };
  const field = (i: number) => {
    const h = at(fieldHandles, i);
    const s = at(structs, h.owner);
    return `${structName(h.owner)}.${at(s.fields, h.field)}#${h.field}`;
  };
  const fieldInst = (i: number) => {
    const f = at(fieldInsts, i);
    return field(f.index) + args(f.typeArgs);
  };
  const enumName = (i: number) => at(datatypes, at(enums, i).datatype);
  const variant = (enumDef: number, tag: number) => `${enumName(enumDef)}::${at(at(enums, enumDef).variants, tag)}#${tag}`;
  const variantHandle = (i: number) => {
    const v = at(variantHandles, i);
    return variant(v.index, v.tag);
  };
  const variantInst = (i: number) => {
    const v = at(variantInsts, i);
    const e = at(enumInsts, v.index);
    return variant(e.index, v.tag) + args(e.typeArgs);
  };
  const callGeneric = (i: number) => {
    const f = at(functionInsts, i);
    return at(functionHandles, f.index).ref + args(f.typeArgs);
  };

  /** One instruction as text, operands resolved. */
  const instruction = (c: Cursor): string => {
    const op = c.u8();
    const name = op.toString(16).padStart(2, "0");
    switch (op) {
      // No operand.
      case 0x01: case 0x02: case 0x08: case 0x09: case 0x14: case 0x15: case 0x16: case 0x17:
      case 0x18: case 0x19: case 0x1a: case 0x1b: case 0x1c: case 0x1d: case 0x1e: case 0x1f:
      case 0x20: case 0x21: case 0x22: case 0x23: case 0x24: case 0x25: case 0x26: case 0x27:
      case 0x28: case 0x2e: case 0x2f: case 0x30: case 0x33: case 0x34: case 0x35: case 0x4b:
      case 0x4c: case 0x4d:
        return name;
      // Branch target, local index or jump-table index: kept as is.
      case 0x03: case 0x04: case 0x05: case 0x0a: case 0x0b: case 0x0c: case 0x0d: case 0x0e:
      case 0x56:
        return `${name} ${c.uleb()}`;
      case 0x31: return `${name} ${c.hex(1)}`;
      case 0x48: return `${name} ${c.hex(2)}`;
      case 0x49: return `${name} ${c.hex(4)}`;
      case 0x06: return `${name} ${c.hex(8)}`;
      case 0x32: return `${name} ${c.hex(16)}`;
      case 0x4a: return `${name} ${c.hex(32)}`;
      case 0x07: return `${name} ${at(constants, c.uleb())}`;
      case 0x0f: case 0x10: return `${name} ${field(c.uleb())}`;
      case 0x36: case 0x37: return `${name} ${fieldInst(c.uleb())}`;
      case 0x11: return `${name} ${at(functionHandles, c.uleb()).ref}`;
      case 0x38: return `${name} ${callGeneric(c.uleb())}`;
      // Pack, Unpack and the deprecated global-storage instructions name a struct.
      case 0x12: case 0x13: case 0x29: case 0x2a: case 0x2b: case 0x2c: case 0x2d:
        return `${name} ${structName(c.uleb())}`;
      case 0x39: case 0x3a: case 0x3b: case 0x3c: case 0x3d: case 0x3e: case 0x3f:
        return `${name} ${structInst(c.uleb())}`;
      case 0x40: case 0x46: {
        const t = at(signatures, c.uleb());
        return `${name} ${t} ${c.hex(8)}`;
      }
      case 0x41: case 0x42: case 0x43: case 0x44: case 0x45: case 0x47:
        return `${name} ${at(signatures, c.uleb())}`;
      case 0x4e: case 0x50: case 0x51: case 0x52:
        if (version < 7) throw new Malformed();
        return `${name} ${variantHandle(c.uleb())}`;
      case 0x4f: case 0x53: case 0x54: case 0x55:
        if (version < 7) throw new Malformed();
        return `${name} ${variantInst(c.uleb())}`;
      default:
        throw new Malformed();
    }
  };

  return each(T.FUNCTION_DEFS, (c): ModuleFunction => {
    const handle = at(functionHandles, c.uleb());
    const visibility = c.u8();
    let flags = c.u8();
    const entry = (flags & ENTRY) !== 0;
    const native = (flags & NATIVE) !== 0;
    flags &= ~(ENTRY | NATIVE);
    if (flags !== 0 || !(visibility in VISIBILITY)) throw new Malformed();
    const declared = `${VISIBILITY[visibility]}${entry ? " entry" : ""}`;
    const acquires: string[] = [];
    for (let n = c.uleb(), i = 0; i < n; i++) acquires.push(structName(c.uleb()));
    const lines = [
      `fun ${handle.name} native=${native}`,
      `type_params ${handle.abilities.join(",")}`,
      `params ${at(signatures, handle.params)}`,
      `returns ${at(signatures, handle.returns)}`,
      `acquires ${acquires.join(", ")}`,
    ];
    if (native) return { name: handle.name, declared, instructions: null, canonical: lines.join("\n") };
    lines.push(`locals ${at(signatures, c.uleb())}`);
    const count = c.uleb();
    for (let i = 0; i < count; i++) lines.push(instruction(c));
    if (version >= 7) {
      for (let n = c.uleb(), j = 0; j < n; j++) {
        const head = enumName(c.uleb());
        const branches = c.uleb();
        if (c.u8() !== 0x1) throw new Malformed();
        const offsets: number[] = [];
        for (let b = 0; b < branches; b++) offsets.push(c.uleb());
        lines.push(`jump_table ${head} ${offsets.join(",")}`);
      }
    }
    return { name: handle.name, declared, instructions: count, canonical: lines.join("\n") };
  });
}
