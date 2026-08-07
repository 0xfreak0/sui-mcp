import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withArchiveFallback } from "../src/utils/archive-fallback.js";
import { runWithNetwork } from "../src/config.js";
import type { SuiGrpcClient } from "@mysten/sui/grpc";

// The helper takes its clients from the `sui` / `archive` proxies and archive
// availability from getNetworkConfig(). The clients are only ever passed through
// to the `call` callback, which lets the tests identify which one was used by
// identity rather than by inspecting gRPC internals.
// vi.hoisted, because vi.mock is lifted above these declarations and the factory
// now reads the clients eagerly rather than through a getter.
const { FULLNODE, ARCHIVE } = vi.hoisted(() => ({
  FULLNODE: { id: "fullnode" } as unknown as SuiGrpcClient,
  ARCHIVE: { id: "archive" } as unknown as SuiGrpcClient,
}));

vi.mock("../src/clients/grpc.js", () => ({
  sui: FULLNODE,
  archive: ARCHIVE,
}));

interface Res {
  value?: string;
}

const isEmpty = (r: Res) => !r.value;

/** Record which client each attempt used, so call order is assertable. */
function recorder(responses: Map<SuiGrpcClient, Res | Error>) {
  const used: string[] = [];
  const call = (client: SuiGrpcClient) => {
    used.push((client as unknown as { id: string }).id);
    const outcome = responses.get(client);
    if (outcome instanceof Error) return Promise.reject(outcome);
    return Promise.resolve({ response: outcome as Res });
  };
  return { call, used };
}

describe("withArchiveFallback on a network with an archive (mainnet)", () => {
  const run = <T>(fn: () => Promise<T>) => runWithNetwork("mainnet", fn);

  it("returns the fullnode response and never touches archive when it has content", async () => {
    const { call, used } = recorder(
      new Map([
        [FULLNODE, { value: "live" }],
        [ARCHIVE, { value: "archived" }],
      ]),
    );
    const res = await run(() => withArchiveFallback(call, isEmpty));
    expect(res).toEqual({ value: "live" });
    expect(used).toEqual(["fullnode"]);
  });

  it("falls back to archive when the fullnode throws", async () => {
    const { call, used } = recorder(
      new Map<SuiGrpcClient, Res | Error>([
        [FULLNODE, new Error("deadline exceeded")],
        [ARCHIVE, { value: "archived" }],
      ]),
    );
    const res = await run(() => withArchiveFallback(call, isEmpty));
    expect(res).toEqual({ value: "archived" });
    expect(used).toEqual(["fullnode", "archive"]);
  });

  // Defence in depth, not an observed failure mode: probing mainnet, pruned and
  // nonexistent data always throw NOT_FOUND rather than resolving empty. This
  // covers a node that behaves differently, and preserves the behaviour the
  // inline call sites had before they were consolidated.
  it("falls back to archive when the fullnode succeeds with an empty payload", async () => {
    const { call, used } = recorder(
      new Map([
        [FULLNODE, {}],
        [ARCHIVE, { value: "archived" }],
      ]),
    );
    const res = await run(() => withArchiveFallback(call, isEmpty));
    expect(res).toEqual({ value: "archived" });
    expect(used).toEqual(["fullnode", "archive"]);
  });

  it("keeps the fullnode response when the archive is also empty", async () => {
    const { call } = recorder(
      new Map([
        [FULLNODE, {}],
        [ARCHIVE, {}],
      ]),
    );
    await expect(run(() => withArchiveFallback(call, isEmpty))).resolves.toEqual({});
  });

  it("keeps the fullnode response when the archive retry throws", async () => {
    const { call, used } = recorder(
      new Map<SuiGrpcClient, Res | Error>([
        [FULLNODE, {}],
        [ARCHIVE, new Error("archive unavailable")],
      ]),
    );
    // Best-effort: an archive failure must not turn a usable (if empty)
    // fullnode answer into a failed tool call.
    await expect(run(() => withArchiveFallback(call, isEmpty))).resolves.toEqual({});
    expect(used).toEqual(["fullnode", "archive"]);
  });

  it("propagates the error when both fullnode and archive throw", async () => {
    const { call } = recorder(
      new Map<SuiGrpcClient, Res | Error>([
        [FULLNODE, new Error("fullnode down")],
        [ARCHIVE, new Error("archive down")],
      ]),
    );
    await expect(run(() => withArchiveFallback(call, isEmpty))).rejects.toThrow("archive down");
  });
});

describe("withArchiveFallback on a network without an archive (devnet)", () => {
  const run = <T>(fn: () => Promise<T>) => runWithNetwork("devnet", fn);

  // On devnet `archive` is the same client as the fullnode, so a retry
  // would repeat an identical request against the identical node.
  it("does not retry an empty response", async () => {
    const { call, used } = recorder(new Map([[FULLNODE, {}]]));
    await expect(run(() => withArchiveFallback(call, isEmpty))).resolves.toEqual({});
    expect(used).toEqual(["fullnode"]);
  });

  it("surfaces the original error instead of repeating the call", async () => {
    const { call, used } = recorder(
      new Map<SuiGrpcClient, Res | Error>([[FULLNODE, new Error("fullnode down")]]),
    );
    await expect(run(() => withArchiveFallback(call, isEmpty))).rejects.toThrow("fullnode down");
    expect(used).toEqual(["fullnode"]);
  });
});

describe("network selection", () => {
  let envBackup: string | undefined;
  beforeEach(() => {
    envBackup = process.env.SUI_NETWORK;
  });
  afterEach(() => {
    if (envBackup === undefined) delete process.env.SUI_NETWORK;
    else process.env.SUI_NETWORK = envBackup;
  });

  it("reads archive availability from the active call's network, not a global", async () => {
    // Same helper, same process, three concurrent calls on different networks.
    // mainnet and testnet both have an archive and must retry; devnet has none
    // and must not.
    const mainnet = recorder(
      new Map([
        [FULLNODE, {}],
        [ARCHIVE, { value: "from-mainnet-archive" }],
      ]),
    );
    const testnet = recorder(
      new Map([
        [FULLNODE, {}],
        [ARCHIVE, { value: "from-testnet-archive" }],
      ]),
    );
    const devnet = recorder(new Map([[FULLNODE, {}]]));

    const [a, b, c] = await Promise.all([
      runWithNetwork("mainnet", () => withArchiveFallback(mainnet.call, isEmpty)),
      runWithNetwork("testnet", () => withArchiveFallback(testnet.call, isEmpty)),
      runWithNetwork("devnet", () => withArchiveFallback(devnet.call, isEmpty)),
    ]);

    expect(a).toEqual({ value: "from-mainnet-archive" });
    expect(mainnet.used).toEqual(["fullnode", "archive"]);
    expect(b).toEqual({ value: "from-testnet-archive" });
    expect(testnet.used).toEqual(["fullnode", "archive"]);
    expect(c).toEqual({});
    expect(devnet.used).toEqual(["fullnode"]);
  });
});
