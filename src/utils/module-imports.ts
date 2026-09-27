/**
 * The functions a Move module calls in other modules, read from its bytes.
 *
 * A module refers to every function it calls through a function handle,
 * which names a module handle (an address and a module name) and a function
 * name. Handles into the module's own address are its own code; every other
 * handle is a call into a dependency, and those are what this returns. The
 * disassembly shows the same `Call` targets, but runs to hundreds of
 * kilobytes a module where the handle tables are a few hundred bytes.
 */

import { moduleTables, readUleb, type ModuleTable } from "./module-fingerprint.js";

/** `TableType` bytes in the Move binary format. */
const MODULE_HANDLES = 0x01;
const FUNCTION_HANDLES = 0x03;
const IDENTIFIERS = 0x07;
const ADDRESS_IDENTIFIERS = 0x08;
/** Sui addresses are 32 bytes. */
const ADDRESS_LENGTH = 32;

/** One function a module calls outside its own package address. */
export interface ImportedFunction {
  /** The callee's package address, 0x-prefixed, 64 hex digits. */
  address: string;
  module: string;
  function: string;
}

/** Read `count` ULEB fields per entry until the table's end; null on a malformed entry. */
function entries(bytes: Uint8Array, t: ModuleTable, read: (off: number) => { row: number[]; next: number } | null): number[][] | null {
  const rows: number[][] = [];
  let off = t.start;
  while (off < t.start + t.length) {
    const r = read(off);
    if (!r || r.next > t.start + t.length) return null;
    rows.push(r.row);
    off = r.next;
  }
  return rows;
}

function ulebs(bytes: Uint8Array, off: number, n: number): { row: number[]; next: number } | null {
  const row: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = readUleb(bytes, off);
    if (!v) return null;
    row.push(v.value);
    off = v.next;
  }
  return { row, next: off };
}

/**
 * Every function this module calls at another address, in handle order, or
 * null when the bytes are not a module this can read. The module's own
 * address comes from the self handle index serialized after the tables; a
 * handle at that address is the package's own code and is left out.
 */
export function importedFunctions(bytes: Uint8Array): ImportedFunction[] | null {
  const tables = moduleTables(bytes);
  if (!tables) return null;
  const table = (kind: number) => tables.find((t) => t.kind === kind);

  const idTable = table(IDENTIFIERS);
  const addrTable = table(ADDRESS_IDENTIFIERS);
  const modTable = table(MODULE_HANDLES);
  const fnTable = table(FUNCTION_HANDLES);
  if (!idTable || !addrTable || !modTable || !fnTable) return fnTable ? null : [];

  const identifiers: string[] = [];
  let off = idTable.start;
  while (off < idTable.start + idTable.length) {
    const len = readUleb(bytes, off);
    if (!len || len.next + len.value > idTable.start + idTable.length) return null;
    identifiers.push(Buffer.from(bytes.subarray(len.next, len.next + len.value)).toString("utf8"));
    off = len.next + len.value;
  }
  if (addrTable.length % ADDRESS_LENGTH !== 0) return null;
  const addresses: string[] = [];
  for (let a = addrTable.start; a < addrTable.start + addrTable.length; a += ADDRESS_LENGTH) {
    addresses.push(`0x${Buffer.from(bytes.subarray(a, a + ADDRESS_LENGTH)).toString("hex")}`);
  }

  const modules = entries(bytes, modTable, (o) => ulebs(bytes, o, 2));
  // module, name, parameters, return, then the type parameters' ability sets:
  // a count and one byte each.
  const functions = entries(bytes, fnTable, (o) => {
    const head = ulebs(bytes, o, 5);
    if (!head) return null;
    const next = head.next + head.row[4];
    return next <= bytes.length ? { row: head.row.slice(0, 2), next } : null;
  });
  if (!modules || !functions) return null;

  const end = Math.max(...tables.map((t) => t.start + t.length));
  const selfIndex = readUleb(bytes, end);
  const self = selfIndex ? modules[selfIndex.value] : undefined;
  const selfAddress = self ? addresses[self[0]] : undefined;

  const out: ImportedFunction[] = [];
  for (const [m, n] of functions) {
    const handle = modules[m];
    const address = handle ? addresses[handle[0]] : undefined;
    const module = handle ? identifiers[handle[1]] : undefined;
    const fn = identifiers[n];
    if (address === undefined || module === undefined || fn === undefined) return null;
    if (address === selfAddress) continue;
    out.push({ address, module, function: fn });
  }
  return out;
}
