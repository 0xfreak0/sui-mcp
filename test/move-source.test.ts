import { describe, expect, it } from "vitest";
import { isCallable, parseMoveModule } from "./helpers/move-source.js";

// Shapes the framework sources use, in one module.
const SRC = `// SPDX-License-Identifier: Apache-2.0
module sui::demo;

use sui::coin::{Self, TreasuryCap as Cap};
use sui::balance::Supply;

public use fun take_ref as Cap.take;

/// Not a fun thing: fun in a comment.
public struct Holder<phantom T: key + store> has key, store {
    id: UID,
    supply: Supply<T>,
}

public struct Key(address) has copy, drop, store;

public enum State<phantom T> has store {
    Fixed(Supply<T>),
    Named { cap: ID },
    Unknown,
}

const ENope: vector<u8> = b"fun (not) a function";

#[
    deprecated(
        note = b"Use \`other\` (the new one) instead",
    ),
]
#[allow(lint(public_entry))]
/// Takes the cap by reference.
public entry fun take_ref<T: /* internal */ key>(_: &Cap<T>, mut \`type\`: vector<u8>, ctx: &mut TxContext) {
    let _ = \`type\`;
}

public(package) fun consume<T>(cap: coin::TreasuryCap<T>): Supply<T> { cap.into_supply() }

entry fun private_entry(h: &mut Holder<u8>) {}

public macro fun each<$T>($v: vector<$T>, $f: |&mut $T, u64| -> bool) {}

#[test_only]
public fun for_testing(): u64 { 0 }
`;

describe("parseMoveModule", () => {
  const m = parseMoveModule(SRC);
  const fn = (name: string) => m.functions.find((f) => f.name === name)!;

  it("reads declarations and skips method aliases, comments and literals", () => {
    expect(m.name).toBe("demo");
    expect(m.functions.map((f) => f.name)).toEqual(["take_ref", "consume", "private_entry", "each", "for_testing"]);
    expect(m.constants.map((c) => [c.name, c.value])).toEqual([["ENope", 'b"fun (not) a function"']]);
  });

  it("reads visibility, entry, parameter modes and types resolved through use lines", () => {
    const t = fn("take_ref");
    expect([t.visibility, t.entry]).toEqual(["public", true]);
    expect(t.params.map((p) => [p.name, p.takes, p.base])).toEqual([
      ["_", "&", "coin::TreasuryCap"],
      ["type", "value", "vector"],
      ["ctx", "&mut", "tx_context::TxContext"],
    ]);
    expect(t.typeParams).toEqual([{ name: "T", phantom: false, constraints: ["key"] }]);
    expect(t.doc).toBe("Takes the cap by reference.");
    expect(fn("consume").visibility).toBe("public(package)");
    expect(fn("consume").params[0]).toMatchObject({ takes: "value", base: "coin::TreasuryCap" });
    expect(fn("consume").body).toContain("into_supply()");
    expect(fn("consume").returnBases).toEqual(["balance::Supply"]);
    expect(fn("take_ref").returnBases).toEqual([]);
    expect(fn("private_entry").params[0]).toMatchObject({ takes: "&mut", base: "demo::Holder" });
  });

  it("keeps a lambda parameter whole", () => {
    expect(fn("each").macro).toBe(true);
    expect(fn("each").params.map((p) => p.name)).toEqual(["$v", "$f"]);
  });

  it("counts public and entry functions as callable, and never test-only ones", () => {
    expect(m.functions.filter(isCallable).map((f) => f.name)).toEqual(["take_ref", "private_entry", "each"]);
  });

  it("reads struct and enum abilities, fields and variants", () => {
    expect(m.structs.map((s) => [s.name, s.abilities, s.fields])).toEqual([
      ["Holder", ["key", "store"], ["id", "supply"]],
      ["Key", ["copy", "drop", "store"], ["0"]],
      ["State", ["store"], ["Fixed", "Named", "Unknown"]],
    ]);
    expect(m.structs[0]!.typeParams).toEqual([{ name: "T", phantom: true, constraints: ["key", "store"] }]);
  });
});

// Every `use` form and modifier order the compiler accepts resolves the same way.
describe("parseMoveModule — use forms and modifier order", () => {
  const m = parseMoveModule(`module sui::ext;
use sui::package as pkg;
use sui::{coin::{Self as c, TreasuryCap as Treasury}, balance::Supply};
use sui::{deny_list};

public fun by_alias(cap: &pkg::UpgradeCap) {}
public fun by_group<T>(cap: &Treasury<T>, s: &mut Supply<T>, k: &c::DenyCapV2<T>, d: &deny_list::DenyList) {}
entry public(package) fun reordered<T>(cap: &Treasury<T>) {}
native public fun reordered_native(x: u64);
`);
  const fn = (name: string) => m.functions.find((f) => f.name === name)!;

  it("resolves a module alias and a grouped use, nested groups included", () => {
    expect(fn("by_alias").params[0]!.base).toBe("package::UpgradeCap");
    expect(fn("by_group").params.map((p) => p.base)).toEqual(["coin::TreasuryCap", "balance::Supply", "coin::DenyCapV2", "deny_list::DenyList"]);
  });

  it("reads modifiers in any order", () => {
    expect(fn("reordered")).toMatchObject({ visibility: "public(package)", entry: true });
    expect(isCallable(fn("reordered"))).toBe(true);
    expect(fn("reordered_native")).toMatchObject({ visibility: "public", native: true, body: null });
  });
});
