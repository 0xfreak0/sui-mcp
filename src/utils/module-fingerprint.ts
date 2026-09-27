/**
 * A fingerprint of a Move module's code that ignores which addresses it lives
 * at and links to.
 *
 * The same source published twice differs in its bytes only where addresses
 * appear: every module's own package address and its dependencies' sit in one
 * table, ADDRESS_IDENTIFIERS, and handles refer to them by index. Zeroing that
 * table and hashing the rest gives one value for identical code in any
 * lineage, while any change to a function body, a constant, a signature or a
 * name changes it.
 */

import { createHash } from "node:crypto";

const MOVE_MAGIC = [0xa1, 0x1c, 0xeb, 0x0b];
/** `TableType::ADDRESS_IDENTIFIERS` in the Move binary format. */
const ADDRESS_IDENTIFIERS = 0x08;

/** One table of a Move module: its `TableType` byte and where its bytes sit. */
export interface ModuleTable {
  kind: number;
  /** Absolute offset of the table's first byte in the module's bytes. */
  start: number;
  length: number;
}

/** ULEB128 at `off`, and the offset after it; null past the end or over 35 bits. */
export function readUleb(bytes: Uint8Array, off: number): { value: number; next: number } | null {
  let value = 0;
  for (let shift = 0; shift < 35; shift += 7) {
    if (off >= bytes.length) return null;
    const b = bytes[off++];
    value += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) return { value, next: off };
  }
  return null;
}

/**
 * The table directory of a Move module, or null when the bytes are not a
 * Move module this can read (bad magic, a truncated table header, or a table
 * running past the end).
 */
export function moduleTables(bytes: Uint8Array): ModuleTable[] | null {
  if (bytes.length < 9 || MOVE_MAGIC.some((b, i) => bytes[i] !== b)) return null;
  // Magic (4 bytes) and version (u32) precede the table count.
  const count = readUleb(bytes, 8);
  if (count === null) return null;
  let off = count.next;
  const headers: Array<{ kind: number; offset: number; length: number }> = [];
  for (let t = 0; t < count.value; t++) {
    if (off >= bytes.length) return null;
    const kind = bytes[off++];
    const offset = readUleb(bytes, off);
    if (offset === null) return null;
    const length = readUleb(bytes, offset.next);
    if (length === null) return null;
    off = length.next;
    headers.push({ kind, offset: offset.value, length: length.value });
  }
  const tables = headers.map((h) => ({ kind: h.kind, start: off + h.offset, length: h.length }));
  return tables.every((t) => t.start + t.length <= bytes.length) ? tables : null;
}

/**
 * The module's code hash with its address table zeroed, or null when the
 * bytes are not a Move module {@link moduleTables} can read.
 */
export function moduleFingerprint(bytes: Uint8Array): string | null {
  const tables = moduleTables(bytes);
  if (!tables) return null;
  const copy = Uint8Array.from(bytes);
  for (const t of tables) {
    if (t.kind === ADDRESS_IDENTIFIERS) copy.fill(0, t.start, t.start + t.length);
  }
  return createHash("sha256").update(copy).digest("hex");
}
