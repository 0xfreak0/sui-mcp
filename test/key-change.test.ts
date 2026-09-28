import { describe, it, expect } from "vitest";
import { keyBytes, keyChangeAnomaly, keyChanges } from "../src/utils/key-change.js";
import type { ObjectState, StateSnapshot } from "../src/utils/state-delta.js";

const b64 = (len: number, fill: number) => Buffer.alloc(len, fill).toString("base64");
const snap = (objects: ObjectState[]): StateSnapshot => ({ objects, skipped: [], unavailable: [], layout_unread: [] });
const obj = (role: ObjectState["role"], before: unknown, after: unknown): ObjectState => ({
  objectId: "0xaa",
  objectType: "0x1::feed::Signer",
  role,
  parent: null,
  before,
  after,
  balances: {},
  supplies: {},
});

describe("keyBytes", () => {
  it("reads base64 strings of a public-key length that are not all zeros", () => {
    expect(keyBytes(b64(64, 7))?.length).toBe(64);
    expect(keyBytes(b64(33, 7))?.length).toBe(33);
    expect(keyBytes(b64(96, 7))?.length).toBe(96);
    expect(keyBytes(b64(64, 0))).toBeNull();
  });

  it("does not read a 32-byte string, a decimal number or other lengths as a key", () => {
    expect(keyBytes(b64(32, 7))).toBeNull();
    expect(keyBytes(b64(20, 7))).toBeNull();
    // 44 digits decode as 33 bytes of base64, but a stored number is not a key.
    expect(keyBytes("1".repeat(44))).toBeNull();
    expect(keyBytes("not base64!")).toBeNull();
  });
});

describe("keyChanges", () => {
  it("reports a shared object's key replaced by another key", () => {
    const changes = keyChanges(snap([obj("shared", { signing_key: b64(64, 1), ttl: "5" }, { signing_key: b64(64, 2), ttl: "6" })]));
    expect(changes).toEqual([{ object: "0xaa", object_type: "0x1::feed::Signer", field: "signing_key", bytes: 64, before: b64(64, 1), after: b64(64, 2) }]);
    expect(keyChangeAnomaly(changes)?.severity).toBe("medium");
  });

  it("ignores a key cleared to zeros or empty, an unchanged key, keys in lists, and objects that are not shared", () => {
    expect(keyChanges(snap([obj("shared", { k: b64(64, 1) }, { k: b64(64, 0) })]))).toEqual([]);
    expect(keyChanges(snap([obj("shared", { k: b64(64, 1) }, { k: "" })]))).toEqual([]);
    expect(keyChanges(snap([obj("shared", { k: b64(64, 1) }, { k: b64(64, 1) })]))).toEqual([]);
    expect(keyChanges(snap([obj("shared", { list: [b64(64, 1)] }, { list: [b64(64, 2)] })]))).toEqual([]);
    expect(keyChanges(snap([obj("child", { k: b64(64, 1) }, { k: b64(64, 2) })]))).toEqual([]);
    expect(keyChangeAnomaly([])).toBeNull();
  });
});
