/**
 * Record and replay of immutable chain reads, for the live test harness.
 *
 * Off unless `SUI_REPLAY_DIR` names a directory. When it is set, the GraphQL
 * client and both gRPC clients answer a read that cannot change from a file
 * in that directory, and record such a read there the first time it goes out.
 * Every other request goes to the network as before.
 *
 * A read is replayed only when every part of its answer is fixed by the
 * request itself:
 *
 * - a transaction or its effects by digest, once the transaction is in a
 *   checkpoint;
 * - an object at a version, or as of a past checkpoint;
 * - a package at a version. GraphQL resolves `package(address:)` without one
 *   to the newest upgrade of that package, so such a root is fixed only when
 *   all it selects is `packageAt(version:)`. gRPC's `GetPackage` reads the
 *   package stored at the id, which never changes except at a reserved
 *   address, where the protocol upgrades in place;
 * - a checkpoint by number or digest;
 * - events or transactions filtered to a checkpoint range closed at both
 *   ends, the upper one {@link SETTLED_CHECKPOINTS} or more before the latest
 *   checkpoint the endpoint serves. A range open at its start moves as the
 *   endpoint prunes old rows, which it does for some filters.
 *
 * In GraphQL a nested field can read latest state under a fixed root (an
 * address's balance under a transaction's sender, the in-place framework
 * package under a Move call), so the whole selection is checked against the
 * fields that are fixed under a fixed parent, and a query with any other field
 * goes out live. A read that fails, errors or answers null is never recorded.
 *
 * Entries are keyed by the endpoint and the exact request bytes, so a changed
 * query, variable, read mask or SDK encoding is a different entry. Replay
 * cannot notice a change on the server side, so the full live pass runs
 * without it.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type * as Graphql from "graphql";
import type { DocumentNode, FieldNode, FragmentDefinitionNode, SelectionSetNode, ValueNode } from "graphql";
import type { MethodInfo, RpcInterceptor, RpcMetadata, UnaryCall } from "@protobuf-ts/runtime-rpc";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { SYSTEM_PACKAGE } from "../utils/system-packages.js";

/**
 * How far behind the endpoint's latest checkpoint a checkpoint range must end
 * before a read of it is recorded, so every indexer pipeline behind the
 * endpoint has written it.
 */
export const SETTLED_CHECKPOINTS = 1_000;

const FORMAT = "v1";

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface Entry {
  kind: "graphql" | "grpc";
  endpoint: string;
  request: unknown;
  recorded_at: string;
  /** GraphQL: the response body. gRPC: the response message, protobuf, base64. */
  response: string;
}

function keyOf(parts: string[]): string {
  const h = createHash("sha256");
  h.update(FORMAT);
  for (const p of parts) h.update(`\n${p}`);
  return h.digest("hex");
}

function entryPath(dir: string, key: string): string {
  return join(dir, key.slice(0, 2), `${key}.json`);
}

function readEntry(dir: string, key: string): Entry | null {
  const path = entryPath(dir, key);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Entry;
  } catch {
    return null;
  }
}

/**
 * Written synchronously and renamed into place, so a process killed right
 * after a read leaves either the whole entry or none, and two processes
 * recording one read never interleave. A write that fails is dropped (a
 * stray `.tmp` file is never read): the read it came from has its answer,
 * and goes out live again next time.
 */
function writeEntry(dir: string, key: string, entry: Entry): void {
  const path = entryPath(dir, key);
  try {
    mkdirSync(join(dir, key.slice(0, 2)), { recursive: true });
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(entry));
    renameSync(tmp, path);
  } catch {
    // Nothing recorded.
  }
}

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

/**
 * Where a field sits, which decides the fields allowed beneath it.
 *
 * - `data`: transaction, effects, event, checkpoint and object data.
 * - `code`: a package fixed by its version, and its modules.
 * - `lineage`: a package named only by address, which GraphQL resolves to its
 *   newest upgrade; only `packageAt(version:)` under it is fixed.
 * - `ref`: a module or function a transaction or event names. Its package may
 *   be a framework package that is upgraded in place, so only its names are
 *   fixed.
 * - `addr`: an address reached from fixed data; only its id.
 * - `owner`: an object owner.
 * - `epoch`: an epoch reached from fixed data; only its number.
 */
