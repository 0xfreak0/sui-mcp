/**
 * Resolve a Programmable Transaction Block's inputs and command arguments.
 *
 * One resolver serves `decode_ptb` (bytes or a digest) and `get_transaction`
 * with `detail: 'full'`, so both describe a PTB the same way. It works on the
 * SDK's transaction data (`Transaction.from(bytes).getData()`): the bytes a
 * wallet is asked to sign and the BCS a node returns for an executed
 * transaction decode to the same shape.
 *
 * - An object input carries its id and, when the transaction executed, the
 *   version it was read at and its type, from the transaction's effects and
 *   object set.
 * - A pure input is decoded with the type the called function declares for
 *   that argument (a SplitCoins amount is a u64, a TransferObjects recipient
 *   an address). A pure input whose type cannot be derived, or whose bytes do
 *   not decode as that type exactly, stays as base64 bytes.
 * - A Result or NestedResult names the command that produced it; a Move
 *   call lists its declared return types.
 */
import { bcs, TypeTagSerializer, type BcsType, type TypeTag } from "@mysten/sui/bcs";
import { fromBase64, normalizeSuiAddress, toHex } from "@mysten/sui/utils";
import { Transaction, type TransactionData } from "@mysten/sui/transactions";
import type { SuiClientTypes } from "@mysten/sui/client";
import type { GrpcTypes } from "@mysten/sui/grpc";
import { sui } from "../clients/grpc.js";
import { getNetwork } from "../config.js";
import { lookupProtocolDisplay, lookupOperation, prefetchProtocolNames } from "../protocols/registry.js";
import { shortType } from "./object-flow.js";
import { resultUri } from "./output-cap.js";
import { signedReading } from "./signed-int.js";
import { isPlumbingPackage } from "./system-packages.js";

type Body = SuiClientTypes.OpenSignatureBody;
type Loose = { $kind: string } & Record<string, unknown>;
type Out = Record<string, unknown>;

/** The SDK's transaction data, loosely typed the way the formatters read it. */
export interface PtbData {
  inputs: unknown[];
  commands: unknown[];
}

/** An executed input object's version at execution and its type. */
export interface ExecutedObject {
  version: string | null;
  type: string | null;
}

/** Executed objects by normalized id. */
export type ExecutedObjects = Map<string, ExecutedObject>;

/** Read-mask paths for the object set: every object the transaction read or wrote, with its type. */
export const EXECUTED_OBJECT_PATHS = [
  "objects.objects.object_id",
  "objects.objects.version",
  "objects.objects.object_type",
];

/** `sui.rpc.v2.ChangedObject.InputObjectState.EXISTS` */
const INPUT_EXISTS = 2;
/** `sui.rpc.v2.ChangedObject.OutputObjectState.ACCUMULATOR_WRITE` */
const OUTPUT_ACCUMULATOR_WRITE = 4;

/**
 * The version each input object was read at, and its type, from an executed
 * transaction. A changed object's input version and an unchanged consensus
 * object's version are exact. The object set fills the type of anything the
 * effects do not list (an immutable input), at the lowest version it holds,
 * which is the one the transaction read.
 */
export function executedObjects(tx: GrpcTypes.ExecutedTransaction | undefined): ExecutedObjects {
  const out: ExecutedObjects = new Map();
  for (const c of tx?.effects?.changedObjects ?? []) {
    if (!c.objectId || c.outputState === OUTPUT_ACCUMULATOR_WRITE) continue;
    out.set(normalizeSuiAddress(c.objectId), {
      version: c.inputState === INPUT_EXISTS && c.inputVersion !== undefined ? c.inputVersion.toString() : null,
      type: c.objectType ?? null,
    });
  }
  for (const u of tx?.effects?.unchangedConsensusObjects ?? []) {
    if (!u.objectId) continue;
    const id = normalizeSuiAddress(u.objectId);
    if (out.has(id)) continue;
    out.set(id, { version: u.version !== undefined ? u.version.toString() : null, type: u.objectType ?? null });
  }
  const lowest = new Map<string, { version: bigint | undefined; type: string | null }>();
  for (const o of tx?.objects?.objects ?? []) {
    if (!o.objectId) continue;
    const id = normalizeSuiAddress(o.objectId);
    const seen = lowest.get(id);
    if (!seen || (o.version !== undefined && (seen.version === undefined || o.version < seen.version))) {
      lowest.set(id, { version: o.version, type: o.objectType ?? seen?.type ?? null });
    }
  }
  for (const [id, o] of lowest) {
    const known = out.get(id);
    if (known) {
      if (!known.type && o.type) known.type = o.type;
    } else {
      out.set(id, { version: o.version !== undefined ? o.version.toString() : null, type: o.type });
    }
  }
  return out;
}

