import { describe, it, expect } from "vitest";
import { diffLines, diffLinkage, diffPackages, parseFunctions } from "../src/utils/package-diff.js";

describe("diffLines", () => {
  it("reports zero changes for identical input", () => {
    const d = diffLines(["a", "b", "c"], ["a", "b", "c"]);
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
  });

  it("counts added and removed lines", () => {
    const d = diffLines(["a", "b", "c"], ["a", "x", "c", "d"]);
    // b removed, x + d added
    expect(d.removed).toBe(1);
    expect(d.added).toBe(2);
    expect(d.unified).toContain("- b");
    expect(d.unified).toContain("+ x");
    expect(d.unified).toContain("+ d");
  });

  /**
   * The excerpt is built from hunks around the changes, so a change below the
   * first 60 lines is shown in place of the unchanged lines above it.
   */
  it("shows a change deep in a module, not the leading unchanged lines", () => {
    const prefix = Array.from({ length: 100 }, (_, i) => `\t${i}: Nop`);
    const a = [...prefix, "\t100: MoveLoc[3](Arg3: &mut State)", "\t101: Ret", "}"];
    const b = [...prefix, "\t100: CopyLoc[3](Arg3: &mut State)", "\t101: Pop", "\t102: Ret", "}"];
    const d = diffLines(a, b, 60);
    expect(d.unified).toContain("- \t100: MoveLoc[3](Arg3: &mut State)");
    expect(d.unified).toContain("+ \t100: CopyLoc[3](Arg3: &mut State)");
    // Three lines of context either side, not the whole prefix. The Ret that
    // only moved from offset 101 to 102 is context, not a change.
    expect(d.unified).toEqual([
      "@@ -98,6 +98,7 @@",
      "  \t97: Nop",
      "  \t98: Nop",
      "  \t99: Nop",
      "- \t100: MoveLoc[3](Arg3: &mut State)",
      "+ \t100: CopyLoc[3](Arg3: &mut State)",
      "+ \t101: Pop",
      "  \t102: Ret",
      "  }",
    ]);
    expect(d.renumbered).toBe(1);
    expect(d.hunk_count).toBe(1);
    expect(d.truncated).toBe(false);
  });

  it("names the enclosing function in the hunk header", () => {
    const body = Array.from({ length: 10 }, (_, i) => `\t${i}: Nop`);
    const a = ["public withdraw(Arg0: &AdminCap) {", "B0:", ...body, "\t10: Ret", "}"];
    const b = ["public withdraw(Arg0: &AdminCap) {", "B0:", ...body, "\t10: Pop", "}"];
    const [header] = diffLines(a, b).unified;
    expect(header).toBe("@@ -10,5 +10,5 @@ public withdraw(Arg0: &AdminCap)");
  });

  it("keeps separate hunks apart and merges ones whose context overlaps", () => {
    const a = Array.from({ length: 40 }, (_, i) => `l${i}`);
    const b = [...a];
    b[5] = "X";
    b[9] = "Y"; // 3 unchanged lines between: one hunk
    b[30] = "Z"; // far away: its own hunk
    const d = diffLines(a, b);
    expect(d.hunk_count).toBe(2);
    expect(d.unified.filter((l) => l.startsWith("@@"))).toHaveLength(2);
  });

  it("spends the budget on changed lines before context", () => {
    const a = Array.from({ length: 200 }, (_, i) => `l${i}`);
    const b = [...a];
    for (const i of [10, 50, 90, 130, 170]) b[i] = `changed${i}`;
    // With 3 lines of context the five hunks need 5 × 9 = 45 lines; 20 is
    // enough for every change once context is dropped.
    const d = diffLines(a, b, 20);
    for (const i of [10, 50, 90, 130, 170]) {
      expect(d.unified).toContain(`- l${i}`);
      expect(d.unified).toContain(`+ changed${i}`);
    }
    expect(d.truncated).toBe(false);
    expect(d.hunk_count).toBe(5);
  });

  it("marks the excerpt truncated when the changed lines alone do not fit", () => {
    const a = Array.from({ length: 100 }, (_, i) => `old${i}`);
    const b = Array.from({ length: 100 }, (_, i) => `new${i}`);
    const d = diffLines(a, b, 10);
    expect(d.unified.length).toBe(10);
    expect(d.truncated).toBe(true);
    expect(d.hunk_count).toBe(1);
  });

  it("still aligns a module far larger than the old 4000-line cap when few lines changed", () => {
    const a = Array.from({ length: 9000 }, (_, i) => `l${i}`);
    const b = [...a];
    b[8000] = "backdoor";
    const d = diffLines(a, b);
    expect(d.unified).toContain("+ backdoor");
    expect(d.unified).toContain("- l8000");
    expect(d.truncated).toBe(false);
  });

  it("counts instead of aligning when the edit distance is too large", () => {
    const a = Array.from({ length: 2500 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 2500 }, (_, i) => `b${i}`);
    const d = diffLines(a, b);
    expect(d.unified).toEqual([]);
    expect(d.truncated).toBe(true);
    expect(d.hunk_count).toBeNull();
    expect(d.added).toBe(2500);
    expect(d.removed).toBe(2500);
    expect(d.note).toMatch(/disassemble_module/);
  });
});