type Scope = "data" | "code" | "lineage" | "ref" | "addr" | "owner" | "epoch";

type FieldSet = Readonly<Record<string, true>>;
const words = (s: string): FieldSet => Object.fromEntries(s.trim().split(/\s+/).map((w) => [w, true as const]));

/** Fields fixed under fixed transaction, effects, event, checkpoint or object data. */
const DATA_FIELDS = words(`
  __typename id digest effects kind expiration gasInput sender transactionBcs transactionJson signatures
  transaction checkpoint status version lamportVersion executionError timestamp epoch events balanceChanges
  balanceChangesJson effectsBcs effectsJson effectsDigest objectChanges gasEffects unchangedConsensusObjects
  dependencies contents eventBcs sequenceNumber transactionModule artifactsDigest contentDigest
  networkTotalTransactions previousCheckpointDigest rollingGasSummary summaryBcs contentBcs validatorSignatures
  address asMoveObject asMovePackage objectBcs owner previousTransaction storageRebate hasPublicTransfer
  moveObjectBcs gasSponsor gasPrice gasBudget gasPayment signatureBytes scheme abortCode sourceLineNumber
  instructionOffset identifier constant module function message pageInfo edges nodes node cursor
  hasPreviousPage hasNextPage startCursor endCursor gasObject gasSummary computationCost storageCost
  nonRefundableStorageFee asAddress asVector bcs extract format json type repr signature layout abilities
  signersMap round commitTimestamp consensusCommitDigest subDagIndex additionalStateDigest storageCharge
  computationCharge epochStartTimestamp randomnessRound randomBytes randomnessObjInitialSharedVersion
  newActiveJwks authenticatorObjInitialSharedVersion inputs commands publicKey bitmap committee maxEpoch
  publicIdentifier jwkId authenticatorData clientDataJson object cancellationReason iss kid kty e n alg members
  threshold addressSeed proofPoints issBase64Details headerBase64 value indexMod4 weight a b c e0 e1 e2 e00
  e01 e10 e11 e20 e21 bytes initialSharedVersion mutable reservation withdrawFrom funder allowance amount
  elements coin coins arguments amounts currentPackage upgradeTicket modules ix cmd _ startVersion idCreated
  idDeleted inputState outputState coinType
`);

/** Package and module fields, fixed when the package is. */
const CODE_FIELDS = words(`
  name fullyQualifiedName bytes disassembly datatype datatypes enum enums fileFormatVersion friends function
  functions struct structs parameters return typeParameters isEntry visibility fields variants constraints
  isPhantom abilities asMoveStruct asMoveEnum module modules moduleBcs packageBcs linkage typeOrigins
  originalId upgradedId version definingId package
`);

const SCOPE_FIELDS: Record<Exclude<Scope, "data" | "code">, FieldSet> = {
  ref: words("__typename id name fullyQualifiedName module package address"),
  addr: words("__typename id address"),
  owner: words("__typename _ address initialSharedVersion startVersion"),
  epoch: words("__typename id epochId"),
  lineage: words("__typename"),
};

function allowed(scope: Scope, field: string): boolean {
  if (scope === "data") return Object.hasOwn(DATA_FIELDS, field);
  if (scope === "code") return Object.hasOwn(DATA_FIELDS, field) || Object.hasOwn(CODE_FIELDS, field);
  return Object.hasOwn(SCOPE_FIELDS[scope], field);
}

/** The scope of `field`'s value, given the scope it is selected in. */
function childScope(scope: Scope, field: string): Scope {
  switch (field) {
    case "sender":
    case "gasSponsor":
    case "funder":
    case "allowance":
    case "asAddress":
      return "addr";
    case "owner":
      return "owner";
    case "epoch":
    case "expiration":
      return "epoch";
    case "coinType":
      return "data";
    case "previousTransaction":
    case "transaction":
    case "effects":
      return "data";
    case "asMovePackage":
      return "code";
    case "address":
      return scope === "owner" ? "addr" : scope;
    case "module":
    case "function":
    case "transactionModule":
    case "package":
      return scope === "code" ? "code" : "ref";
    default:
      return scope;
  }
}

type Vars = Record<string, unknown>;