/** Sui's `TransactionKind` index of a user's programmable transaction. */
const KIND_PROGRAMMABLE = 0;
/**
 * Sui's `TransactionKind` index of a programmable system transaction: a PTB
 * the protocol runs, which the SDK's BCS schema does not decode. Indices 1 to
 * 9 are system transactions with no commands.
 */
const KIND_PROGRAMMABLE_SYSTEM = 10;

/**
 * A transaction's PTB read from its BCS. `data` is null when there is none to
 * read: `unread` is null for a system transaction, which has no commands, and
 * says why otherwise.
 */
export type BcsPtb =
  | { data: TransactionData; unread: null }
  | { data: null; unread: string | null };

/** The ULEB128 at `offset` and the offset after it, or null past the end. */
function readUleb(bytes: Uint8Array, offset: number): { value: number; next: number } | null {
  let value = 0;
  for (let shift = 0, i = offset; i < bytes.length && shift < 35; shift += 7, i++) {
    value += (bytes[i] & 0x7f) * 2 ** shift;
    if ((bytes[i] & 0x80) === 0) return { value, next: i + 1 };
  }
  return null;
}

/**
 * Transaction data from BCS bytes. `TransactionData` is an enum whose one
 * variant, V1, starts with the `TransactionKind`, so the kind is the second
 * ULEB128 in the bytes and is read before any parse.
 */
export function ptbDataFromBcs(bytes: Uint8Array): BcsPtb {
  const version = readUleb(bytes, 0);
  const kind = version?.value === 0 ? readUleb(bytes, version.next) : null;
  if (kind === null || kind.value === KIND_PROGRAMMABLE) {
    return { data: Transaction.from(bytes).getData(), unread: null };
  }
  if (kind.value === KIND_PROGRAMMABLE_SYSTEM) {
    return { data: null, unread: `It is a programmable system transaction (TransactionKind ${KIND_PROGRAMMABLE_SYSTEM}), a PTB the protocol runs, which the SDK's BCS reader does not decode.` };
  }
  if (kind.value > KIND_PROGRAMMABLE_SYSTEM) {
    return { data: null, unread: `Its TransactionKind ${kind.value} is newer than the SDK's BCS reader knows.` };
  }
  return { data: null, unread: null };
}

// --- Move signatures --------------------------------------------------------

/** A Move function's parameter and return types; at a call site, with its type arguments substituted. */
interface MoveSignature {
  parameters: Body[];
  returns: Body[];
}

/** Signatures by `network:package::module::function`. A package never changes, so a hit never goes stale. */
const signatures = new Map<string, Promise<MoveSignature | null>>();

function readSignature(pkg: string, module: string, fn: string): Promise<MoveSignature | null> {
  const key = `${getNetwork()}:${normalizeSuiAddress(pkg)}::${module}::${fn}`;
  let pending = signatures.get(key);
  if (!pending) {
    pending = sui
      .getMoveFunction({ packageId: pkg, moduleName: module, name: fn })
      .then((r) => ({
        parameters: r.function.parameters.map((p) => p.body),
        returns: r.function.returns.map((p) => p.body),
      }))
      .catch(() => {
        // A failed read is retried by the next caller rather than cached.
        signatures.delete(key);
        return null;
      });
    signatures.set(key, pending);
  }
  return pending;
}

const STD = normalizeSuiAddress("0x1");
const FRAMEWORK = normalizeSuiAddress("0x2");

/** BCS layouts of the primitive types, by signature kind. */
const PRIMITIVE_SCHEMA: Record<string, BcsType<unknown>> = {
  address: bcs.Address as BcsType<unknown>,
  bool: bcs.Bool as BcsType<unknown>,
  u8: bcs.U8 as BcsType<unknown>,
  u16: bcs.U16 as BcsType<unknown>,
  u32: bcs.U32 as BcsType<unknown>,
  u64: bcs.U64 as BcsType<unknown>,
  u128: bcs.U128 as BcsType<unknown>,
  u256: bcs.U256 as BcsType<unknown>,
};

