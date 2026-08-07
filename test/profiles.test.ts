import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  PROFILES,
  PROFILE_NAMES,
  PROFILE_SUMMARIES,
  DEFAULT_PROFILES,
  allProfiledTools,
  parseProfileList,
  toolsForProfiles,
} from "../src/tools/profiles.js";
import { applyProfiles, collectToolHandles, type ToolHandles } from "../src/tools/toolset.js";
import { registerAllTools } from "../src/tools/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Registers like the SDK does, returning a handle that records enable/disable. */
function fakeServer() {
  const handles = new Map<string, { enabled: boolean }>();
  const server = {
    tool(...args: unknown[]) {
      const name = args[0] as string;
      const h = {
        enabled: true,
        enable() {
          h.enabled = true;
        },
        disable() {
          h.enabled = false;
        },
      };
      handles.set(name, h);
      return h;
    },
  } as unknown as McpServer;
  return { server, handles };
}

/** Every tool the server actually registers, ignoring profiles. */
function registeredToolNames(): string[] {
  const names: string[] = [];
  const fake = {
    tool(...args: unknown[]) {
      names.push(args[0] as string);
      return { enabled: true, enable() {}, disable() {} };
    },
  } as unknown as McpServer;
  registerAllTools(fake);
  return names;
}

describe("profile definitions", () => {
  it("has a summary for every profile", () => {
    for (const p of PROFILE_NAMES) {
      expect(PROFILE_SUMMARIES[p]).toBeTruthy();
    }
  });

  it("never lists the same tool in two profiles", () => {
    // Overlap would make "which profile do I enable" ambiguous, and would make
    // disabling one profile silently keep a tool alive via another.
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const p of PROFILE_NAMES) {
      for (const t of PROFILES[p]) {
        if (seen.has(t)) dupes.push(`${t} in both ${seen.get(t)} and ${p}`);
        seen.set(t, p);
      }
    }
    expect(dupes).toEqual([]);
  });

  it("only references tools that actually exist", () => {
    const real = new Set(registeredToolNames());
    const ghosts = [...allProfiledTools()].filter((t) => !real.has(t));
    expect(ghosts).toEqual([]);
  });

  // The inverse, and the one that rots: adding a tool without assigning it.
  // Such a tool stays enabled (see applyProfiles) so nothing breaks, but it
  // would sit in every profile forever, which is not what anyone intended.
  it("assigns every registered tool to some profile", () => {
    const profiled = allProfiledTools();
    const orphans = registeredToolNames()
      // enable_tools is deliberately outside the profile system.
      .filter((t) => t !== "enable_tools")
      .filter((t) => !profiled.has(t));
    expect(orphans).toEqual([]);
  });

  it("keeps core meaningfully smaller than the full surface", () => {
    // The whole point is the manifest shrinks; a core that crept to 80% of the
    // tools would quietly stop delivering that.
    expect(PROFILES.core.length).toBeLessThan(allProfiledTools().size * 0.5);
  });
});

describe("parseProfileList", () => {
  it("defaults to core when unset or blank", () => {
    expect(parseProfileList(undefined)).toEqual(DEFAULT_PROFILES);
    expect(parseProfileList("  ")).toEqual(DEFAULT_PROFILES);
  });

  it("parses a comma-separated list, tolerating case and spacing", () => {
    expect(parseProfileList(" Core , FORENSICS ")).toEqual(["core", "forensics"]);
  });

  it("returns null for 'all', meaning every profile", () => {
    expect(parseProfileList("all")).toBeNull();
    expect(parseProfileList("core,all")).toBeNull();
  });

  it("de-duplicates repeats", () => {
    expect(parseProfileList("core,core,market")).toEqual(["core", "market"]);
  });

  // A typo in a client config should degrade, not brick the server.
  it("ignores unknown names and falls back rather than registering nothing", () => {
    expect(parseProfileList("core,nonsense")).toEqual(["core"]);
    expect(parseProfileList("nonsense,rubbish")).toEqual(DEFAULT_PROFILES);
  });
});

