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
   * Regression: the excerpt used to be the diff from the top of the module,
   * so a change below the first 60 lines was never shown. On the Nemo v9→v10
   * upgrade the `sy` sample was 60 lines of `use` statements and structs with
   * no `+` or `-` line at all.
   */
  it("shows a change deep in a module, not the leading unchanged lines", () => {
    const prefix = Array.from({ length: 100 }, (_, i) => `\t${i}: Nop`);
    const a = [...prefix, "\t100: MoveLoc[3](Arg3: &mut State)", "\t101: Ret", "}"];
    const b = [...prefix, "\t100: CopyLoc[3](Arg3: &mut State)", "\t101: Pop", "\t102: Ret", "}"];
    const d = diffLines(a, b, 60);
    expect(d.unified).toContain("- \t100: MoveLoc[3](Arg3: &mut State)");
    expect(d.unified).toContain("+ \t100: CopyLoc[3](Arg3: &mut State)");
    // Three lines of context either side, not the whole prefix.
    expect(d.unified).toEqual([
      "@@ -98,6 +98,7 @@",
      "  \t97: Nop",
      "  \t98: Nop",
      "  \t99: Nop",
      "- \t100: MoveLoc[3](Arg3: &mut State)",
      "- \t101: Ret",
      "+ \t100: CopyLoc[3](Arg3: &mut State)",
      "+ \t101: Pop",
      "+ \t102: Ret",
      "  }",
    ]);
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
});

describe("diffLinkage", () => {
  // Real linkage rows of Cetus CLMM v10 and v11 (0x1eabed72… lineage). The
  // fix for the May 2025 exploit shipped as a relink of integer-mate, with
  // only a version constant changing in CLMM's own modules.
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