function typeTagToBody(tag: TypeTag): Body {
  if ("vector" in tag) return { $kind: "vector", vector: typeTagToBody(tag.vector) };
  if ("struct" in tag) {
    const s = tag.struct;
    return {
      $kind: "datatype",
      datatype: {
        typeName: `${normalizeSuiAddress(s.address)}::${s.module}::${s.name}`,
        typeParameters: s.typeParams.map(typeTagToBody),
      },
    };
  }
  const [kind] = Object.keys(tag);
  return kind in PRIMITIVE_SCHEMA ? ({ $kind: kind } as Body) : { $kind: "unknown" };
}

/** A type argument string as a signature body; `unknown` when it does not parse. */
function typeArgBody(typeArg: string): Body {
  try {
    return typeTagToBody(TypeTagSerializer.parseFromStr(typeArg, true));
  } catch {
    return { $kind: "unknown" };
  }
}

/** Substitute a call's type arguments for the type parameters in a declared type. */
function instantiate(body: Body, typeArgs: Body[]): Body {
  switch (body.$kind) {
    case "typeParameter":
      return typeArgs[body.index] ?? body;
    case "vector":
      return { $kind: "vector", vector: instantiate(body.vector, typeArgs) };
    case "datatype":
      return {
        $kind: "datatype",
        datatype: {
          typeName: body.datatype.typeName,
          typeParameters: body.datatype.typeParameters.map((t) => instantiate(t, typeArgs)),
        },
      };
    default:
      return body;
  }
}

/** A signature body as Move writes the type. */
export function formatSdkSignatureBody(body: Body): string {
  switch (body.$kind) {
    case "vector":
      return `vector<${formatSdkSignatureBody(body.vector)}>`;
    case "datatype":
      return body.datatype.typeParameters.length > 0
        ? `${body.datatype.typeName}<${body.datatype.typeParameters.map(formatSdkSignatureBody).join(", ")}>`
        : body.datatype.typeName;
    case "typeParameter":
      return `T${body.index}`;
    default:
      return body.$kind;
  }
}

// --- Pure values ------------------------------------------------------------


/** The BCS layout of a type a pure argument can carry, or null for any other type. */
function pureSchema(body: Body): BcsType<unknown> | null {
  switch (body.$kind) {
    case "vector": {
      if (body.vector.$kind === "u8") return bcs.byteVector() as BcsType<unknown>;
      const inner = pureSchema(body.vector);
      return inner ? (bcs.vector(inner) as BcsType<unknown>) : null;
    }
    case "datatype": {
      const [pkg, module, name] = body.datatype.typeName.split("::");
      const address = normalizeSuiAddress(pkg ?? "");
      if (address === STD && (module === "string" || module === "ascii") && name === "String") return bcs.String as BcsType<unknown>;
      if (address === STD && module === "option" && name === "Option") {
        const inner = body.datatype.typeParameters[0] ? pureSchema(body.datatype.typeParameters[0]) : null;
        return inner ? (bcs.option(inner) as BcsType<unknown>) : null;
      }
      if (address === FRAMEWORK && module === "object" && name === "ID") return bcs.Address as BcsType<unknown>;
      return null;
    }
    default:
      return PRIMITIVE_SCHEMA[body.$kind] ?? null;
  }
}

/** A decoded BCS value as JSON: byte vectors as 0x-hex, integers above u32 as the strings BCS returns. */
function jsonValue(v: unknown): unknown {
  if (v instanceof Uint8Array) return `0x${toHex(v)}`;
  if (Array.isArray(v)) return v.map(jsonValue);
  return v;
}

/**
 * Decode pure bytes as a declared type. Undefined when the type is not one a
 * pure argument can carry, or the bytes are not exactly one value of it: a
 * value that leaves bytes over, or runs short, is not that type.
 */
function decodePure(body: Body, raw: Uint8Array): { value: unknown } | undefined {
  const schema = pureSchema(body);
  if (!schema) return undefined;
  try {
    const value = schema.parse(raw);
    if (schema.serialize(value).toBytes().length !== raw.length) return undefined;
    return { value: jsonValue(value) };
  } catch {
    return undefined;
  }
}

/**
 * A Pure input's bytes. `address` is set when they are exactly 32 bytes, which
 * is address-shaped but not proof: a u256, an `ID` and a 31-byte string
 * (a length byte plus 31 content bytes) are also 32 bytes.
 */
