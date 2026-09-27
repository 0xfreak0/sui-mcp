import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GrpcTypes } from "@mysten/sui/grpc";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMockClient, createMockGraphql } from "../helpers/mock-grpc.js";
import { runWithNetwork } from "../../src/config.js";

// Synthetic fixtures: every package, object and module here is made up.
const mockSui = createMockClient();
const mockGqlQuery = createMockGraphql();
vi.mock("../../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));
vi.mock("../../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));

// Loaded after the mocks above: both import the grpc/graphql clients.
const { registerIdentifyTools } = await import("../../src/tools/identify.js");
const { addSessionLabel, removeSessionLabel } = await import("../../src/utils/labels.js");
const { clearLabeledObjectTypes } = await import("../../src/utils/bridge/labeled-package.js");

const tools = new Map<string, Function>();
registerIdentifyTools({
  tool: (name: string, _d: string, _s: unknown, handler: Function) => tools.set(name, handler),
} as unknown as McpServer);
const identify = tools.get("identify_address")!;

const hex32 = (byte: string) => `0x${byte.repeat(32)}`;

function uleb(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}

/**
 * A Move module holding only the tables the import reader uses: module
 * handles (the first is the module itself), function handles, identifiers
 * and addresses, then the self handle index.
 */
function moduleBytes(self: { address: string; name: string }, calls: Array<{ address: string; module: string; fn: string }>): string {
  const addresses = [...new Set([self.address, ...calls.map((c) => c.address)])];
  const identifiers: string[] = [];
  const id = (s: string) => (identifiers.includes(s) ? identifiers.indexOf(s) : identifiers.push(s) - 1);
  const handles: Array<[number, number]> = [[addresses.indexOf(self.address), id(self.name)]];
  const fns: number[][] = [];
  for (const c of calls) {
    const key = [addresses.indexOf(c.address), id(c.module)] as [number, number];
    let h = handles.findIndex(([a, n]) => a === key[0] && n === key[1]);
    if (h < 0) h = handles.push(key) - 1;
    fns.push([h, id(c.fn), 0, 0, 0]);
  }
  const tables: Array<[number, number[]]> = [
    [0x01, handles.flatMap(([a, n]) => [...uleb(a), ...uleb(n)])],
    [0x03, fns.flatMap((f) => f.flatMap(uleb))],
    [0x07, identifiers.flatMap((s) => [...uleb(s.length), ...Buffer.from(s)])],
    [0x08, addresses.flatMap((a) => [...Buffer.from(a.slice(2), "hex")])],
  ];
  const header: number[] = [];
  let offset = 0;
  for (const [kind, body] of tables) {
    header.push(kind, ...uleb(offset), ...uleb(body.length));
    offset += body.length;
  }
  const bytes = [0xa1, 0x1c, 0xeb, 0x0b, 6, 0, 0, 0, ...uleb(tables.length), ...header, ...tables.flatMap(([, b]) => b), 0];
  return Buffer.from(bytes).toString("base64");
}

const PKG = hex32("ad");
const SUI_BRIDGE = "0x000000000000000000000000000000000000000000000000000000000000000b";
const WORMHOLE = hex32("c0");
const FRAMEWORK = "0x0000000000000000000000000000000000000000000000000000000000000002";

function servePackage(modules: Array<{ name: string; bytes: string }>, types: Record<string, string> = {}) {
  mockSui.ledgerService.getObject.mockResolvedValue({
    response: { object: { objectId: PKG, objectType: "package", owner: { kind: GrpcTypes.Owner_OwnerKind.IMMUTABLE } } },
  });
  mockSui.movePackageService.getPackage.mockResolvedValue({
    response: { package: { originalId: PKG, version: 1n, modules: modules.map((m) => ({ name: m.name })) } },
  });
  mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown>) => {
    if (query.includes("bytes")) return { object: { asMovePackage: { modules: { pageInfo: { hasNextPage: false }, nodes: modules } } } };
    if (query.includes("multiGetObjects")) {
      return {
        multiGetObjects: (vars.keys as Array<{ address: string }>).map((k) =>
          types[k.address] ? { address: k.address, asMoveObject: { contents: { type: { repr: types[k.address] } } } } : null,
        ),
      };
    }
    return {};
  });
}

async function call(address: string) {
  const res = await runWithNetwork("mainnet", () => identify({ address }));
  return JSON.parse(res.content[0].text);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearLabeledObjectTypes();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
});

describe("identify_address on a package that calls a bridge", () => {
  it("reports a call into a curated bridge's exit entry as a carrier role, and not a VAA check or a framework call", async () => {
    servePackage([
      {
        name: "adapter",
        bytes: moduleBytes({ address: PKG, name: "adapter" }, [
          { address: FRAMEWORK, module: "coin", fn: "value" },
          { address: SUI_BRIDGE, module: "bridge", fn: "send_token" },
        ]),
      },
      {
        name: "prices",
        bytes: moduleBytes({ address: PKG, name: "prices" }, [
          { address: WORMHOLE, module: "vaa", fn: "parse_and_verify" },
          { address: PKG, module: "adapter", fn: "run" },
        ]),
      },
    ]);

    const data = await call(PKG);

    expect(data.bridge_carrier.evidence).toBe("chain-derived");
    expect(data.bridge_carrier.calls).toEqual([
      { module: "adapter", bridge: "Sui Bridge", target: `${SUI_BRIDGE}::bridge::send_token`, target_protocol: "Sui Bridge" },
    ]);
  });

  it("does not name a carrier for a same-named function in a package that is not the bridge", async () => {
    const LOOKALIKE_BRIDGE = hex32("77");
    servePackage([
      { name: "adapter", bytes: moduleBytes({ address: PKG, name: "adapter" }, [{ address: LOOKALIKE_BRIDGE, module: "bridge", fn: "send_token_batch" }]) },
    ]);

    const data = await call(PKG);

    expect(data.bridge_carrier).toBeUndefined();
  });
});

describe("identify_address names a package by the bridge label on an object it defines", () => {
  const STATE = hex32("5a");
  afterEach(() => runWithNetwork("mainnet", () => removeSessionLabel(STATE)));

  it("takes the label's name when the registry has none", async () => {
    runWithNetwork("mainnet", () => addSessionLabel(STATE, { label: "Example bridge state", category: "bridge" }, false));
    servePackage([{ name: "state", bytes: moduleBytes({ address: PKG, name: "state" }, []) }], { [STATE]: `${PKG}::state::State` });

    const data = await call(PKG);

    expect(data.protocol).toMatchObject({ name: "Example bridge state", type: "bridge", identified_via: "labeled-object" });
    expect(data.protocol.labeled_objects[0]).toMatchObject({ object: STATE, object_type: `${PKG}::state::State` });
  });
});
