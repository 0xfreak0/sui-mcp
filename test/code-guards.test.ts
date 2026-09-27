import { describe, it, expect } from "vitest";
import { analyzeCodeGuards, ungatedOlderVersions, type CodeLead } from "../src/utils/code-guards.js";

const SELF = "00000000000000000000000000000000000000000000000000000000000000aa";
const FRAMEWORK = "0000000000000000000000000000000000000000000000000000000000000002";

/** A module as the GraphQL endpoint disassembles it: header, uses, then declarations. */
function module(name: string, uses: string[], decls: string[][]): string {
  return [
    "// Move bytecode v6",
    `module ${SELF}.${name} {`,
    ...uses.map((u) => (u.includes("::") ? `use ${u};` : `use ${SELF}::${u};`)),
    "",
    ...decls.flatMap((d) => [...d, ""]),
    "}",
  ].join("\n");
}

const fw = (m: string) => `${FRAMEWORK}::${m}`;
const leadsOf = (leads: CodeLead[]) => leads.map((l) => `${l.function}:${l.grade}`);

describe("discarded-check", () => {
  const oracle = (body: string[]) =>
    new Map([
      [
        "oracle",
        module(
          "oracle",
          [fw("tx_context"), fw("vector")],
          [
            ["struct Authority has key {", "\tid: UID,", "\tlist: vector<address>", "}"],
            [
              "entry public update(Arg0: &Authority, Arg1: &mut TxContext) {",
              "L2:\tloc0: address",
              "L3:\tloc1: bool",
              "B0:",
              "\t0: MoveLoc[1](Arg1: &mut TxContext)",
              "\t1: FreezeRef",
              "\t2: Call tx_context::sender(&TxContext): address",
              "\t3: StLoc[2](loc0: address)",
              "\t4: MoveLoc[0](Arg0: &Authority)",
              "\t5: ImmBorrowField[0](Authority.list: vector<address>)",
              "\t6: ImmBorrowLoc[2](loc0: address)",
              "\t7: Call vector::contains<address>(&vector<address>, &address): bool",
              ...body,
              "}",
            ],
            ["ignore(Arg0: bool) {", "B0:", "\t0: MoveLoc[0](Arg0: bool)", "\t1: Pop", "\t2: Ret", "}"],
          ],
        ),
      ],
    ]);

  it("flags an authority check dropped at once, whatever the callee is called", () => {
    const r = analyzeCodeGuards(oracle(["\t8: Pop", "\t9: Ret"]));
    expect(leadsOf(r.discarded_checks)).toEqual(["oracle::update:strong"]);
    expect(r.discarded_checks[0].instructions[0]).toContain("7: Call vector::contains");
  });

  it("flags a check stored in a local that is never read", () => {
    const r = analyzeCodeGuards(oracle(["\t8: StLoc[3](loc1: bool)", "\t9: Ret"]));
    expect(leadsOf(r.discarded_checks)).toEqual(["oracle::update:strong"]);
  });

  it("flags a check handed to a package function that never uses it", () => {
    const r = analyzeCodeGuards(oracle(["\t8: Call ignore(bool)", "\t9: Ret"]));
    expect(leadsOf(r.discarded_checks)).toEqual(["oracle::update:strong"]);
  });

  it("leaves a check that reaches a branch to an abort", () => {
    const r = analyzeCodeGuards(
      oracle(["\t8: BrFalse(10)", "B1:", "\t9: Ret", "B2:", "\t10: LdU64(1)", "\t11: Abort"]),
    );
    expect(r.discarded_checks).toEqual([]);
  });

  it("leaves a dropped bool from a package function that aborts on the failing case itself", () => {
    const r = analyzeCodeGuards(
      new Map([
        [
          "gate",
          module(
            "gate",
            [],
            [
              ["struct Obj has key {", "\tid: UID,", "\tok: bool", "}"],
              [
                "public verify(Arg0: &Obj): bool {",
                "B0:",
                "\t0: MoveLoc[0](Arg0: &Obj)",
                "\t1: ImmBorrowField[0](Obj.ok: bool)",
                "\t2: ReadRef",
                "\t3: BrFalse(6)",
                "B1:",
                "\t4: LdTrue",
                "\t5: Ret",
                "B2:",
                "\t6: LdU64(1)",
                "\t7: Abort",
                "}",
              ],
              [
                "entry public act(Arg0: &Obj) {",
                "B0:",
                "\t0: MoveLoc[0](Arg0: &Obj)",
                "\t1: Call verify(&Obj): bool",
                "\t2: Pop",
                "\t3: Ret",
                "}",
              ],
            ],
          ),
        ],
      ]),
    );
    expect(r.discarded_checks).toEqual([]);
  });

  it("leaves a dropped status from a call that changes state, and a dropped flag inside a tuple", () => {
    const r = analyzeCodeGuards(
      new Map([
        [
          "math",
          module(
            "math",
            [fw("table"), `${SELF}::full`],
            [
              [
                "public f(Arg0: &mut Table<address, bool>, Arg1: u256): u256 {",
                "B0:",
                "\t0: MoveLoc[0](Arg0: &mut Table<address, bool>)",
                "\t1: LdConst[0](address: 0x1)",
                "\t2: Call table::remove<address, bool>(&mut Table<address, bool>, address): bool",
                "\t3: Pop",
                "\t4: MoveLoc[1](Arg1: u256)",
                "\t5: Call full::overflowing_shl(u256): u256 * bool",
                "\t6: Pop",
                "\t7: Ret",
                "}",
              ],
            ],
          ),
        ],
      ]),
    );
    expect(r.discarded_checks).toEqual([]);
  });
});