function pureBytes(input: Loose | undefined): { raw: Uint8Array; address: string | null } | null {
  if (!input || input.$kind !== "Pure") return null;
  try {
    const raw = fromBase64((input.Pure as { bytes: string }).bytes);
    return { raw, address: raw.length === 32 ? `0x${toHex(raw)}` : null };
  } catch {
    return null;
  }
}

/**
 * A pure input decoded as `type`, or its base64 bytes when it is not exactly
 * one value of that type. A decoded address sits under `address`, the key the
 * anomaly pass reads a recipient from; undecoded 32 bytes carry the
 * address-shaped guess under `guessKey`. A `u64`, `u128` or `u256` with its
 * top bit set also carries `signed_value`, its two's-complement reading,
 * since signed quantities travel in unsigned integers.
 */
function resolvePure(input: Loose, type: Body | undefined, guessKey: "address" | "possible_address"): Out {
  const pure = pureBytes(input);
  const decoded = pure && type ? decodePure(type, pure.raw) : undefined;
  if (decoded && type) {
    const valueType = formatSdkSignatureBody(type);
    if (valueType === "address") return { value_type: valueType, address: decoded.value };
    const bits = /^u(64|128|256)$/.exec(valueType)?.[1];
    const negative = bits && typeof decoded.value === "string" ? signedReading(decoded.value, Number(bits)) : null;
    return { value_type: valueType, value: decoded.value, ...(negative ? { signed_value: negative } : {}) };
  }
  return { bytes: (input.Pure as { bytes: string }).bytes, ...(pure?.address ? { [guessKey]: pure.address } : {}) };
}

// --- Inputs -----------------------------------------------------------------

function formatObjectInput(input: Loose, executed: ExecutedObjects | undefined): Out {
  const obj = input.Object as Loose;
  const withExecuted = (objectId: string, own: Out, version: string | null): Out => {
    const e = executed?.get(normalizeSuiAddress(objectId));
    return {
      object_id: objectId,
      ...own,
      // An owned or receiving input names its version; a shared one's comes
      // from the effects.
      version: version ?? e?.version ?? null,
      object_type: e?.type ?? null,
    };
  };
  switch (obj.$kind) {
    case "ImmOrOwnedObject": {
      const io = obj.ImmOrOwnedObject as { objectId: string; version: string };
      return { type: "ImmOrOwnedObject", ...withExecuted(io.objectId, {}, String(io.version)) };
    }
    case "SharedObject": {
      const so = obj.SharedObject as { objectId: string; initialSharedVersion: string; mutable: boolean };
      return {
        type: "SharedObject",
        ...withExecuted(so.objectId, { initial_shared_version: String(so.initialSharedVersion), mutable: so.mutable }, null),
      };
    }
    case "Receiving": {
      const ro = obj.Receiving as { objectId: string; version: string };
      return { type: "Receiving", ...withExecuted(ro.objectId, {}, String(ro.version)) };
    }
    default:
      return { type: obj.$kind };
  }
}

function formatInput(input: Loose, pureType: Body | undefined, executed: ExecutedObjects | undefined): Out {
  if (input.$kind === "Pure") return { type: "Pure", ...resolvePure(input, pureType, "possible_address") };
  if (input.$kind === "Object") return formatObjectInput(input, executed);
  if (input.$kind === "FundsWithdrawal") {
    // A withdrawal from an address balance: the funds a drainer PTB takes are
    // named here and nowhere else in the bytes.
    const fw = input.FundsWithdrawal as {
      reservation: { $kind: string; MaxAmountU64?: string };
      typeArg: { $kind: string; Balance?: string };
      withdrawFrom: { $kind: string };
    };
    return {
      type: "FundsWithdrawal",
      amount: fw.reservation.MaxAmountU64 ?? null,
      coin_type: fw.typeArg.Balance ?? null,
      withdraw_from: fw.withdrawFrom.$kind,
    };
  }
  return { type: input.$kind };
}

// --- Commands ---------------------------------------------------------------

interface Context {
  inputs: Loose[];
  commands: Loose[];
  calls: Map<number, MoveSignature>;
  executed: ExecutedObjects | undefined;
}

/**
 * The command a Result came from: `module::function` for a Move call (its
 * package and declared `returns` are on that command), else the command kind.
 */