describe("parseFunctions", () => {
  it("reads visibility, entry and native modifiers from disassembly", () => {
    const fns = parseFunctions(
      [
        "module 2.pay {",
        "struct Receiving<phantom Ty0: key> has drop {",
        "public keep<Ty0>(Arg0: Coin<Ty0>, Arg1: &TxContext) {",
        "entry public split<Ty0>(Arg0: &mut Coin<Ty0>, Arg1: u64, Arg2: &mut TxContext) {",
        "native public(friend) transfer_impl<Ty0: key>(Arg0: Ty0, Arg1: address);",
        "init(Arg0: SY, Arg1: &mut TxContext) {",
        "Constants [",
      ].join("\n"),
    );
    expect([...fns.keys()]).toEqual(["keep", "split", "transfer_impl", "init"]);
    expect(fns.get("split")).toMatchObject({ visibility: "public", entry: true });
    expect(fns.get("transfer_impl")).toMatchObject({ visibility: "public(friend)", entry: false });
    expect(fns.get("init")).toMatchObject({ visibility: "private", entry: false });
  });
});

describe("diffPackages", () => {
  it("detects an identical package", () => {
    const from = new Map([["m", "line1\nline2"]]);
    const to = new Map([["m", "line1\nline2"]]);
    const d = diffPackages(from, to);
    expect(d.identical).toBe(true);
    expect(d.unchanged_count).toBe(1);
  });

  it("detects added and removed modules", () => {
    const from = new Map([["a", "x"], ["gone", "y"]]);
    const to = new Map([["a", "x"], ["new", "z"]]);
    const d = diffPackages(from, to);
    expect(d.added_modules).toEqual(["new"]);
    expect(d.removed_modules).toEqual(["gone"]);
    expect(d.identical).toBe(false);
  });

  it("detects a changed module and captures the diff — the malicious-upgrade signal", () => {
    const from = new Map([["vault", "public fun withdraw(cap: &AdminCap)\nreturn"]]);
    const to = new Map([["vault", "public fun withdraw(cap: &AdminCap)\npublic fun backdoor()\nreturn"]]);
    const d = diffPackages(from, to);
    expect(d.changed_modules).toHaveLength(1);
    expect(d.changed_modules[0].module).toBe("vault");
    expect(d.changed_modules[0].added_lines).toBe(1);
    expect(d.changed_modules[0].sample?.some((l) => l.includes("backdoor"))).toBe(true);
    expect(d.changed_modules[0].sample_truncated).toBe(false);
    expect(d.changed_modules[0].hunk_count).toBe(1);
  });

  it("reports a function that became public as a widened visibility change", () => {
    const from = new Map([["vault", "module 0.vault {\npublic(friend) mint(Arg0: u64): Coin<SUI> {\nB0:\n}\n"]]);
    const to = new Map([["vault", "module 0.vault {\npublic mint(Arg0: u64): Coin<SUI> {\nB0:\n}\n"]]);
    const d = diffPackages(from, to);
    expect(d.visibility_changes).toEqual([
      { module: "vault", function: "mint", from: "public(friend)", to: "public", widened: true },
    ]);
  });

  it("counts a newly entry function as widened, and lists added and removed functions", () => {
    const from = new Map([["m", "helper(Arg0: u64) {\n}\nold_fn() {\n}"]]);
    const to = new Map([["m", "entry helper(Arg0: u64) {\n}\npublic drain(Arg0: &mut Pool) {\n}"]]);
    const d = diffPackages(from, to);
    expect(d.visibility_changes).toEqual([
      { module: "m", function: "helper", from: "private", to: "private entry", widened: true },
    ]);
    expect(d.added_functions.map((f) => `${f.module}::${f.function}:${f.visibility}`)).toEqual(["m::drain:public"]);
    expect(d.removed_functions.map((f) => f.function)).toEqual(["old_fn"]);
  });

  it("lists the functions of an added module as added", () => {
    const d = diffPackages(new Map(), new Map([["drain", "public all(Arg0: &mut Pool) {\n}"]]));
    expect(d.added_functions).toEqual([
      { module: "drain", function: "all", visibility: "public", entry: false, signature: "public all(Arg0: &mut Pool)" },
    ]);
  });

  it("ignores cosmetic whitespace/line-ending differences", () => {
    const from = new Map([["m", "line1\nline2"]]);
    const to = new Map([["m", "line1  \r\nline2"]]);
    const d = diffPackages(from, to);
    expect(d.identical).toBe(true);
  });

  it("orders changed modules by churn (largest first)", () => {
    const from = new Map([
      ["small", "a\nb"],
      ["big", "a\nb\nc"],
    ]);
    const to = new Map([
      ["small", "a\nB"],
      ["big", "X\nY\nZ\nW"],
    ]);
    const d = diffPackages(from, to);
    expect(d.changed_modules[0].module).toBe("big");
  });

  /**
   * An upgrade compiled with functions in another order. A line diff of the
   * whole module pairs the old text of one function with the new header of
   * another; each function must be diffed against its own old body.
   */
  it("diffs each function against its own old body when the upgrade reorders functions", () => {
    const fnA = [
      "fun_a(Arg0: &mut Oracle, Arg1: u64) {",
      "B0:",
      "\t0: MoveLoc[1](Arg1: u64)",
      "\t1: MoveLoc[0](Arg0: &mut Oracle)",
      "\t2: MutBorrowField[3](Oracle.time_interval: u64)",
      "\t3: WriteRef",
      "\t4: Ret",
      "}",
      "",
    ];
    const oldB = [
      "fun_b(Arg0: &mut Oracle, Arg1: u64) {",
      "B0:",
      "\t0: MoveLoc[1](Arg1: u64)",
      "\t1: MoveLoc[0](Arg0: &mut Oracle)",
      "\t2: MutBorrowField[1](Oracle.price: u64)",
      "\t3: WriteRef",
      "\t4: Ret",
      "}",
      "",
    ];
    const newB = ["fun_b(Arg0: &mut Oracle, Arg1: u64) {", "B0:", "\t0: LdU64(0)", "\t1: Abort", "}", ""];
    const from = new Map([["m", ["module 0.m {", ...fnA, ...oldB, "}"].join("\n")]]);
    const to = new Map([["m", ["module 0.m {", ...newB, ...fnA, "}"].join("\n")]]);
    const d = diffPackages(from, to);

    const sample = d.changed_modules[0].sample ?? [];
    const at = sample.findIndex((l) => l.startsWith("@@") && l.endsWith("@@ fun_b(Arg0: &mut Oracle, Arg1: u64)"));
    expect(at).toBeGreaterThanOrEqual(0);
    const next = sample.findIndex((l, i) => i > at && l.startsWith("@@"));
    const hunk = sample.slice(at, next < 0 ? undefined : next);
    expect(hunk).toContain("- \t2: MutBorrowField[1](Oracle.price: u64)");
    expect(hunk.join("\n")).not.toContain("time_interval");
    expect(d.changed_functions.map((f) => f.function)).toEqual(["fun_b"]);
  });

  /**
   * A recompile shifts instruction offsets, branch targets, local slots and
   * field and constant indices. When those shift consistently the lines are
   * counted as renumbered and kept out of the hunks, so the hunks hold only
   * instructions that were added or removed.
   */
  it("counts consistent renumbering apart from real changes", () => {
    const from = [
      "module 0.spool {",
      "public a(Arg0: &Spool): u64 {",
      "B0:",
      "\t0: MoveLoc[0](Arg0: &Spool)",
      "\t1: ImmBorrowField[2](Spool.index: u64)",
      "\t2: ReadRef",
      "\t3: LdConst[0](u64: 1000..)",
      "\t4: Add",
      "\t5: Ret",
      "}",
      "",
      "public b(Arg0: &mut Spool, Arg1: u64) {",
      "L2:\tloc0: u64",
      "B0:",
      "\t0: MoveLoc[1](Arg1: u64)",
      "\t1: StLoc[2](loc0: u64)",
      "\t2: CopyLoc[2](loc0: u64)",
      "\t3: LdU64(0)",
      "\t4: Eq",
      "\t5: BrFalse(7)",
      "B1:",
      "\t6: Branch(9)",
      "B2:",
      "\t7: LdU64(1)",
      "\t8: Abort",
      "B3:",
      "\t9: MoveLoc[2](loc0: u64)",
      "\t10: MoveLoc[0](Arg0: &mut Spool)",
      "\t11: MutBorrowField[1](Spool.total: u64)",
      "\t12: WriteRef",
      "\t13: Ret",
      "}",
      "",
      "Constants [",
      "\t0 => u64: 1000000000",
      "]",
      "}",
    ];
    const to = [
      "module 0.spool {",
      "public a(Arg0: &Spool): u64 {",
      "B0:",
      "\t0: MoveLoc[0](Arg0: &Spool)",
      "\t1: ImmBorrowField[3](Spool.index: u64)",
      "\t2: ReadRef",
      "\t3: LdConst[1](u64: 1000..)",
      "\t4: Add",
      "\t5: Ret",
      "}",
      "",
      "public b(Arg0: &mut Spool, Arg1: u64) {",
      "L2:\tloc0: bool",
      "L3:\tloc1: u64",
      "B0:",
      "\t0: CopyLoc[0](Arg0: &mut Spool)",
      "\t1: FreezeRef",
      "\t2: Call assert_version(&Spool)",
      "\t3: MoveLoc[1](Arg1: u64)",
      "\t4: StLoc[3](loc1: u64)",
      "\t5: CopyLoc[3](loc1: u64)",
      "\t6: LdU64(0)",
      "\t7: Eq",
      "\t8: BrFalse(10)",
      "B1:",
      "\t9: Branch(12)",
      "B2:",
      "\t10: LdU64(1)",
      "\t11: Abort",
      "B3:",
      "\t12: MoveLoc[3](loc1: u64)",
      "\t13: MoveLoc[0](Arg0: &mut Spool)",
      "\t14: MutBorrowField[2](Spool.total: u64)",
      "\t15: WriteRef",
      "\t16: Ret",
      "}",
      "",
      "Constants [",
      '\t0 => vector<u8>: "EPaused" // interpreted as UTF8 string',
      "\t1 => u64: 1000000000",
      "]",
      "}",
    ];
    const d = diffPackages(new Map([["spool", from.join("\n")]]), new Map([["spool", to.join("\n")]]));
    const m = d.changed_modules[0];
    const sample = m.sample ?? [];

    expect(sample.filter((l) => l.startsWith("- "))).toEqual([]);
    expect(sample.filter((l) => l.startsWith("+ "))).toEqual([
      "+ L2:\tloc0: bool",
      "+ \t0: CopyLoc[0](Arg0: &mut Spool)",
      "+ \t1: FreezeRef",
      "+ \t2: Call assert_version(&Spool)",
      '+ \t0 => vector<u8>: "EPaused" // interpreted as UTF8 string',
    ]);
    expect(m.renumbering_only_functions).toEqual(["a"]);
    expect(d.changed_functions).toEqual([
      { module: "spool", function: "b", added_lines: 4, removed_lines: 0, renumbered_lines: 15 },
    ]);
  });

  describe("a sample that cannot show every change", () => {
    // A long function with twenty small edits first in the module, then a
    // short one rewritten to abort, then a short one with a single edit.
    const long = (bump: number) => [
      "public long_fn(Arg0: u64): u64 {",
      "B0:",
      ...Array.from({ length: 40 }, (_, j) => (j % 2 ? `\t${j}: Pop` : `\t${j}: LdU64(${j + bump})`)),
      "\t40: Ret",
      "}",
      "",
    ];
    const guarded = [
      "public guarded(Arg0: &Pool, Arg1: address) {",
      "B0:",
      "\t0: MoveLoc[0](Arg0: &Pool)",
      "\t1: ImmBorrowField[0](Pool.admin: address)",
      "\t2: ReadRef",
      "\t3: MoveLoc[1](Arg1: address)",
      "\t4: Eq",
      "\t5: Pop",
      "\t6: Ret",
      "}",
      "",
    ];
    const aborted = ["public guarded(Arg0: &Pool, Arg1: address) {", "B0:", "\t0: LdU64(0)", "\t1: Abort", "}", ""];
    const small = (fee: number) => [
      "public small(Arg0: u64): u64 {",
      "B0:",
      "\t0: MoveLoc[0](Arg0: u64)",
      `\t1: LdU64(${fee})`,
      "\t2: Add",
      "\t3: Ret",
      "}",
      "",
    ];
    const from = new Map([["m", ["module 0.m {", ...long(0), ...guarded, ...small(1), "}"].join("\n")]]);
    const to = new Map([["m", ["module 0.m {", ...long(7), ...aborted, ...small(2), "}"].join("\n")]]);
    const titles = (sample: string[]) =>
      sample.filter((l) => l.startsWith("@@")).map((l) => /@@ \S+ \S+ @@ public (\w+)/.exec(l)![1]);

    it("shows every changed function, the most rewritten first, before a second hunk of any", () => {
      const m = diffPackages(from, to, 30).changed_modules[0];
      const sample = m.sample ?? [];
      expect(m.sample_truncated).toBe(true);
      expect(new Set(titles(sample))).toEqual(new Set(["guarded", "long_fn", "small"]));
      expect(titles(sample)[0]).toBe("guarded");
      expect(sample).toContain("+ \t1: Abort");
      expect(sample.filter((l) => l.startsWith("- ") && sample.indexOf(l) < sample.indexOf("+ \t0: LdU64(0)"))).toHaveLength(7);
      expect(m.unsampled_functions).toBeUndefined();
      expect(m.partly_sampled_functions).toEqual(["long_fn"]);
      // Each function's hunks sit together.
      const order = titles(sample).filter((t, i, all) => t !== all[i - 1]);
      expect(order).toHaveLength(3);
    });

    it("names the functions a small budget leaves out, and needs sample_lines_needed to show all", () => {
      const m = diffPackages(from, to, 6).changed_modules[0];
      const shown = new Set(titles(m.sample ?? []));
      for (const fn of ["guarded", "long_fn", "small"]) {
        expect(shown.has(fn) !== (m.unsampled_functions ?? []).includes(fn)).toBe(true);
      }
      expect(m.unsampled_functions?.length).toBeGreaterThan(0);
      for (const fn of m.partly_sampled_functions ?? []) expect(shown.has(fn)).toBe(true);

      const full = diffPackages(from, to, m.sample_lines_needed).changed_modules[0];
      expect(full.sample_truncated).toBe(false);
      expect(full.unsampled_functions).toBeUndefined();
      expect(full.partly_sampled_functions).toBeUndefined();
      expect(diffPackages(from, to, m.sample_lines_needed! - 1).changed_modules[0].sample_truncated).toBe(true);
    });
  });

  it("shows a branch that now jumps to another instruction", () => {
    const body = (target: number) =>
      [
        "module 0.m {",
        "public c(Arg0: bool): u64 {",
        "B0:",
        "\t0: MoveLoc[0](Arg0: bool)",
        `\t1: BrFalse(${target})`,
        "B1:",
        "\t2: LdU64(1)",
        "\t3: Ret",
        "B2:",
        "\t4: LdU64(0)",
        "\t5: Abort",
        "}",
        "}",
      ].join("\n");
    const d = diffPackages(new Map([["m", body(4)]]), new Map([["m", body(2)]]));
    expect(d.changed_modules[0].sample).toContain("- \t1: BrFalse(4)");
    expect(d.changed_modules[0].sample).toContain("+ \t1: BrFalse(2)");
    expect(d.changed_functions.map((f) => f.function)).toEqual(["c"]);
  });

  /**
   * A function past the alignment cap is counted, not aligned, so its branch
   * targets are never checked against an offset map. Swapping which block a
   * branch falls through to changes what it does and must not count as
   * nothing.
   */
  it("counts a too-large function that only swapped its branch arms as changed", () => {
    const block = (start: number, base: number) =>
      Array.from({ length: 1100 }, (_, j) =>
        j === 1099 ? `\t${start + j}: Ret` : j % 2 ? `\t${start + j}: Pop` : `\t${start + j}: LdU64(${base + j})`,
      );
    const fn = (first: number, second: number) =>
      [
        "module 0.m {",
        "public big(Arg0: bool) {",
        "B0:",
        "\t0: MoveLoc[0](Arg0: bool)",
        "\t1: BrFalse(1102)",
        "B1:",
        ...block(2, first),
        "B2:",
        ...block(1102, second),
        "}",
        "}",
      ].join("\n");
    const d = diffPackages(new Map([["m", fn(10_000, 50_000)]]), new Map([["m", fn(50_000, 10_000)]]));
    expect(d.identical).toBe(false);
    expect(d.changed_functions.map((f) => f.function)).toEqual(["big"]);
    expect(d.changed_modules[0].note).toContain("big");
  });

  /**
   * Two stores trade slots while the reads stay put, so `x - y` becomes
   * `y - x`. The votes tie; the slots keeping their number win, and the
   * stores are the lines shown as changed.
   */
  it("shows the stores that trade slots, not the reads that did not change", () => {
    const body = (first: number, second: number) =>
      [
        "module 0.m {",
        "public sub(Arg0: u64, Arg1: u64): u64 {",
        "L2:\tloc0: u64",
        "L3:\tloc1: u64",
        "B0:",
        "\t0: MoveLoc[0](Arg0: u64)",
        `\t1: StLoc[${first}](loc${first - 2}: u64)`,
        "\t2: MoveLoc[1](Arg1: u64)",
        `\t3: StLoc[${second}](loc${second - 2}: u64)`,
        "\t4: MoveLoc[2](loc0: u64)",
        "\t5: MoveLoc[3](loc1: u64)",
        "\t6: Sub",
        "\t7: Ret",
        "}",
        "}",
      ].join("\n");
    const d = diffPackages(new Map([["m", body(2, 3)]]), new Map([["m", body(3, 2)]]));
    const changed = (d.changed_modules[0].sample ?? []).filter((l) => /^[-+] /.test(l));
    expect(changed.sort()).toEqual([
      "+ \t1: StLoc[3](loc1: u64)",
      "+ \t3: StLoc[2](loc0: u64)",
      "- \t1: StLoc[2](loc0: u64)",
      "- \t3: StLoc[3](loc1: u64)",
    ]);
  });

  it("shows a read of a different local, even where the slot numbers look renumbered", () => {
    const body = (first: string, second: string) =>
      [
        "module 0.m {",
        "public d(Arg0: u64, Arg1: u64): u64 {",
        "L2:\tloc0: u64",
        "L3:\tloc1: u64",
        "B0:",
        "\t0: MoveLoc[0](Arg0: u64)",
        "\t1: StLoc[2](loc0: u64)",
        "\t2: MoveLoc[1](Arg1: u64)",
        "\t3: StLoc[3](loc1: u64)",
        "\t4: CopyLoc[2](loc0: u64)",
        "\t5: CopyLoc[3](loc1: u64)",
        "\t6: Add",
        "\t7: Pop",
        `\t8: ${first}`,
        `\t9: ${second}`,
        "\t10: Sub",
        "\t11: Ret",
        "}",
        "}",
      ].join("\n");
    const a = "MoveLoc[2](loc0: u64)";
    const b = "MoveLoc[3](loc1: u64)";
    const d = diffPackages(new Map([["m", body(a, b)]]), new Map([["m", body(b, a)]]));
    const changed = (d.changed_modules[0].sample ?? []).filter((l) => /^[-+] /.test(l));
    expect(changed.sort()).toEqual([`+ \t8: ${b}`, `+ \t9: ${a}`, `- \t8: ${a}`, `- \t9: ${b}`]);
  });
});