describe("sibling-guard-gap", () => {
  // Four public functions mutate an Account. Three first call a check that
  // relates the Account to the Pool; `update` does not.
  const guarded = (name: string) => [
    `entry public ${name}(Arg0: &mut Pool, Arg1: &mut Account) {`,
    "B0:",
    "\t0: CopyLoc[0](Arg0: &mut Pool)",
    "\t1: FreezeRef",
    "\t2: CopyLoc[1](Arg1: &mut Account)",
    "\t3: FreezeRef",
    "\t4: Call assert_pool(&Pool, &Account)",
    "\t5: MoveLoc[0](Arg0: &mut Pool)",
    "\t6: MoveLoc[1](Arg1: &mut Account)",
    "\t7: Call accrue(&mut Pool, &mut Account)",
    "\t8: Ret",
    "}",
  ];
  const pkg = (update: string[]) =>
    new Map([
      [
        "account",
        module(
          "account",
          [fw("object"), fw("transfer")],
          [
            ["struct Pool has key {", "\tid: UID,", "\tindex: u64", "}"],
            ["struct Account has key {", "\tid: UID,", "\tpool_id: ID,", "\tindex: u64", "}"],
            [
              "init(Arg0: Pool) {",
              "B0:",
              "\t0: MoveLoc[0](Arg0: Pool)",
              "\t1: Call transfer::share_object<Pool>(Pool)",
              "\t2: Ret",
              "}",
            ],
            [
              "public assert_pool(Arg0: &Pool, Arg1: &Account) {",
              "B0:",
              "\t0: MoveLoc[0](Arg0: &Pool)",
              "\t1: Call object::id<Pool>(&Pool): ID",
              "\t2: MoveLoc[1](Arg1: &Account)",
              "\t3: ImmBorrowField[1](Account.pool_id: ID)",
              "\t4: ReadRef",
              "\t5: Eq",
              "\t6: BrFalse(8)",
              "B1:",
              "\t7: Ret",
              "B2:",
              "\t8: LdU64(1)",
              "\t9: Abort",
              "}",
            ],
            [
              "public(friend) accrue(Arg0: &mut Pool, Arg1: &mut Account) {",
              "B0:",
              "\t0: MoveLoc[0](Arg0: &mut Pool)",
              "\t1: ImmBorrowField[0](Pool.index: u64)",
              "\t2: ReadRef",
              "\t3: MoveLoc[1](Arg1: &mut Account)",
              "\t4: MutBorrowField[2](Account.index: u64)",
              "\t5: WriteRef",
              "\t6: Ret",
              "}",
            ],
            guarded("stake"),
            guarded("unstake"),
            guarded("redeem"),
            update,
          ],
        ),
      ],
    ]);

  it("flags the one function that mutates the account without the binding check", () => {
    const r = analyzeCodeGuards(
      pkg([
        "entry public update(Arg0: &mut Pool, Arg1: &mut Account) {",
        "B0:",
        "\t0: MoveLoc[0](Arg0: &mut Pool)",
        "\t1: MoveLoc[1](Arg1: &mut Account)",
        "\t2: Call accrue(&mut Pool, &mut Account)",
        "\t3: Ret",
        "}",
      ]),
    );
    expect(leadsOf(r.sibling_guard_gaps)).toContain("account::update:strong");
    const lead = r.sibling_guard_gaps.find((l) => l.function === "account::update");
    expect(lead?.instructions.some((i) => i.includes("account::stake: 4: Call assert_pool"))).toBe(true);
  });

  it("leaves a function that writes the field the check reads", () => {
    // Setting pool_id is the check's counterpart, not a skipped check.
    const r = analyzeCodeGuards(
      pkg([
        "entry public rebind(Arg0: &mut Pool, Arg1: &mut Account, Arg2: ID) {",
        "B0:",
        "\t0: MoveLoc[2](Arg2: ID)",
        "\t1: MoveLoc[1](Arg1: &mut Account)",
        "\t2: MutBorrowField[1](Account.pool_id: ID)",
        "\t3: WriteRef",
        "\t4: MoveLoc[0](Arg0: &mut Pool)",
        "\t5: Pop",
        "\t6: Ret",
        "}",
      ]),
    );
    expect(r.sibling_guard_gaps.map((l) => l.function)).not.toContain("account::rebind");
  });
});