function resultSource(ctx: Context, cmdIndex: number): Out {
  const cmd = ctx.commands[cmdIndex];
  if (!cmd) return {};
  if (cmd.$kind !== "MoveCall") return { from: cmd.$kind };
  const mc = cmd.MoveCall as { module: string; function: string };
  return { from: `${mc.module}::${mc.function}` };
}

/**
 * One argument, resolved. `expected` is the type the receiving command
 * declares for it, which is what a pure input is decoded as.
 */
function resolveArgument(arg: Loose, ctx: Context, expected: Body | undefined): Out {
  switch (arg.$kind) {
    case "GasCoin":
      return { type: "GasCoin" };
    case "Input": {
      const index = arg.Input as number;
      const input = ctx.inputs[index];
      if (!input) return { type: "Input", index };
      // An untyped 32-byte recipient still reads as an address, the way a
      // TransferObjects recipient does, for a framework payout's anomaly check.
      if (input.$kind === "Pure") return { type: "Input", index, ...resolvePure(input, expected, "address") };
      if (input.$kind === "Object") {
        // Short type (`module::Name`), as get_transaction's object movements
        // show one. The input list carries the full type, the initial shared
        // version and mutability.
        const { object_id, version, object_type } = formatInput(input, undefined, ctx.executed);
        return { type: "Input", index, object_id, version, object_type: shortType(object_type as string | null) };
      }
      const { type: _kind, ...rest } = formatInput(input, undefined, ctx.executed);
      return { type: "Input", index, ...rest };
    }
    case "Result": {
      const index = arg.Result as number;
      return { type: "Result", index, ...resultSource(ctx, index) };
    }
    case "NestedResult": {
      const [result, subresult] = arg.NestedResult as [number, number];
      return { type: "NestedResult", result, subresult, ...resultSource(ctx, result) };
    }
    default:
      return { type: arg.$kind };
  }
}

const U64: Body = { $kind: "u64" };
const ADDRESS: Body = { $kind: "address" };

/** The declared type of each argument of a command, in `argumentsOf` order. */
function expectedTypes(cmd: Loose, ctx: Context, index: number): Array<Body | undefined> {
  switch (cmd.$kind) {
    case "MoveCall": {
      const params = ctx.calls.get(index)?.parameters;
      return argumentsOf(cmd).map((_, i) => params?.[i]);
    }
    case "SplitCoins":
      return argumentsOf(cmd).map(() => U64);
    case "MakeMoveVec": {
      const type = (cmd.MakeMoveVec as { type: string | null }).type;
      const element = type ? typeArgBody(type) : undefined;
      return argumentsOf(cmd).map(() => element);
    }
    case "TransferObjects":
      return argumentsOf(cmd).map((_, i, all) => (i === all.length - 1 ? ADDRESS : undefined));
    default:
      return [];
  }
}

function formatCommand(cmd: Loose, ctx: Context, index: number): Out {
  const expected = expectedTypes(cmd, ctx, index);
  const arg = (a: unknown, t?: Body) => resolveArgument(a as Loose, ctx, t);
  switch (cmd.$kind) {
    case "MoveCall": {
      const mc = cmd.MoveCall as {
        package: string;
        module: string;
        function: string;
        typeArguments?: string[];
        arguments?: Loose[];
      };
      const protocol = lookupProtocolDisplay(mc.package);
      const operation = lookupOperation(mc.module, mc.function);
      const returns = ctx.calls.get(index)?.returns;
      return {
        type: "MoveCall",
        target: `${mc.package}::${mc.module}::${mc.function}`,
        type_arguments: mc.typeArguments ?? [],
        arguments: (mc.arguments ?? []).map((a, i) => arg(a, expected[i])),
        // What a Result of this command holds, with the call's type arguments
        // substituted.
        ...(returns?.length ? { returns: returns.map(formatSdkSignatureBody) } : {}),
        ...(protocol ? { protocol: protocol.name, protocol_type: protocol.type } : {}),
        ...(operation ? { action: operation.action } : {}),
      };
    }
    case "TransferObjects": {
      const to = cmd.TransferObjects as { objects: Loose[]; address: Loose };
      // The recipient is what makes this a payment or a drain.
      return { type: "TransferObjects", objects: to.objects.map((o) => arg(o)), address: arg(to.address, ADDRESS) };
    }
    case "SplitCoins": {
      const sc = cmd.SplitCoins as { coin: Loose; amounts: Loose[] };
      return { type: "SplitCoins", coin: arg(sc.coin), amounts: sc.amounts.map((a, i) => arg(a, expected[i])) };
    }
    case "MergeCoins": {
      const mc = cmd.MergeCoins as { destination: Loose; sources: Loose[] };
      return { type: "MergeCoins", destination: arg(mc.destination), sources: mc.sources.map((s) => arg(s)) };
    }
    case "Publish": {
      const pub = cmd.Publish as { modules: unknown[]; dependencies: string[] };
      return { type: "Publish", module_count: pub.modules.length, dependencies: pub.dependencies };
    }
    case "Upgrade": {
      const up = cmd.Upgrade as { modules: unknown[]; dependencies: string[]; package: string; ticket: Loose };
      return {
        type: "Upgrade",
        package: up.package,
        module_count: up.modules.length,
        dependencies: up.dependencies,
        ticket: arg(up.ticket),
      };
    }
    case "MakeMoveVec": {
      const mmv = cmd.MakeMoveVec as { type: string | null; elements: Loose[] };
      return { type: "MakeMoveVec", element_type: mmv.type, elements: mmv.elements.map((e, i) => arg(e, expected[i])) };
    }
    default:
      return { type: cmd.$kind, ...cmd };
  }
}