function valueOf(node: ValueNode, vars: Vars): unknown {
  switch (node.kind) {
    case "Variable":
      return vars[node.name.value];
    case "IntValue":
    case "FloatValue":
      return Number(node.value);
    case "StringValue":
    case "EnumValue":
      return node.value;
    case "BooleanValue":
      return node.value;
    case "NullValue":
      return null;
    case "ListValue":
      return node.values.map((v) => valueOf(v, vars));
    case "ObjectValue":
      return Object.fromEntries(node.fields.map((f) => [f.name.value, valueOf(f.value, vars)]));
  }
}

const given = (v: unknown): boolean => v !== undefined && v !== null;
const asCheckpoint = (v: unknown): number | null => {
  const n = typeof v === "string" || typeof v === "number" || typeof v === "bigint" ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};
const reservedPackage = (address: unknown): boolean => {
  if (typeof address !== "string") return true;
  try {
    return SYSTEM_PACKAGE.test(normalizeSuiAddress(address));
  } catch {
    return true;
  }
};

/** How a root field's answer is fixed, or null when it is not. */
interface RootRule {
  scope: Scope;
  /** The last checkpoint the answer depends on, for a checkpoint-bounded read. */
  bound?: number;
}

/**
 * The upper edge of a checkpoint-range filter closed at both ends, or null
 * when either end is open.
 */
function rangeEnd(filter: unknown): number | null {
  if (!filter || typeof filter !== "object") return null;
  const f = filter as Record<string, unknown>;
  if (!given(f.atCheckpoint) && asCheckpoint(f.afterCheckpoint) === null) return null;
  const ends: number[] = [];
  if (given(f.atCheckpoint)) {
    const at = asCheckpoint(f.atCheckpoint);
    if (at === null) return null;
    ends.push(at);
  }
  if (given(f.beforeCheckpoint)) {
    const before = asCheckpoint(f.beforeCheckpoint);
    if (before === null || before === 0) return null;
    ends.push(before - 1);
  }
  return ends.length ? Math.min(...ends) : null;
}

function rootRule(name: string, args: Record<string, unknown>): RootRule | null {
  switch (name) {
    case "transaction":
    case "transactionEffects":
      return typeof args.digest === "string" ? { scope: "data" } : null;
    case "multiGetTransactions":
    case "multiGetTransactionEffects":
    case "multiGetCheckpoints":
      return Array.isArray(args.keys) && args.keys.length > 0 ? { scope: "data" } : null;
    case "checkpoint":
      return given(args.sequenceNumber) || given(args.digest) ? { scope: "data" } : null;
    case "object": {
      if (given(args.rootVersion)) return null;
      if (given(args.version)) return { scope: "data" };
      const at = given(args.atCheckpoint) ? asCheckpoint(args.atCheckpoint) : null;
      return at === null ? null : { scope: "data", bound: at };
    }
    case "multiGetObjects": {
      const keys = Array.isArray(args.keys) ? (args.keys as Array<Record<string, unknown>>) : [];
      if (keys.length === 0) return null;
      if (keys.every((k) => k && given(k.version) && !given(k.rootVersion) && !given(k.atCheckpoint))) return { scope: "data" };
      const ats = keys.map((k) => (k && !given(k.version) && !given(k.rootVersion) ? asCheckpoint(k.atCheckpoint) : null));
      return ats.every((a) => a !== null) ? { scope: "data", bound: Math.max(...(ats as number[])) } : null;
    }
    case "package":
      if (given(args.atCheckpoint)) return null;
      return { scope: given(args.version) ? "code" : "lineage" };
    case "multiGetPackages": {
      const keys = Array.isArray(args.keys) ? (args.keys as Array<Record<string, unknown>>) : [];
      const fixed = keys.every((k) => k && given(k.version) && !given(k.atCheckpoint));
      return keys.length > 0 && fixed ? { scope: "code" } : null;
    }
    case "events":
    case "transactions": {
      const end = rangeEnd(args.filter);
      return end === null ? null : { scope: "data", bound: end };
    }
    default:
      return null;
  }
}

/** What a fixed query's answer must hold to be recorded. */
export interface GraphqlRead {
  /**
   * Response paths that must be non-null: each root, and each lookup that
   * could find something later (a package version not yet published). A
   * list along a path must hold for every element, and a list at its end
   * must have no null element.
   */
  required: string[][];
  /** The last checkpoint any answer depends on, or null when none is bounded. */
  bound: number | null;
}

