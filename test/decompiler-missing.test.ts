import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockClient } from "./helpers/mock-grpc.js";
import type * as Config from "../src/config.js";

const mockSui = createMockClient();
vi.mock("../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));
// SUI_DECOMPILER_PATH='' as a user sets it to switch the decompiler off.
vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Config>()),
  DECOMPILER_PATH: "",
}));

// Loaded after the mocks above: the tool reads both at import.
const { registerDecompilerTools, decompilerAvailable } = await import("../src/tools/decompiler.js");

type Result = { content: { text: string }[]; isError?: boolean };
let handler: (args: Record<string, unknown>) => Promise<Result>;
registerDecompilerTools({
  tool: (_n: string, _d: string, _s: unknown, h: typeof handler) => {
    handler = h;
  },
} as never);

const PKG = "0x4658a0fbd9a234dfc87726addcbe1a602f27ce4513ecc1ec99e6d973c7bfb101";
mockSui.ledgerService.getObject.mockResolvedValue({
  response: {
    object: {
      package: {
        storageId: PKG,
        modules: [{ name: "oracle", contents: new Uint8Array([0xa1, 0x1c, 0xeb, 0x0b]) }],
      },
    },
  },
});

describe("decompile_module with no decompiler configured", () => {
  it("returns an error that names the tools that need no binary", async () => {
    const out = await handler({ package_id: PKG, module_name: "oracle" });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("disassemble_module");
    expect(out.content[0].text).toContain("SUI_DECOMPILER_PATH");
  });

  it("says in the module list that decompiling will fail", async () => {
    const out = JSON.parse((await handler({ package_id: PKG })).content[0].text);
    expect(out.modules).toEqual(["oracle"]);
    expect(out.decompiler_available).toBe(false);
    expect(out.note).toContain("disassemble_module");
  });
});

describe("decompilerAvailable", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "decompiler-path-"));
    await writeFile(join(dir, "move-decompiler"), "#!/bin/sh\n");
    await chmod(join(dir, "move-decompiler"), 0o755);
    await writeFile(join(dir, "not-executable"), "");
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("finds a bare name on the search path and an executable path", async () => {
    expect(await decompilerAvailable("move-decompiler", `/nonexistent:${dir}`)).toBe(true);
    expect(await decompilerAvailable(join(dir, "move-decompiler"), "")).toBe(true);
    expect(await decompilerAvailable(` ${join(dir, "move-decompiler")} `, "")).toBe(true);
  });

  it("reports a blank setting, an absent binary and a file that cannot run as unavailable", async () => {
    expect(await decompilerAvailable("  ", dir)).toBe(false);
    expect(await decompilerAvailable("move-decompiler", "/nonexistent")).toBe(false);
    expect(await decompilerAvailable(join(dir, "not-executable"), "")).toBe(false);
    // A directory passes the execute check but cannot be run.
    expect(await decompilerAvailable(dir, "")).toBe(false);
  });
});