export interface ResolvedPtb {
  inputs: Out[];
  commands: Out[];
  /** Move calls whose signature could not be read; their pure arguments stay as bytes. */
  signatures_unavailable: string[];
}

/**
 * Resolve a PTB's inputs and every command's arguments. `executed` supplies
 * object versions and types for a transaction that ran; without it an object
 * input carries only what the bytes hold.
 */
export async function resolvePtb(data: PtbData, executed?: ExecutedObjects): Promise<ResolvedPtb> {
  const inputs = data.inputs as Loose[];
  const commands = data.commands as Loose[];

  const calls = new Map<number, MoveSignature>();
  const unavailable = new Set<string>();
  // The display names each MoveCall is annotated with.
  const prefetched = prefetchProtocolNames(
    commands.flatMap((c) => (c.$kind === "MoveCall" ? [(c.MoveCall as { package: string }).package] : [])),
  );
  await Promise.all([
    prefetched,
    ...commands.map(async (cmd, i) => {
      if (cmd.$kind !== "MoveCall") return;
      const mc = cmd.MoveCall as { package: string; module: string; function: string; typeArguments?: string[] };
      const target = `${mc.package}::${mc.module}::${mc.function}`;
      const sig = await readSignature(mc.package, mc.module, mc.function);
      if (!sig) {
        unavailable.add(target);
        return;
      }
      const typeArgs = (mc.typeArguments ?? []).map(typeArgBody);
      calls.set(i, {
        parameters: sig.parameters.map((p) => instantiate(p, typeArgs)),
        returns: sig.returns.map((r) => instantiate(r, typeArgs)),
      });
    }),
  ]);
  const ctx: Context = { inputs, commands, calls, executed };

  // An input's listed type is the first type a command declares for it that
  // its bytes decode as exactly. Each command argument is decoded on its own.
  const pureTypes = new Map<number, Body>();
  commands.forEach((cmd, i) => {
    const expected = expectedTypes(cmd, ctx, i);
    argumentsOf(cmd).forEach((a, k) => {
      const t = expected[k];
      if (!t || a.$kind !== "Input") return;
      const index = a.Input as number;
      if (pureTypes.has(index)) return;
      const pure = pureBytes(inputs[index]);
      if (pure && decodePure(t, pure.raw)) pureTypes.set(index, t);
    });
  });

  return {
    inputs: inputs.map((input, i) => formatInput(input, pureTypes.get(i), executed)),
    commands: commands.map((cmd, i) => ({ index: i, ...formatCommand(cmd, ctx, i) })),
    signatures_unavailable: [...unavailable],
  };
}

/** Characters of compact JSON one response's command list may take. */
export const COMMAND_PAGE_BUDGET = 30_000;

/** What a command page left out, exactly. */
export interface CommandsOmitted {
  count: number;
  /** Inclusive index ranges, ascending. */
  ranges: Array<[number, number]>;
  /** The first omitted index: `command_offset` from it lists every omitted command. */
  from: number;
}

