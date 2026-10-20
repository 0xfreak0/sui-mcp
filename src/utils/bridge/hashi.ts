import { getNetwork, type SuiNetwork } from "../../config.js";
import type { Beneficiary } from "./beneficiary.js";
import type { SuiEventNode } from "./wormhole.js";

// First-party deployment table: https://mystenlabs.github.io/hashi/design/node-operator-runbook/#networks
export const HASHI_PACKAGES: Partial<Record<SuiNetwork, string>> = {
  mainnet: "0xd30fb3f8914efdbeb7b8e85fae1d65dc584b44a1281f66737b92bb9f03a59d06",
  testnet: "0x5e0b99c31f691742acea5de4ca1bf53c398d5639fed6503a51ffe8035dc68485",
};

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

/** Hashi stores the witness program, not a Bech32 address: 20 bytes is P2WPKH, 32 is P2TR. */
export function bitcoinWitnessAddress(value: unknown, network: SuiNetwork = getNetwork()): string | null {
  if (network === "devnet" || typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  const version = bytes.length === 20 ? 0 : bytes.length === 32 ? 1 : null;
  if (version === null) return null;
  const hrp = network === "mainnet" ? "bc" : "tb";
  const data = [version];
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = ((acc << 8) | byte) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      data.push((acc >> bits) & 31);
    }
  }
  if (bits) data.push((acc << (5 - bits)) & 31);
  let chk = 1;
  for (const char of hrp) chk = step(chk, char.charCodeAt(0) >> 5);
  chk = step(chk, 0);
  for (const char of hrp) chk = step(chk, char.charCodeAt(0) & 31);
  for (const digit of data) chk = step(chk, digit);
  for (let i = 0; i < 6; i++) chk = step(chk, 0);
  chk = (chk ^ (version === 0 ? 1 : 0x2bc830a3)) >>> 0;
  let address = `${hrp}1`;
  for (const digit of data) address += CHARSET[digit];
  for (let i = 0; i < 6; i++) address += CHARSET[(chk >>> (5 * (5 - i))) & 31];
  return address;
}

function step(checksum: number, value: number): number {
  const top = checksum >>> 25;
  let next = (((checksum & 0x1ffffff) << 5) ^ value) >>> 0;
  for (let i = 0; i < 5; i++) if ((top >>> i) & 1) next = (next ^ GENERATORS[i]) >>> 0;
  return next;
}

function txid(value: unknown): string | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) return null;
  return `0x${Buffer.from(value.slice(2), "hex").reverse().toString("hex")}`;
}

export interface HashiWithdrawal {
  evidence: "chain-derived";
  status: "committed";
  bitcoin_txid: string | null;
  withdrawal_txn_id: string;
  request_ids: string[];
  outputs: Array<{ request_id: string; amount_sats: string; bitcoin_address: string; bitcoin_address_raw: string }>;
  note: string;
}

export interface HashiDeposit {
  evidence: "chain-derived";
  direction: "inbound";
  request_id: string;
  bitcoin_txid: string | null;
  bitcoin_vout: number;
  amount_sats: string;
  sui_recipient: string;
}

export function hashiTransfers(events: SuiEventNode[], network: SuiNetwork = getNetwork()): {
  withdrawals: HashiWithdrawal[];
  deposits: HashiDeposit[];
  beneficiaries: Beneficiary[];
} {
  const pkg = HASHI_PACKAGES[network];
  const withdrawals: HashiWithdrawal[] = [];
  const deposits: HashiDeposit[] = [];
  const beneficiaries: Beneficiary[] = [];
  if (!pkg) return { withdrawals, deposits, beneficiaries };
  let mintedAmounts: Set<string> | null = null;
  for (const event of events) {
    const type = event.contents?.type?.repr;
    const data = event.contents?.json;
    if (!data || typeof data !== "object") continue;
    const row = data as Record<string, unknown>;
    if (type === `${pkg}::withdrawal_queue::WithdrawalPickedForProcessing`) {
      if (typeof row.withdrawal_txn_id !== "string" || !Array.isArray(row.request_ids) || !Array.isArray(row.withdrawal_outputs)) continue;
      const requestIds = row.request_ids.filter((v): v is string => typeof v === "string");
      if (requestIds.length !== row.request_ids.length || requestIds.length !== row.withdrawal_outputs.length) continue;
      const outputs: HashiWithdrawal["outputs"] = [];
      for (const [index, value] of row.withdrawal_outputs.entries()) {
        if (!value || typeof value !== "object" || !("bitcoin_address" in value) || typeof value.bitcoin_address !== "string" ||
          !("amount" in value) || typeof value.amount !== "string" || !/^\d+$/.test(value.amount)) break;
        const address = bitcoinWitnessAddress(value.bitcoin_address, network);
        if (!address) break;
        outputs.push({ request_id: requestIds[index], amount_sats: value.amount, bitcoin_address: address, bitcoin_address_raw: value.bitcoin_address });
      }
      if (outputs.length !== requestIds.length) continue;
      const bitcoinTxid = txid(row.txid);
      withdrawals.push({
        evidence: "chain-derived", status: "committed", bitcoin_txid: bitcoinTxid,
        withdrawal_txn_id: row.withdrawal_txn_id, request_ids: requestIds, outputs,
        note: "Hashi burned hBTC and committed these Bitcoin outputs on Sui. Confirm the Bitcoin transaction before treating them as delivered.",
      });
      for (const output of outputs) beneficiaries.push({
        evidence: "chain-derived", protocol: "Hashi", source: "hashi-bitcoin-withdrawal",
        chain: null, chain_label: network === "mainnet" ? "Bitcoin" : "Bitcoin Signet",
        address: output.bitcoin_address, address_raw: output.bitcoin_address_raw, account: null,
        amount: output.amount_sats, amount_note: "satoshis after the Bitcoin miner fee",
        note: "Bitcoin destination; no CAIP-10 account identifier is provided. Confirm the Bitcoin transaction before treating this output as paid.",
      });
    } else if (type === `${pkg}::deposit::DepositConfirmed`) {
      const utxo = row.utxo;
      if (!utxo || typeof utxo !== "object" || !("id" in utxo) ||
        !("amount" in utxo) || typeof utxo.amount !== "string" ||
        !("derivation_path" in utxo) || typeof utxo.derivation_path !== "string") continue;
      const id = utxo.id;
      if (typeof row.request_id !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(utxo.derivation_path) ||
        !/^\d+$/.test(utxo.amount) || !id || typeof id !== "object" ||
        !("vout" in id) || typeof id.vout !== "number" || !Number.isInteger(id.vout) || id.vout < 0 ||
        !("txid" in id)) continue;
      const bitcoinTxid = txid(id.txid);
      if (!bitcoinTxid) continue;
      if (mintedAmounts === null) {
        mintedAmounts = new Set<string>();
        for (const e of events) {
          if (e.contents?.type?.repr !== `${pkg}::treasury::Minted<${pkg}::btc::BTC>`) continue;
          const json = e.contents.json;
          if (json && typeof json === "object" && "amount" in json && typeof json.amount === "string") mintedAmounts.add(json.amount);
        }
      }
      if (!mintedAmounts.has(utxo.amount)) continue;
      deposits.push({
        evidence: "chain-derived", direction: "inbound", request_id: row.request_id,
        bitcoin_txid: bitcoinTxid, bitcoin_vout: id.vout,
        amount_sats: utxo.amount, sui_recipient: utxo.derivation_path,
      });
    }
  }
  return { withdrawals, deposits, beneficiaries };
}
