import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getNetwork } from "../src/config.js";
import { capPayload } from "../src/utils/output-cap.js";
import { resetStore } from "../src/utils/store.js";

// Record the active network at the moment each client call runs, so we can
// assert the resource handler executed in the right network context.
const mockSeen: string[] = [];

const mockSui = {
  ledgerService: {
    getServiceInfo: vi.fn(async () => {
      mockSeen.push(getNetwork());
      return { response: { chainId: "abc", epoch: 1n, checkpointHeight: 2n } };
    }),
    getObject: vi.fn(async () => {
      mockSeen.push(getNetwork());
      return { response: { object: { objectId: "0x1", objectType: "0x2::x::Y" } } };
    }),
  },
  listBalances: vi.fn(async () => {
    mockSeen.push(getNetwork());
    return { balances: [] };
  }),
  listOwnedObjects: vi.fn(async () => {
    mockSeen.push(getNetwork());
    return { objects: [] };
  }),
};

vi.mock("../src/clients/grpc.js", () => ({ sui: mockSui }));

const { registerAllResources } = await import("../src/resources.js");

interface Reg {
  name: string;
  uri: string;
  handler: (uri: URL, vars?: Record<string, unknown>) => Promise<any>;
}

const regs: Reg[] = [];
const mockServer = {
  resource: (name: string, uriOrTemplate: unknown, _meta: unknown, handler: Reg["handler"]) => {
    const uri =
      typeof uriOrTemplate === "string"
        ? uriOrTemplate
        : (uriOrTemplate as { uriTemplate: { toString(): string } }).uriTemplate.toString();
    regs.push({ name, uri, handler });
  },
} as any;

registerAllResources(mockServer);

function reg(name: string): Reg {
  const r = regs.find((x) => x.name === name);
  if (!r) throw new Error(`resource '${name}' not registered`);
  return r;
}

describe("resource registration", () => {
  it("registers a default + network-scoped URI for every resource", () => {
    const byName = Object.fromEntries(regs.map((r) => [r.name, r.uri]));
    expect(byName["chain-info"]).toBe("sui://chain/info");
    expect(byName["chain-info-net"]).toBe("sui://{network}/chain/info");
    expect(byName["object"]).toBe("sui://object/{id}");
    expect(byName["object-net"]).toBe("sui://{network}/object/{id}");
    expect(byName["wallet-balances"]).toBe("sui://wallet/{address}/balances");
    expect(byName["wallet-balances-net"]).toBe("sui://{network}/wallet/{address}/balances");
    expect(byName["wallet-nfts"]).toBe("sui://wallet/{address}/nfts");
    expect(byName["wallet-nfts-net"]).toBe("sui://{network}/wallet/{address}/nfts");
    // Cases live in the local store, so they have no network-scoped variant.
    expect(byName["case"]).toBe("sui://case/{name}");
    expect(byName["result"]).toBe("sui://results/{id}");
    expect(regs).toHaveLength(10);
  });
});

describe("stored results", () => {
  it("reads the id and the page query from the URI a capped response names", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sui-results-"));
    const backup = process.env.SUI_STORE_PATH;
    process.env.SUI_STORE_PATH = join(dir, "store.db");
    resetStore();
    try {
      const rows = Array.from({ length: 5 }, (_, i) => ({ i, pad: "x".repeat(50) }));
      const { payload } = capPayload("t", {}, { rows }, { rows: { budget: 60 } }, { full: false, next_call: { tool: "t", repeat_with: { detail: "full" } } });
      const page = (payload.omitted as { lists: { rows: { page: string } } }).lists.rows.page;
      const result = await reg("result").handler(new URL(page));
      const body = JSON.parse(result.contents[0].text);
      expect(body.rows.map((r: { row: { i: number } }) => r.row.i)).toEqual([1, 2, 3, 4]);
      expect(body.total).toBe(5);
    } finally {
      resetStore();
      if (backup === undefined) delete process.env.SUI_STORE_PATH;
      else process.env.SUI_STORE_PATH = backup;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("default (non-network) resources", () => {
  beforeEach(() => {
    mockSeen.length = 0;
    vi.clearAllMocks();
  });

  it("chain-info runs on the default network (mainnet)", async () => {
    await reg("chain-info").handler(new URL("sui://chain/info"));
    expect(mockSeen).toEqual(["mainnet"]);
  });

  it("object echoes the requested URI back", async () => {
    const result = await reg("object").handler(new URL("sui://object/0xabc"), { id: "0xabc" });
    expect(result.contents[0].uri).toBe("sui://object/0xabc");
  });
});

describe("network-scoped resources", () => {
  beforeEach(() => {
    mockSeen.length = 0;
    vi.clearAllMocks();
  });

  it("runs the handler in the network from the URI", async () => {
    await reg("chain-info-net").handler(new URL("sui://testnet/chain/info"), { network: "testnet" });
    expect(mockSeen).toEqual(["testnet"]);
  });

  it("supports devnet for wallet resources", async () => {
    await reg("wallet-balances-net").handler(new URL("sui://devnet/wallet/0x1/balances"), {
      network: "devnet",
      address: "0x1",
    });
    expect(mockSeen).toEqual(["devnet"]);
    expect(mockSui.listBalances).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "0x1" }),
    );
  });

  it("falls back to the default network for an invalid network segment", async () => {
    await reg("object-net").handler(new URL("sui://bogus/object/0x1"), {
      network: "bogus",
      id: "0x1",
    });
    expect(mockSeen).toEqual(["mainnet"]);
  });
});