describe("unchecked-state-write", () => {
  const pkg = (quote: string[]) =>
    new Map([
      [
        "py",
        module(
          "py",
          [fw("transfer"), fw("tx_context"), "00000000000000000000000000000000000000000000000000000000000000bb::fixed"],
          [
            ["struct State has key {", "\tid: UID,", "\tindex: Fixed", "}"],
            ["struct AdminCap has key {", "\tid: UID", "}"],
            [
              "init(Arg0: State) {",
              "B0:",
              "\t0: MoveLoc[0](Arg0: State)",
              "\t1: Call transfer::share_object<State>(State)",
              "\t2: Ret",
              "}",
            ],
            [
              // The stored index becomes max(caller's value, stored value).
              "public(friend) set_index(Arg0: Fixed, Arg1: &mut State) {",
              "B0:",
              "\t0: CopyLoc[0](Arg0: Fixed)",
              "\t1: CopyLoc[1](Arg1: &mut State)",
              "\t2: ImmBorrowField[0](State.index: Fixed)",
              "\t3: ReadRef",
              "\t4: Call fixed::max(Fixed, Fixed): Fixed",
              "\t5: MoveLoc[1](Arg1: &mut State)",
              "\t6: MutBorrowField[0](State.index: Fixed)",
              "\t7: WriteRef",
              "\t8: Ret",
              "}",
            ],
            quote,
          ],
        ),
      ],
    ]);

  it("flags a public function that writes a caller's value into a shared object", () => {
    const r = analyzeCodeGuards(
      pkg([
        "public quote(Arg0: Fixed, Arg1: &mut State) {",
        "B0:",
        "\t0: MoveLoc[0](Arg0: Fixed)",
        "\t1: MoveLoc[1](Arg1: &mut State)",
        "\t2: Call set_index(Fixed, &mut State)",
        "\t3: Ret",
        "}",
      ]),
    );
    expect(leadsOf(r.unchecked_state_writes)).toEqual(["py::quote:strong"]);
    expect(r.unchecked_state_writes[0].instructions[0]).toBe("py::set_index: 7: WriteRef");
  });

  it("flags the write when the only check on the value compares a figure computed from it and stored state with a constant", () => {
    // The index is written first; a later assert checks that
    // index × stored index is not one. Nothing bounds the caller's index by
    // the stored one, so the write stays unchecked.
    const r = analyzeCodeGuards(
      pkg([
        "public quote(Arg0: Fixed, Arg1: &mut State) {",
        "B0:",
        "\t0: CopyLoc[0](Arg0: Fixed)",
        "\t1: CopyLoc[1](Arg1: &mut State)",
        "\t2: Call set_index(Fixed, &mut State)",
        "\t3: MoveLoc[0](Arg0: Fixed)",
        "\t4: MoveLoc[1](Arg1: &mut State)",
        "\t5: ImmBorrowField[0](State.index: Fixed)",
        "\t6: ReadRef",
        "\t7: Call fixed::mul(Fixed, Fixed): Fixed",
        "\t8: Call fixed::one(): Fixed",
        "\t9: Call fixed::eq(Fixed, Fixed): bool",
        "\t10: BrTrue(12)",
        "B1:",
        "\t11: Ret",
        "B2:",
        "\t12: LdU64(1)",
        "\t13: Abort",
        "}",
      ]),
    );
    expect(leadsOf(r.unchecked_state_writes)).toEqual(["py::quote:medium"]);
  });

  it("reads a copyable enum of the package as a caller's value, not as another package's capability", () => {
    const text = [
      "// Move bytecode v7",
      `module ${SELF}.config {`,
      `use ${FRAMEWORK}::transfer;`,
      "",
      "struct Config has key {",
      "\tid: UID,",
      "\tfee: u64",
      "}",
      "",
      "enum Mode has copy, drop {",
      "\tLow { },",
      "\tHigh { }",
      "}",
      "",
      "init(Arg0: Config) {",
      "B0:",
      "\t0: MoveLoc[0](Arg0: Config)",
      "\t1: Call transfer::share_object<Config>(Config)",
      "\t2: Ret",
      "}",
      "",
      "public set_fee(Arg0: &mut Config, Arg1: Mode, Arg2: u64) {",
      "B0:",
      "\t0: MoveLoc[2](Arg2: u64)",
      "\t1: MoveLoc[0](Arg0: &mut Config)",
      "\t2: MutBorrowField[0](Config.fee: u64)",
      "\t3: WriteRef",
      "\t4: Ret",
      "}",
      "}",
    ].join("\n");
    const r = analyzeCodeGuards(new Map([["config", text]]));
    expect(leadsOf(r.unchecked_state_writes)).toEqual(["config::set_fee:strong"]);
  });

  it("leaves the write when the value is compared with stored state before it", () => {
    const r = analyzeCodeGuards(
      pkg([
        "public quote(Arg0: Fixed, Arg1: &mut State) {",
        "B0:",
        "\t0: CopyLoc[0](Arg0: Fixed)",
        "\t1: CopyLoc[1](Arg1: &mut State)",
        "\t2: ImmBorrowField[0](State.index: Fixed)",
        "\t3: ReadRef",
        "\t4: Call fixed::le(Fixed, Fixed): bool",
        "\t5: BrFalse(10)",
        "B1:",
        "\t6: MoveLoc[0](Arg0: Fixed)",
        "\t7: MoveLoc[1](Arg1: &mut State)",
        "\t8: Call set_index(Fixed, &mut State)",
        "\t9: Ret",
        "B2:",
        "\t10: LdU64(1)",
        "\t11: Abort",
        "}",
      ]),
    );
    expect(r.unchecked_state_writes).toEqual([]);
  });

  it("leaves the write when the caller must hold an owned capability of the package", () => {
    const r = analyzeCodeGuards(
      pkg([
        "public quote(Arg0: &AdminCap, Arg1: Fixed, Arg2: &mut State) {",
        "B0:",
        "\t0: MoveLoc[1](Arg1: Fixed)",
        "\t1: MoveLoc[2](Arg2: &mut State)",
        "\t2: Call set_index(Fixed, &mut State)",
        "\t3: Ret",
        "}",
      ]),
    );
    expect(r.unchecked_state_writes).toEqual([]);
  });
});