// Loaded on first use rather than imported: the parser is only needed when
// SUI_REPLAY_DIR is set, and the server's normal startup stays as it was.
let graphqlModule: Promise<typeof Graphql> | null = null;
const parsed = new Map<string, DocumentNode | null>();
const PARSED_CAP = 2_000;

async function parseQuery(query: string): Promise<DocumentNode | null> {
  if (parsed.has(query)) return parsed.get(query) ?? null;
  graphqlModule ??= import("graphql");
  const { parse } = await graphqlModule;
  let doc: DocumentNode | null;
  try {
    doc = parse(query, { noLocation: true });
  } catch {
    doc = null;
  }
  if (parsed.size >= PARSED_CAP) parsed.clear();
  parsed.set(query, doc);
  return doc;
}

/**
 * Whether a GraphQL query reads only fixed data, and how, or null when any
 * part of its answer could change.
 */
export async function classifyGraphql(query: string, variables: Vars = {}): Promise<GraphqlRead | null> {
  const doc = await parseQuery(query);
  if (!doc) return null;
  const operations = doc.definitions.filter((d) => d.kind === "OperationDefinition");
  if (operations.length !== 1 || operations[0].operation !== "query") return null;
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const d of doc.definitions) if (d.kind === "FragmentDefinition") fragments.set(d.name.value, d);

  const required: string[][] = [];
  const argsOf = (field: FieldNode) =>
    Object.fromEntries((field.arguments ?? []).map((a) => [a.name.value, valueOf(a.value, variables)]));

  // Every field under `set`, through fragments, must be fixed in its scope.
  const fixed = (set: SelectionSetNode | undefined, scope: Scope, path: string[], seen: Set<string>): boolean => {
    if (!set) return true;
    for (const sel of set.selections) {
      if (sel.kind === "Field") {
        const name = sel.name.value;
        const at = [...path, sel.alias?.value ?? name];
        if (name === "packageAt" && (scope === "code" || scope === "lineage")) {
          // One version of the package's lineage: fixed once it exists.
          const args = argsOf(sel);
          if (!given(args.version) || given(args.checkpoint)) return false;
          required.push(at);
        } else if (!allowed(scope, name)) return false;
        if (!fixed(sel.selectionSet, name === "packageAt" ? "code" : childScope(scope, name), at, seen)) return false;
      } else if (sel.kind === "InlineFragment") {
        if (!fixed(sel.selectionSet, scope, path, seen)) return false;
      } else {
        const frag = fragments.get(sel.name.value);
        if (!frag || seen.has(frag.name.value)) return false;
        if (!fixed(frag.selectionSet, scope, path, new Set([...seen, frag.name.value]))) return false;
      }
    }
    return true;
  };

  const bounds: number[] = [];
  const collect = (set: SelectionSetNode, seen: Set<string>): boolean => {
    for (const sel of set.selections) {
      if (sel.kind === "InlineFragment") {
        if (!collect(sel.selectionSet, seen)) return false;
        continue;
      }
      if (sel.kind === "FragmentSpread") {
        const frag = fragments.get(sel.name.value);
        if (!frag || seen.has(frag.name.value)) return false;
        if (!collect(frag.selectionSet, new Set([...seen, frag.name.value]))) return false;
        continue;
      }
      if (sel.name.value === "__typename") continue;
      const rule = rootRule(sel.name.value, argsOf(sel));
      const key = sel.alias?.value ?? sel.name.value;
      if (!rule) return false;
      required.push([key]);
      if (rule.bound !== undefined) bounds.push(rule.bound);
      if (!fixed(sel.selectionSet, rule.scope, [key], new Set())) return false;
    }
    return true;
  };
  if (!collect(operations[0].selectionSet, new Set()) || required.length === 0) return null;
  return { required, bound: bounds.length ? Math.max(...bounds) : null };
}

/** Whether the value at `path` under `value` is non-null, through every list on the way. */
function present(value: unknown, path: string[]): boolean {
  if (Array.isArray(value)) return value.every((v) => present(v, path));
  if (value === null || value === undefined) return false;
  if (path.length === 0) return true;
  return typeof value === "object" && present((value as Record<string, unknown>)[path[0]], path.slice(1));
}