describe("toolsForProfiles", () => {
  it("unions the named profiles", () => {
    const set = toolsForProfiles(["core", "market"]);
    expect(set.has("get_wallet_overview")).toBe(true);
    expect(set.has("deepbook_orderbook")).toBe(true);
    expect(set.has("trace_funds")).toBe(false);
  });

  it("null means everything", () => {
    expect(toolsForProfiles(null).size).toBe(allProfiledTools().size);
  });
});

describe("applyProfiles", () => {
  const build = (): ToolHandles => {
    const handles: ToolHandles = new Map();
    for (const name of ["get_balance", "trace_funds", "deepbook_orderbook", "brand_new_tool"]) {
      let enabled = true;
      handles.set(name, {
        get enabled() {
          return enabled;
        },
        enable() {
          enabled = true;
        },
        disable() {
          enabled = false;
        },
      } as never);
    }
    return handles;
  };

  it("enables the selected profiles and disables the rest", () => {
    const handles = build();
    const { enabled, disabled } = applyProfiles(handles, ["core"], allProfiledTools());
    expect(enabled).toContain("get_balance");
    expect(disabled).toContain("trace_funds");
    expect(disabled).toContain("deepbook_orderbook");
  });

  it("leaves unassigned tools enabled rather than hiding them", () => {
    const handles = build();
    const { enabled } = applyProfiles(handles, ["core"], allProfiledTools());
    expect(enabled).toContain("brand_new_tool");
  });

  it("enables everything when profiles is null", () => {
    const handles = build();
    const { disabled } = applyProfiles(handles, null, allProfiledTools());
    expect(disabled).toEqual([]);
  });
});

describe("collectToolHandles", () => {
  it("records each registration by name and passes the handle through", () => {
    const { server } = fakeServer();
    const handles: ToolHandles = new Map();
    const wrapped = collectToolHandles(server, handles);

    const returned = wrapped.tool("alpha", "desc", {}, async () => ({ content: [] }));
    expect(handles.has("alpha")).toBe(true);
    // Callers (and withNetworkParam) still get the SDK's handle back.
    expect(typeof (returned as { enable?: unknown }).enable).toBe("function");
  });

  it("passes non-tool members through untouched", () => {
    const { server } = fakeServer();
    const wrapped = collectToolHandles(server, new Map());
    expect(() => (wrapped as unknown as { nope?: unknown }).nope).not.toThrow();
  });
});

describe("startup profile from SUI_TOOLS", () => {
  let backup: string | undefined;
  beforeEach(() => {
    backup = process.env.SUI_TOOLS;
  });
  afterEach(() => {
    if (backup === undefined) delete process.env.SUI_TOOLS;
    else process.env.SUI_TOOLS = backup;
    vi.resetModules();
  });

  it("registers only core by default", async () => {
    delete process.env.SUI_TOOLS;
    const { server, handles } = fakeServer();
    vi.resetModules();
    const { registerAllTools: reg } = await import("../src/tools/index.js");
    reg(server);

    expect(handles.get("get_wallet_overview")?.enabled).toBe(true);
    expect(handles.get("trace_funds")?.enabled).toBe(false);
    expect(handles.get("deepbook_orderbook")?.enabled).toBe(false);
    // The escape hatch must always be present.
    expect(handles.get("enable_tools")?.enabled).toBe(true);
  });

  it("honours an explicit multi-profile selection", async () => {
    process.env.SUI_TOOLS = "core,forensics";
    const { server, handles } = fakeServer();
    vi.resetModules();
    const { registerAllTools: reg } = await import("../src/tools/index.js");
    reg(server);

    expect(handles.get("trace_funds")?.enabled).toBe(true);
    expect(handles.get("deepbook_orderbook")?.enabled).toBe(false);
  });

  it("enables everything for SUI_TOOLS=all", async () => {
    process.env.SUI_TOOLS = "all";
    const { server, handles } = fakeServer();
    vi.resetModules();
    const { registerAllTools: reg } = await import("../src/tools/index.js");
    reg(server);

    expect(handles.get("trace_funds")?.enabled).toBe(true);
    expect(handles.get("deepbook_orderbook")?.enabled).toBe(true);
    expect(handles.get("decompile_module")?.enabled).toBe(true);
  });
});
