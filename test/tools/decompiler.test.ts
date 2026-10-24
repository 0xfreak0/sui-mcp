import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMockClient } from "../helpers/mock-grpc.js";
import { cleanErrorMessage } from "../../src/utils/errors.js";

const mockSui = createMockClient();

vi.mock("../../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));

// The binary path is read when config loads, and the mock above must exist
// before the tool module imports the client.
process.env.SUI_DECOMPILER_PATH = "/nonexistent/move-decompiler";
const { registerDecompilerTools, planModuleBatch, DECOMPILE_LIMITS } = await import("../../src/tools/decompiler.js");

const tools = new Map<string, Function>();
registerDecompilerTools({
  tool: (name: string, _desc: string, _schema: unknown, handler: Function) => tools.set(name, handler),
} as unknown as McpServer);

const bytecode = new Uint8Array([0xa1, 0x1c, 0xeb, 0x0b, 0x06, 0x00, 0x00, 0x00]);
mockSui.ledgerService.getObject.mockResolvedValue({
  response: {
    object: {
      package: {
        storageId: "0x2",
        modules: [
          { name: "coin", contents: bytecode, datatypes: [], functions: [] },
          { name: "balance", contents: bytecode, datatypes: [], functions: [] },
        ],
      },
    },
  },
});

describe("decompile_module without a decompiler binary", () => {
  it("is an error for a whole package, not a module list of error strings", async () => {
    const result = await tools.get("decompile_module")!({ package_id: "0x2", all_modules: true });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/SUI_DECOMPILER_PATH/);
  });

  it("does not tell the reader to try another network", async () => {
    // The shared error cleaner adds a network hint to anything that reads as
    // a not-found; a missing binary is not on any network.
    const result = await tools.get("decompile_module")!({ package_id: "0x2", module_name: "coin" });
    const error = JSON.parse(result.content[0].text).error;

    expect(result.isError).toBe(true);
    expect(cleanErrorMessage(error, "mainnet")).not.toMatch(/looked up on|network/);
  });
});

it("pages oversized package modules by offset without skipping or repeating any", () => {
  const modules = Array.from({ length: DECOMPILE_LIMITS.maxModules * 2 + 3 }, (_, i) => `m${i}`);
  const first = planModuleBatch(modules);
  const second = planModuleBatch(modules, first.selected.length);
  const third = planModuleBatch(modules, first.selected.length + second.selected.length);
  expect([...first.selected, ...second.selected, ...third.selected]).toEqual(modules);
  expect(first.skipped).toBe(modules.length - DECOMPILE_LIMITS.maxModules);
  expect(second.skipped).toBe(3);
  expect(third.skipped).toBe(0);
});

it("rejects module offsets outside all_modules mode", async () => {
  const response = await tools.get("decompile_module")!({ package_id: "0x2", module_offset: 1 });
  expect(response.isError).toBe(true);
  expect(JSON.parse(response.content[0].text).error).toContain("all_modules");
});

it("does not count a failed module as decompiled or declare the batch complete", async () => {
  mockSui.ledgerService.getObject.mockResolvedValueOnce({
    response: {
      object: {
        package: {
          storageId: "0x2",
          modules: [{ name: "../invalid", contents: bytecode, datatypes: [], functions: [] }],
        }
      }
    },
  });
  const result = await tools.get("decompile_module")!({ package_id: "0x2", all_modules: true });
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0].text).error).toMatch(/Could not decompile module.*invalid/);
});