/**
 * The commands one response lists. `indices` picks exactly those commands.
 * With `offset` (a continuation), the commands from it in index order while
 * they fit `budget`. With neither (a first page), every command when all fit;
 * when they do not, the commands in `first` (those an anomaly names, most
 * severe first) in that order, then Move calls into packages other than the
 * plumbing, then the other commands, each in index order, while they fit,
 * listed in index order. At least one command is listed when any remain, so
 * a continuation always advances, and `omitted.from` continued with `offset`
 * reaches every omitted command. `missing` lists requested indices the PTB
 * does not have.
 */
export function selectCommands(
  commands: Out[],
  choice: { offset?: number; indices?: number[]; budget?: number; first?: number[] },
): { page: Out[]; omitted: CommandsOmitted | null; missing: number[] } {
  if (choice.indices) {
    const wanted = [...new Set(choice.indices)].sort((a, b) => a - b);
    return {
      page: wanted.filter((i) => i < commands.length).map((i) => commands[i]),
      omitted: null,
      missing: wanted.filter((i) => i >= commands.length),
    };
  }
  const budget = choice.budget ?? COMMAND_PAGE_BUDGET;
  const sizes = commands.map((c) => JSON.stringify(c).length + 1);
  if (choice.offset !== undefined) {
    const page: Out[] = [];
    let spent = 0;
    for (let i = choice.offset; i < commands.length; i++) {
      if (page.length > 0 && spent + sizes[i] > budget) {
        return { page, omitted: { count: commands.length - i, ranges: [[i, commands.length - 1]], from: i }, missing: [] };
      }
      page.push(commands[i]);
      spent += sizes[i];
    }
    return { page, omitted: null, missing: [] };
  }
  if (sizes.reduce((s, n) => s + n, 0) <= budget) return { page: commands, omitted: null, missing: [] };

  const isCall = (c: Out) => c.type === "MoveCall" && typeof c.target === "string" && !isPlumbingPackage(c.target.split("::")[0]);
  const all = commands.map((_, i) => i);
  const tiers = [
    [...new Set(choice.first ?? [])].filter((i) => Number.isInteger(i) && i >= 0 && i < commands.length),
    all.filter((i) => isCall(commands[i])),
    all.filter((i) => !isCall(commands[i])),
  ];
  const kept = new Set<number>();
  let spent = 0;
  for (const tier of tiers) {
    for (const i of tier) {
      if (kept.has(i)) continue;
      if (kept.size > 0 && spent + sizes[i] > budget) break;
      kept.add(i);
      spent += sizes[i];
    }
  }
  const page = commands.filter((_, i) => kept.has(i));
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < commands.length; i++) {
    if (kept.has(i)) continue;
    const last = ranges.at(-1);
    if (last && last[1] === i - 1) last[1] = i;
    else ranges.push([i, i]);
  }
  return { page, omitted: { count: commands.length - kept.size, ranges, from: ranges[0][0] }, missing: [] };
}

/**
 * `commands_omitted` for a page that left commands out: the exact ranges, the
 * decode_ptb call that continues from the first, and the stored full list's
 * page when the store kept one.
 */
export function commandsOmittedView(o: CommandsOmitted, digest: string | null, resultId: string | null) {
  return {
    count: o.count,
    ranges: o.ranges,
    next_call: digest
      ? { tool: "decode_ptb", args: { digest, command_offset: o.from } }
      : { tool: "decode_ptb", repeat_with: { command_offset: o.from } },
    continuation: "command_offset lists commands in index order from that index, including any this page already listed.",
    pick: "commands: [i, j] on decode_ptb, or on get_transaction with detail: 'full', lists exactly those commands.",
    ...(resultId ? { page: resultUri(resultId, { path: "commands", omitted: true }) } : {}),
  };
}

/** A command's arguments in the order `expectedTypes` lists them (TransferObjects: objects, then recipient). */
function argumentsOf(cmd: Loose): Loose[] {
  switch (cmd.$kind) {
    case "MoveCall":
      return ((cmd.MoveCall as { arguments?: Loose[] }).arguments ?? []);
    case "SplitCoins":
      return (cmd.SplitCoins as { amounts: Loose[] }).amounts;
    case "MakeMoveVec":
      return (cmd.MakeMoveVec as { elements: Loose[] }).elements;
    case "TransferObjects": {
      const to = cmd.TransferObjects as { objects: Loose[]; address: Loose };
      return [...to.objects, to.address];
    }
    default:
      return [];
  }
}