describe("ungatedOlderVersions", () => {
  // One lineage, two versions of module `pool`. A shared Pool holds the
  // liquidity; a shared Version holds the number newer code checks.
  const structs = [
    ["struct Pool has key {", "\tid: UID,", "\ttotal: u64", "}"],
    ["struct Version has key {", "\tid: UID,", "\tvalue: u64", "}"],
    [
      "init(Arg0: Pool, Arg1: Version) {",
      "B0:",
      "\t0: MoveLoc[0](Arg0: Pool)",
      "\t1: Call transfer::share_object<Pool>(Pool)",
      "\t2: MoveLoc[1](Arg1: Version)",
      "\t3: Call transfer::share_object<Version>(Version)",
      "\t4: Ret",
      "}",
    ],
  ];
  // The check: the stored number must equal this version's constant.
  const check = (constant: number) => [
    "public assert_version(Arg0: &Version) {",
    "B0:",
    "\t0: MoveLoc[0](Arg0: &Version)",
    "\t1: ImmBorrowField[1](Version.value: u64)",
    "\t2: ReadRef",
    `\t3: LdU64(${constant})`,
    "\t4: Eq",
    "\t5: BrFalse(7)",
    "B1:",
    "\t6: Ret",
    "B2:",
    "\t7: LdU64(9)",
    "\t8: Abort",
    "}",
  ];
  // A public function adding the caller's amount to the pool, with or
  // without the check first.
  const mutator = (name: string, gated: boolean) =>
    gated
      ? [
          `entry public ${name}(Arg0: &mut Pool, Arg1: &Version, Arg2: u64) {`,
          "B0:",
          "\t0: MoveLoc[1](Arg1: &Version)",
          "\t1: Call assert_version(&Version)",
          "\t2: MoveLoc[2](Arg2: u64)",
          "\t3: MoveLoc[0](Arg0: &mut Pool)",
          "\t4: MutBorrowField[0](Pool.total: u64)",
          "\t5: WriteRef",
          "\t6: Ret",
          "}",
        ]
      : [
          `entry public ${name}(Arg0: &mut Pool, Arg1: u64) {`,
          "B0:",
          "\t0: MoveLoc[1](Arg1: u64)",
          "\t1: MoveLoc[0](Arg0: &mut Pool)",
          "\t2: MutBorrowField[0](Pool.total: u64)",
          "\t3: WriteRef",
          "\t4: Ret",
          "}",
        ];
  const version = (n: number, decls: string[][]) => ({
    version: n,
    package_id: `0x${String(n).padStart(64, "0")}`,
    disassembly: new Map([["pool", module("pool", [fw("transfer")], [...structs, ...decls])]]),
  });

  it("flags an older version whose public functions mutate the shared type without the newest version's check", () => {
    const leads = ungatedOlderVersions([
      version(1, [mutator("deposit", false), mutator("withdraw", false)]),
      version(2, [check(2), mutator("deposit", true), mutator("withdraw", true)]),
    ]);
    expect(leads.map((l) => [l.versions, l.type, l.gate, l.grade])).toEqual([[[1], "Pool", "pool::assert_version", "strong"]]);
    expect(leads[0].functions).toEqual([
      { function: "pool::deposit", grade: "strong" },
      { function: "pool::withdraw", grade: "strong" },
    ]);
  });

  it("grades an older function weak when it returns a request the caller must hand on", () => {
    const request = ["struct Request {", "\tamount: u64", "}"];
    const asks = [
      "entry public deposit(Arg0: &mut Pool, Arg1: u64): Request {",
      "B0:",
      "\t0: CopyLoc[1](Arg1: u64)",
      "\t1: MoveLoc[0](Arg0: &mut Pool)",
      "\t2: MutBorrowField[0](Pool.total: u64)",
      "\t3: WriteRef",
      "\t4: MoveLoc[1](Arg1: u64)",
      "\t5: Pack[2](Request)",
      "\t6: Ret",
      "}",
    ];
    const leads = ungatedOlderVersions([
      version(1, [request, asks]),
      version(2, [check(2), mutator("deposit", true), mutator("withdraw", true)]),
    ]);
    expect(leads.map((l) => [l.versions, l.grade, l.functions])).toEqual([[[1], "weak", [{ function: "pool::deposit", grade: "weak" }]]]);
  });

  it("leaves a lineage whose older version already makes the check newer versions retire it with", () => {
    const leads = ungatedOlderVersions([
      version(1, [check(1), mutator("deposit", true), mutator("withdraw", true)]),
      version(2, [check(2), mutator("deposit", true), mutator("withdraw", true)]),
    ]);
    expect(leads).toEqual([]);
  });

  it("leaves an older version that tests the checked field inline", () => {
    const inline = (name: string) => [
      `entry public ${name}(Arg0: &mut Pool, Arg1: &Version, Arg2: u64) {`,
      "B0:",
      "\t0: MoveLoc[1](Arg1: &Version)",
      "\t1: ImmBorrowField[1](Version.value: u64)",
      "\t2: ReadRef",
      "\t3: LdU64(1)",
      "\t4: Eq",
      "\t5: BrFalse(11)",
      "B1:",
      "\t6: MoveLoc[2](Arg2: u64)",
      "\t7: MoveLoc[0](Arg0: &mut Pool)",
      "\t8: MutBorrowField[0](Pool.total: u64)",
      "\t9: WriteRef",
      "\t10: Ret",
      "B2:",
      "\t11: LdU64(9)",
      "\t12: Abort",
      "}",
    ];
    const leads = ungatedOlderVersions([
      version(1, [inline("deposit"), inline("withdraw")]),
      version(2, [check(2), mutator("deposit", true), mutator("withdraw", true)]),
    ]);
    expect(leads).toEqual([]);
  });
});
