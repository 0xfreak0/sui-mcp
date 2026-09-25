/**
 * Shared harness for the live probes that drive the built server over stdio,
 * the way an MCP client does: one server per probe, a JSON-RPC client, raw
 * GraphQL for independent reads of the same fact, and a check recorder.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
export const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

/**
 * Start the built server with every profile on and a throwaway store.
 * `env` is merged over the process environment.
 */
export async function startServer({ name = "probe", env = {} } = {}) {
  const store = mkdtempSync(join(tmpdir(), `sui-${name}-`));
  const child = spawn(process.execPath, [join(ROOT, "dist", "index.js")], {
    env: { ...process.env, SUI_TOOLS: "all", SUI_STORE_PATH: join(store, "store.db"), ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const pending = new Map();
  let nextId = 1;
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0; ) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  const rpc = (method, params, timeoutMs = 300_000) =>
    new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: { message: `timed out after ${timeoutMs / 1000}s` }, timedOut: true });
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  /** The raw tools/call result, with elapsed milliseconds. */
  async function callRaw(tool, args, timeoutMs) {
    const t0 = Date.now();
    const msg = await rpc("tools/call", { name: tool, arguments: args }, timeoutMs);
    return { ...msg, ms: Date.now() - t0 };
  }

  /** A tool's first JSON object, or its text when it returned none. `_isError` / `_error` mark failures. */
  async function call(tool, args, timeoutMs) {
    const msg = await callRaw(tool, args, timeoutMs);
    if (msg.error) return { _error: msg.error.message, _ms: msg.ms };
    const texts = (msg.result.content ?? []).map((c) => c.text ?? "");
    const json = texts.find((t) => t.trim().startsWith("{"));
    const out = json ? JSON.parse(json) : { _text: texts.join("\n") };
    if (msg.result.isError) out._isError = true;
    out._ms = msg.ms;
    return out;
  }

  function stop() {
    child.kill();
    rmSync(store, { recursive: true, force: true });
  }

  return { rpc, call, callRaw, stop, store };
}

/** Raw mainnet GraphQL: the independent source a tool's answer is compared with. */
export async function gql(query, variables) {
  const r = await fetch("https://graphql.mainnet.sui.io/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await r.json();
  if (body.errors?.length) throw new Error(body.errors[0].message);
  return body.data;
}

/** One address's net change in one coin across the digests, read straight from the chain. */
export async function rawNet(digests, address, coinType) {
  let net = 0n;
  for (const digest of digests) {
    let after = null;
    for (;;) {
      const d = await gql(
        `query($d:String!,$a:String){ transaction(digest:$d){ effects { balanceChanges(first:50, after:$a){ pageInfo { hasNextPage endCursor } nodes { owner { address } coinType { repr } amount } } } } }`,
        { d: digest, a: after },
      );
      const conn = d?.transaction?.effects?.balanceChanges;
      for (const n of conn?.nodes ?? []) {
        if (n.owner?.address === address && n.coinType?.repr === coinType) net += BigInt(n.amount);
      }
      if (!conn?.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break;
      after = conn.pageInfo.endCursor;
    }
  }
  return net;
}

/** Check recorder: prints each result and collects failures for the exit code. */
export function checker() {
  const bad = [];
  const ck = (name, ok, detail = "") => {
    console.log(`   ${ok ? "ok  " : "!!  "}${name}${detail ? `  ${detail}` : ""}`);
    if (!ok) bad.push(`${name}${detail ? ` — ${detail}` : ""}`);
  };
  const finish = () => {
    console.log(`\n${"=".repeat(64)}`);
    console.log(bad.length ? `${bad.length} PROBLEM(S):` : "no inconsistencies found");
    bad.forEach((p) => console.log(`  - ${p}`));
    if (bad.length) process.exitCode = 1;
  };
  return { ck, finish, bad };
}

export const short = (v) => String(typeof v === "string" ? v : JSON.stringify(v)).slice(0, 100);
