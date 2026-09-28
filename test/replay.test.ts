import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { mergeRpcOptions, UnaryCall, type MethodInfo, type RpcOptions, type RpcTransport } from "@protobuf-ts/runtime-rpc";
import { classifyGraphql, graphqlRecordable, replayingGraphqlFetch, replayInterceptor, SETTLED_CHECKPOINTS } from "../src/clients/replay.js";

const DIGEST = "3Ytv1Yb4bGU7sxKfPvqPk3cWXJ9QqDbQdV1rTgAdNcPj";
const PKG = "0x" + "ab".repeat(32);
const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "replay-test-"));
  dirs.push(d);
  return d;
};
const entries = (dir: string) => readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(".json")).length;

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("which GraphQL reads replay", () => {
  const fixed = async (query: string, variables: Record<string, unknown> = {}) => (await classifyGraphql(query, variables)) !== null;

  it("replays a transaction by digest and the fixed data under it", async () => {
    const q = `query($d: String!) { transaction(digest: $d) { digest sender { address }
      effects { status timestamp checkpoint { sequenceNumber } epoch { epochId }
        balanceChanges(first: 50) { pageInfo { hasNextPage endCursor } nodes { owner { address } coinType { repr } amount } }
        objectChanges { nodes { address outputState { version owner { ... on AddressOwner { address { address } } } asMoveObject { contents { json type { repr } } } } } } } } }`;
    expect(await fixed(q, { d: DIGEST })).toBe(true);
  });

  it("goes live for latest state reached through a fixed root", async () => {
    expect(await fixed(`{ transaction(digest: "${DIGEST}") { sender { balance(coinType: "0x2::sui::SUI") { totalBalance } } } }`)).toBe(false);
    expect(await fixed(`{ transaction(digest: "${DIGEST}") { effects { epoch { endTimestamp } } } }`)).toBe(false);
    expect(await fixed(`{ object(address: "${PKG}", version: 3) { asMoveObject { contents { display { output } } } } }`)).toBe(false);
    expect(await fixed(`{ object(address: "${PKG}", version: 3) { objectVersionsAfter { nodes { version } } } }`)).toBe(false);
  });

  it("keeps a called function to its names, since a framework package is upgraded in place", async () => {
    const call = (inner: string) =>
      `{ transaction(digest: "${DIGEST}") { kind { ... on ProgrammableTransaction { commands { nodes { ... on MoveCallCommand { function { ${inner} } } } } } } } }`;
    expect(await fixed(call("name module { name package { address } }"))).toBe(true);
    expect(await fixed(call("name parameters { repr }"))).toBe(false);
    expect(await fixed(call("module { package { version } }"))).toBe(false);
  });

  it("replays an object only at a version or a past checkpoint", async () => {
    expect(await fixed(`{ object(address: "${PKG}") { version } }`)).toBe(false);
    expect(await fixed(`{ object(address: "${PKG}", rootVersion: 9) { version } }`)).toBe(false);
    expect(await fixed(`{ object(address: "${PKG}", version: 9) { version digest } }`)).toBe(true);
    expect((await classifyGraphql(`{ object(address: "${PKG}", atCheckpoint: 70) { version } }`))?.bound).toBe(70);
    expect(await fixed(`{ multiGetObjects(keys: [{ address: "${PKG}", version: 1 }, { address: "${PKG}" }]) { version } }`)).toBe(false);
    expect(await fixed(`{ multiGetObjects(keys: [{ address: "${PKG}", version: 1, atCheckpoint: 5 }]) { version } }`)).toBe(false);
  });

  it("replays a package only at a version, since an address alone resolves to its newest upgrade", async () => {
    expect(await fixed(`{ package(address: "${PKG}") { address version } }`)).toBe(false);
    expect(await fixed(`{ package(address: "${PKG}") { modules { nodes { name bytes } } linkage { upgradedId version } } }`)).toBe(false);
    expect(await fixed(`{ package(address: "${PKG}", version: 1) { modules { nodes { name bytes } } linkage { upgradedId version } } }`)).toBe(true);
    expect(await fixed(`{ package(address: "0x2", version: 40) { module(name: "coin") { bytes } } }`)).toBe(true);
    expect(await fixed(`{ package(address: "${PKG}", atCheckpoint: 9) { version } }`)).toBe(false);
    expect(await fixed(`{ package(address: "${PKG}", version: 1) { packageVersionsAfter { nodes { address } } } }`)).toBe(false);
    expect(await fixed(`{ multiGetPackages(keys: [{ address: "${PKG}", version: 1 }, { address: "${PKG}", version: 2 }]) { bytes: packageBcs } }`)).toBe(true);
    expect(await fixed(`{ multiGetPackages(keys: [{ address: "${PKG}", version: 1 }, { address: "${PKG}" }]) { packageBcs } }`)).toBe(false);
  });

  it("replays one version of a package's lineage, and nothing else read through the address", async () => {
    const at = await classifyGraphql(`{ p: package(address: "${PKG}") { __typename v3: packageAt(version: 3) { address modules { nodes { name } } } } }`);
    expect(at?.required).toContainEqual(["p", "v3"]);
    expect(await fixed(`{ package(address: "0x2") { packageAt(version: 40) { module(name: "coin") { bytes } } } }`)).toBe(true);
    expect(await fixed(`{ package(address: "${PKG}") { version packageAt(version: 3) { address } } }`)).toBe(false);
    expect(await fixed(`{ package(address: "${PKG}") { packageAt(checkpoint: 5) { address } } }`)).toBe(false);
    expect(await fixed(`{ package(address: "${PKG}") { packageAt { address } } }`)).toBe(false);
  });

  it("replays events or transactions only over a range closed at both ends", async () => {
    const events = (filter: string) => classifyGraphql(`{ events(first: 50, filter: { ${filter} }) { nodes { sequenceNumber contents { json } } } }`);
    expect(await events(`type: "0x2::coin::X", afterCheckpoint: 10`)).toBeNull();
    expect(await events(`type: "0x2::coin::X", beforeCheckpoint: 100`)).toBeNull();
    expect((await events(`type: "0x2::coin::X", afterCheckpoint: 10, beforeCheckpoint: 100`))?.bound).toBe(99);
    expect((await events(`atCheckpoint: 50, beforeCheckpoint: 100`))?.bound).toBe(50);
    const txs = (b: unknown) =>
      classifyGraphql(`query($a: SuiAddress, $f: UInt53, $b: UInt53) { transactions(filter: { affectedAddress: $a, afterCheckpoint: $f, beforeCheckpoint: $b }) { nodes { digest } } }`, { a: PKG, f: 5, b });
    expect((await txs(200))?.bound).toBe(199);
    expect(await txs(null)).toBeNull();
    expect(await classifyGraphql(`{ transactions(filter: { affectedAddress: "${PKG}" }) { nodes { digest } } }`)).toBeNull();
  });

  it("never replays an address read, even as of a past checkpoint", async () => {
    expect(await fixed(`{ address(address: "${PKG}", atCheckpoint: 9) { balance(coinType: "0x2::sui::SUI") { totalBalance } } }`)).toBe(false);
    expect(await fixed(`{ address(address: "${PKG}") { balance(coinType: "0x2::sui::SUI") { totalBalance } } }`)).toBe(false);
  });

  it("needs every root fixed, through aliases and fragments", async () => {
    expect(await fixed(`{ a: transaction(digest: "${DIGEST}") { digest } b: checkpoint { sequenceNumber } }`)).toBe(false);
    expect(await fixed(`{ a: transaction(digest: "${DIGEST}") { digest } b: checkpoint(sequenceNumber: 5) { timestamp } }`)).toBe(true);
    expect(await fixed(`query { transaction(digest: "${DIGEST}") { ...T } } fragment T on Transaction { digest effects { status } }`)).toBe(true);
    expect(await fixed(`query { transaction(digest: "${DIGEST}") { ...T } } fragment T on Transaction { sender { objects { nodes { address } } } }`)).toBe(false);
    expect(await fixed(`mutation { transaction(digest: "${DIGEST}") { digest } }`)).toBe(false);
    expect(await fixed(`not graphql {`)).toBe(false);
  });
});