describe("diffLinkage", () => {
  // Linkage rows of Cetus CLMM v10 and v11 (0x1eabed72… lineage) as mainnet
  // returns them: integer-mate is relinked from v3 to v5 and ACL is unchanged.
  const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002";
  const MATE = "0x714a63a0dba6da4f017b42d5d0fb78867f18bcde904868e51d951a5a6f5b7f57";
  const ACL = "0xbe21a06129308e0495431d12286127897aff07a8ade3970495a4404d97f9eaaa";
  const v10 = [
    { originalId: SUI, upgradedId: SUI, version: 30 },
    { originalId: MATE, upgradedId: "0xe2b515f0052c0b3f83c23db045d49dbe1732818ccfc5d4596c9482f7f2e76a85", version: 3 },
    { originalId: ACL, upgradedId: "0xe93247b408fe44ed0ee5b6ac508b36325b239d6333e44ffa240dcc0c1a69cdd8", version: 4 },
  ];
  const v11 = [
    { originalId: SUI, upgradedId: SUI, version: 34 },
    { originalId: MATE, upgradedId: "0x991a8ab5ccc7af04c5d1327aaff520a074e1444bf7fcde2fcfcb0ad58b9c2af4", version: 5 },
    { originalId: ACL, upgradedId: "0xe93247b408fe44ed0ee5b6ac508b36325b239d6333e44ffa240dcc0c1a69cdd8", version: 4 },
  ];

  it("reports a relinked dependency with the call that diffs it", () => {
    const [mate] = diffLinkage(v10, v11);
    expect(mate).toEqual({
      package: MATE,
      change: "upgraded",
      from: { version: 3, address: "0xe2b515f0052c0b3f83c23db045d49dbe1732818ccfc5d4596c9482f7f2e76a85" },
      to: { version: 5, address: "0x991a8ab5ccc7af04c5d1327aaff520a074e1444bf7fcde2fcfcb0ad58b9c2af4" },
      system: false,
      diff: { tool: "diff_package_upgrade", args: { package: MATE, from_version: 3, to_version: 5 } },
    });
  });

  it("marks framework rows as system, after the real dependencies, and skips unchanged ones", () => {
    const changes = diffLinkage(v10, v11);
    expect(changes.map((c) => [c.package, c.system])).toEqual([
      [MATE, false],
      [SUI, true],
    ]);
    expect(changes[1].diff).toBeUndefined();
  });

  it("reports added and removed dependencies", () => {
    const changes = diffLinkage(v10.slice(0, 2), [v11[0], v10[2]]);
    expect(changes.find((c) => c.package === ACL)?.change).toBe("added");
    expect(changes.find((c) => c.package === MATE)?.change).toBe("removed");
  });
});
