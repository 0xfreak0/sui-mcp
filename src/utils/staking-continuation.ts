import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getNetwork } from "../config.js";
import { loadResult, saveResult } from "./store.js";

// Small states need no disk writes. Their key deliberately lives only as long
// as this server. Large states use the opt-in result store and a per-state key
// in the capability, so those continuations survive a server restart.
const sessionKey = randomBytes(32);
const INLINE_LIMIT = 8192;
const TTL_MS = 24 * 60 * 60 * 1000;
const STORE_TOOL = "get_staking_summary:replay";

function seal(text: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

function open(text: string, key: Buffer): string {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error("Invalid encoding");
  const bytes = Buffer.from(text, "base64url");
  if (bytes.toString("base64url") !== text || bytes.length < 28) throw new Error("Invalid encoding");
  const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8");
}

export function saveStakingContinuation(state: unknown): { token: string; storage: "argument" | "local_store" } {
  const text = JSON.stringify({ version: 1, network: getNetwork(), expires: Date.now() + TTL_MS, state });
  const inline = `hs1.i.${seal(text, sessionKey)}`;
  if (inline.length <= INLINE_LIMIT) return { token: inline, storage: "argument" };
  const key = randomBytes(32);
  const id = saveResult(getNetwork(), STORE_TOOL, {}, { sealed: seal(text, key) });
  if (!id) throw new Error("The replay state exceeds the 8 KiB argument limit. Set SUI_STORE_PATH to a writable local store and restart before replaying this address; the continuation could not be saved.");
  return { token: `hs1.s.${id}.${key.toString("base64url")}`, storage: "local_store" };
}

export function loadStakingContinuation<T>(token: string): T {
  let envelope: { version: number; network: string; expires: number; state: T };
  try {
    if (token.length > INLINE_LIMIT) throw new Error("Oversized token");
    const [version, storage, value, secret, extra] = token.split(".");
    if (version !== "hs1" || extra !== undefined) throw new Error("Invalid version");
    let text: string;
    if (storage === "i" && secret === undefined) {
      text = open(value, sessionKey);
    } else if (storage === "s" && /^[0-9a-f]{12}$/.test(value) && /^[A-Za-z0-9_-]{43}$/.test(secret ?? "")) {
      const stored = loadResult(value);
      const payload = stored?.payload;
      if (stored?.tool !== STORE_TOOL || !payload || typeof payload !== "object" ||
          !("sealed" in payload) || typeof payload.sealed !== "string") throw new Error("Missing stored state");
      const key = Buffer.from(secret, "base64url");
      if (key.toString("base64url") !== secret) throw new Error("Invalid key");
      text = open(payload.sealed, key);
    } else {
      throw new Error("Invalid token");
    }
    envelope = JSON.parse(text);
    if (envelope.version !== 1 || !Number.isFinite(envelope.expires)) throw new Error("Invalid state");
  } catch {
    throw new Error("Invalid or stale staking continuation: it was tampered with, belongs to another server session, or its local-store state is unavailable. Start again without continuation.");
  }
  if (envelope.network !== getNetwork()) throw new Error(`Staking continuation belongs to ${envelope.network}, not ${getNetwork()}. Use its original network.`);
  if (Date.now() >= envelope.expires) throw new Error("Stale staking continuation: its 24-hour lifetime has expired. Start again without continuation.");
  return envelope.state;
}