describe("which GraphQL answers are recorded", () => {
  it("records only an answer with no error and no missing value", async () => {
    const read = (await classifyGraphql(`{ multiGetTransactions(keys: ["a", "b"]) { digest } p: package(address: "${PKG}") { v: packageAt(version: 2) { address } } }`))!;
    const body = (tx: unknown, pkg: unknown) => ({ data: { multiGetTransactions: tx, p: pkg } });
    expect(graphqlRecordable(read, body([{ digest: "a" }, { digest: "b" }], { v: { address: PKG } }))).toBe(true);
    expect(graphqlRecordable(read, body([{ digest: "a" }, null], { v: { address: PKG } }))).toBe(false);
    expect(graphqlRecordable(read, body([{ digest: "a" }, { digest: "b" }], { v: null }))).toBe(false);
    expect(graphqlRecordable(read, { ...body([], { v: {} }), errors: [{ message: "boom" }] })).toBe(false);
  });
});

describe("replaying GraphQL through fetch", () => {
  const ENDPOINT = "https://graphql.example/graphql";
  const post = (query: string, variables?: unknown) => ({ method: "POST", body: JSON.stringify({ query, variables }) });

  /** A fake endpoint: a fixed latest checkpoint and a counter of the requests it saw. */
  function endpoint(latest: number, answer: (query: string) => unknown) {
    const seen: string[] = [];
    const live = (async (_input: unknown, init?: RequestInit) => {
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      seen.push(query);
      const data = query.includes("checkpoint { sequenceNumber }") && !query.includes("digest") ? { data: { checkpoint: { sequenceNumber: latest } } } : answer(query);
      return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { live, seen };
  }

  it("records a fixed read once and replays it without the network", async () => {
    const dir = scratch();
    const { live, seen } = endpoint(0, () => ({ data: { transaction: { digest: DIGEST } } }));
    const f = replayingGraphqlFetch(ENDPOINT, live, dir);
    const q = "query($d: String!) { transaction(digest: $d) { digest } }";
    const first = await (await f(ENDPOINT, post(q, { d: DIGEST }))).json();
    const second = await (await f(ENDPOINT, post(q, { d: DIGEST }))).json();
    expect(second).toEqual(first);
    expect(seen).toHaveLength(1);
    await f(ENDPOINT, post(q, { d: "other" }));
    expect(seen).toHaveLength(2);
  });

  it("still answers when the recording cannot be written", async () => {
    const file = join(scratch(), "not-a-dir");
    writeFileSync(file, "");
    const { live } = endpoint(0, () => ({ data: { transaction: { digest: DIGEST } } }));
    const f = replayingGraphqlFetch(ENDPOINT, live, join(file, "replay"));
    const body = await (await f(ENDPOINT, post(`{ transaction(digest: "${DIGEST}") { digest } }`))).json();
    expect(body).toEqual({ data: { transaction: { digest: DIGEST } } });
  });

  it("always sends a latest read, an error, or a not-found live", async () => {
    const dir = scratch();
    const { live, seen } = endpoint(0, (q) =>
      q.includes("broken") ? { errors: [{ message: "bad" }] } : q.includes("object") ? { data: { object: { version: 1 } } } : { data: { transaction: null } },
    );
    const f = replayingGraphqlFetch(ENDPOINT, live, dir);
    for (const q of [`{ object(address: "${PKG}") { version } }`, `{ transaction(digest: "missing") { digest } }`, `{ transaction(digest: "broken") { digest } }`]) {
      await f(ENDPOINT, post(q));
      await f(ENDPOINT, post(q));
    }
    expect(seen).toHaveLength(6);
    expect(entries(dir)).toBe(0);
  });

  it("records a checkpoint range only once it has settled behind the latest checkpoint", async () => {
    const dir = scratch();
    const { live, seen } = endpoint(10_000, () => ({ data: { events: { nodes: [] } } }));
    const f = replayingGraphqlFetch(ENDPOINT, live, dir);
    const recent = `{ events(filter: { afterCheckpoint: 0, beforeCheckpoint: ${10_000 - SETTLED_CHECKPOINTS + 10} }) { nodes { sequenceNumber } } }`;
    const settled = `{ events(filter: { afterCheckpoint: 0, beforeCheckpoint: ${10_000 - SETTLED_CHECKPOINTS} }) { nodes { sequenceNumber } } }`;
    await f(ENDPOINT, post(recent));
    await f(ENDPOINT, post(settled));
    expect(entries(dir)).toBe(1);
    const before = seen.length;
    await f(ENDPOINT, post(settled));
    await f(ENDPOINT, post(recent));
    expect(seen.length - before).toBe(1);
  });
});

describe("replaying gRPC through an interceptor", () => {
  /** A fake transport answering each call from `answer`, counting the calls that reach it. */
  function transport(dir: string, answer: (method: MethodInfo, input: object) => object | Error) {
    const calls: string[] = [];
    const t: RpcTransport & { defaultOptions: RpcOptions } = {
      defaultOptions: { interceptors: [replayInterceptor("fullnode.example", dir)] },
      mergeOptions(options?: Partial<RpcOptions>) {
        return mergeRpcOptions(this.defaultOptions, options);
      },
      unary(method, input) {
        calls.push(method.name);
        const out = answer(method, input as object);
        const failed = out instanceof Error;
        const response = failed ? Promise.reject(out) : Promise.resolve(method.O.create(out as never));
        response.catch(() => {});
        const status = Promise.resolve(failed ? { code: "NOT_FOUND", detail: out.message } : { code: "OK", detail: "" });
        return new UnaryCall(method, {}, input, Promise.resolve({}), response, status, Promise.resolve({})) as never;
      },
      serverStreaming: () => {
        throw new Error("unused");
      },
      clientStreaming: () => {
        throw new Error("unused");
      },
      duplex: () => {
        throw new Error("unused");
      },
    };
    return { client: new SuiGrpcClient({ network: "mainnet", transport: t }), calls };
  }

  it("replays a finalized transaction by digest", async () => {
    const dir = scratch();
    const { client, calls } = transport(dir, () => ({ transaction: { digest: DIGEST, checkpoint: 42n } }));
    const first = await client.ledgerService.getTransaction({ digest: DIGEST });
    const second = await client.ledgerService.getTransaction({ digest: DIGEST });
    expect(second.response).toEqual(first.response);
    expect(calls).toEqual(["GetTransaction"]);
  });

  it("does not record a transaction not yet in a checkpoint, or a failed read", async () => {
    const dir = scratch();
    const { client, calls } = transport(dir, (_m, input) =>
      (input as { digest?: string }).digest === "gone" ? new Error("not found") : { transaction: { digest: DIGEST } },
    );
    for (let i = 0; i < 2; i++) {
      await client.ledgerService.getTransaction({ digest: DIGEST });
      await client.ledgerService.getTransaction({ digest: "gone" }).then(
        () => {},
        () => {},
      );
    }
    expect(calls).toHaveLength(4);
    expect(entries(dir)).toBe(0);
  });

  it("replays an object only at a version, and a package only off the reserved addresses", async () => {
    const dir = scratch();
    const { client, calls } = transport(dir, (m) => (m.name === "GetObject" ? { object: { objectId: PKG, version: 7n } } : { package: { storageId: PKG } }));
    for (let i = 0; i < 2; i++) {
      await client.ledgerService.getObject({ objectId: PKG });
      await client.ledgerService.getObject({ objectId: PKG, version: 7n });
      await client.movePackageService.getPackage({ packageId: "0x2" });
      await client.movePackageService.getPackage({ packageId: PKG });
    }
    expect(calls.filter((c) => c === "GetObject")).toHaveLength(3);
    expect(calls.filter((c) => c === "GetPackage")).toHaveLength(3);
  });
});