/** Whether a response to `read` is complete enough to keep: no errors, no null answer. */
export function graphqlRecordable(read: GraphqlRead, body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const { data, errors } = body as { data?: Record<string, unknown> | null; errors?: unknown };
  if (errors !== undefined || !data) return false;
  return read.required.every((path) => present(data, path));
}

const LATEST_CHECKPOINT = "query { checkpoint { sequenceNumber } }";

/**
 * Wrap a GraphQL endpoint's `fetch` so fixed reads replay from `dir` and are
 * recorded there on their first live answer.
 */
export function replayingGraphqlFetch(endpoint: string, live: typeof fetch, dir: string): typeof fetch {
  let latest: { checkpoint: number; at: number } | null = null;

  /** The endpoint's latest checkpoint, re-read when a range ends past the one known. */
  async function settled(bound: number): Promise<boolean> {
    if (latest && bound <= latest.checkpoint - SETTLED_CHECKPOINTS) return true;
    if (latest && Date.now() - latest.at < 5_000) return false;
    try {
      const res = await live(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: LATEST_CHECKPOINT }),
      });
      const body = (await res.json()) as { data?: { checkpoint?: { sequenceNumber?: unknown } } };
      const n = asCheckpoint(body.data?.checkpoint?.sequenceNumber);
      if (n === null) return false;
      latest = { checkpoint: n, at: Date.now() };
    } catch {
      return false;
    }
    return bound <= latest.checkpoint - SETTLED_CHECKPOINTS;
  }

  return async (input, init) => {
    const body = init?.body;
    if (typeof body !== "string") return live(input, init);
    let request: { query?: unknown; variables?: unknown };
    try {
      request = JSON.parse(body) as typeof request;
    } catch {
      return live(input, init);
    }
    if (typeof request.query !== "string") return live(input, init);
    const read = await classifyGraphql(request.query, (request.variables ?? {}) as Vars);
    if (!read) return live(input, init);

    const key = keyOf(["graphql", endpoint, body]);
    const hit = readEntry(dir, key);
    if (hit?.kind === "graphql") {
      return new Response(hit.response, { status: 200, headers: { "content-type": "application/json" } });
    }

    const res = await live(input, init);
    if (!res.ok) return res;
    const text = await res.text();
    let parsedBody: unknown = null;
    try {
      parsedBody = JSON.parse(text);
    } catch {
      // Not JSON: returned as-is for the client to report, never recorded.
    }
    if (graphqlRecordable(read, parsedBody) && (read.bound === null || (await settled(read.bound)))) {
      writeEntry(dir, key, {
        kind: "graphql",
        endpoint,
        request: { query: request.query, variables: request.variables ?? null },
        recorded_at: new Date().toISOString(),
        response: text,
      });
    }
    return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

// ---------------------------------------------------------------------------
// gRPC
// ---------------------------------------------------------------------------

type Msg = Record<string, unknown>;

interface ReadMask {
  paths?: string[];
}

/**
 * Whether a transaction read is final: it carries its checkpoint, or the read
 * mask asked for nothing that appears only once the checkpoint does.
 */
function finalTransaction(tx: unknown, mask: ReadMask | undefined): boolean {
  if (!tx || typeof tx !== "object") return false;
  if ((tx as Msg).checkpoint !== undefined) return true;
  const paths = mask?.paths ?? [];
  return paths.length > 0 && paths.every((p) => p !== "*" && !/^(checkpoint|timestamp)(\.|$)/.test(p));
}

const GRPC_RULES: Record<
  string,
  { replayable: (input: Msg) => boolean; recordable: (input: Msg, output: Msg) => boolean }
> = {
  "sui.rpc.v2.LedgerService/GetTransaction": {
    replayable: (i) => typeof i.digest === "string" && i.digest !== "",
    recordable: (i, o) => finalTransaction(o.transaction, i.readMask as ReadMask),
  },
  "sui.rpc.v2.LedgerService/BatchGetTransactions": {
    replayable: (i) => Array.isArray(i.digests) && i.digests.length > 0,
    recordable: (i, o) => {
      const results = (o.transactions ?? []) as Array<{ result?: { oneofKind?: string; transaction?: unknown } }>;
      return (
        results.length === (i.digests as unknown[]).length &&
        results.every((r) => r.result?.oneofKind === "transaction" && finalTransaction(r.result.transaction, i.readMask as ReadMask))
      );
    },
  },
  "sui.rpc.v2.LedgerService/GetObject": {
    replayable: (i) => i.version !== undefined,
    recordable: (_i, o) => o.object !== undefined,
  },
  "sui.rpc.v2.LedgerService/BatchGetObjects": {
    replayable: (i) =>
      Array.isArray(i.requests) && i.requests.length > 0 && (i.requests as Msg[]).every((r) => r.version !== undefined),
    recordable: (i, o) => {
      const results = (o.objects ?? []) as Array<{ result?: { oneofKind?: string } }>;
      return results.length === (i.requests as unknown[]).length && results.every((r) => r.result?.oneofKind === "object");
    },
  },
  "sui.rpc.v2.LedgerService/GetCheckpoint": {
    replayable: (i) => {
      const kind = (i.checkpointId as { oneofKind?: string } | undefined)?.oneofKind;
      return kind === "sequenceNumber" || kind === "digest";
    },
    recordable: (_i, o) => o.checkpoint !== undefined,
  },
  "sui.rpc.v2.MovePackageService/GetPackage": {
    replayable: (i) => !reservedPackage(i.packageId),
    recordable: (_i, o) => o.package !== undefined,
  },
  "sui.rpc.v2.MovePackageService/GetDatatype": {
    replayable: (i) => !reservedPackage(i.packageId),
    recordable: (_i, o) => o.datatype !== undefined,
  },
  "sui.rpc.v2.MovePackageService/GetFunction": {
    replayable: (i) => !reservedPackage(i.packageId),
    recordable: (_i, o) => o.function !== undefined,
  },
};

const methodId = (method: MethodInfo): string => `${method.service.typeName}/${method.name}`;

/**
 * A unary call over the given parts, awaitable as protobuf-ts's own
 * `UnaryCall` is. Like it, the combined result is built only when awaited, so
 * a caller that reads `response` alone leaves no rejection unhandled.
 */
function unaryCall(
  method: MethodInfo,
  request: object,
  requestHeaders: RpcMetadata,
  parts: Pick<UnaryCall<object, object>, "headers" | "response" | "status" | "trailers">,
): UnaryCall<object, object> {
  return {
    method,
    requestHeaders,
    request,
    ...parts,
    then: (onfulfilled, onrejected) =>
      Promise.all([parts.headers, parts.response, parts.status, parts.trailers])
        .then(([headers, response, status, trailers]) => ({ method, requestHeaders, request, headers, response, status, trailers }))
        .then(onfulfilled, onrejected),
  } as UnaryCall<object, object>;
}

/**
 * A gRPC interceptor for one endpoint (`target`) that replays fixed reads
 * from `dir` and records them there on their first live answer. A live call
 * resolves only once its answer is written, so a read that completed is on
 * disk before its caller moves on.
 */
export function replayInterceptor(target: string, dir: string): RpcInterceptor {
  return {
    interceptUnary(next, method, input, options) {
      const rule = GRPC_RULES[methodId(method)];
      if (!rule?.replayable(input as Msg)) return next(method, input, options);
      const request = Buffer.from(method.I.toBinary(input)).toString("base64");
      const key = keyOf(["grpc", target, methodId(method), request]);
      const hit = readEntry(dir, key);
      if (hit?.kind === "grpc") {
        return unaryCall(method, input, options.meta ?? {}, {
          headers: Promise.resolve({}),
          response: Promise.resolve(method.O.fromBinary(Buffer.from(hit.response, "base64"))),
          status: Promise.resolve({ code: "OK", detail: "" }),
          trailers: Promise.resolve({}),
        });
      }
      const call = next(method, input, options);
      const response = Promise.all([call.response, call.status]).then(([answer, status]) => {
        if (status.code === "OK" && rule.recordable(input as Msg, answer as Msg)) {
          try {
            writeEntry(dir, key, {
              kind: "grpc",
              endpoint: target,
              request: { method: methodId(method), input: method.I.toJson(input) },
              recorded_at: new Date().toISOString(),
              response: Buffer.from(method.O.toBinary(answer)).toString("base64"),
            });
          } catch {
            // An answer the SDK cannot serialise again is not recorded.
          }
        }
        return answer;
      });
      return unaryCall(method, input, call.requestHeaders, { headers: call.headers, response, status: call.status, trailers: call.trailers });
    },
  };
}
