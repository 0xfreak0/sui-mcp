import { parseSerializedSignature } from "@mysten/sui/cryptography";
import { MultiSigPublicKey } from "@mysten/sui/multisig";
import { Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1PublicKey } from "@mysten/sui/keypairs/secp256k1";
import { Secp256r1PublicKey } from "@mysten/sui/keypairs/secp256r1";

const GQL = "https://graphql.mainnet.sui.io/graphql";
const ask = async (q, v) => (await (await fetch(GQL, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ query: q, variables: v }),
})).json());

const PK = { ED25519: Ed25519PublicKey, Secp256k1: Secp256k1PublicKey, Secp256r1: Secp256r1PublicKey };
function toPk(entry) {
  const [scheme] = Object.keys(entry);
  const C = PK[scheme];
  if (!C) return { scheme, unsupported: true };
  return { scheme, pk: new C(Uint8Array.from(entry[scheme])) };
}

async function sentTx(address, order) {
  const q = `query($a:SuiAddress!){ transactions(filter:{sentAddress:$a}, first:1${order}) { nodes { digest signatures { signatureBytes } } } }`;
  const r = await ask(q, { a: address });
  if (r.errors) { console.error(JSON.stringify(r.errors)); return null; }
  return r.data?.transactions?.nodes?.[0] ?? null;
}

export async function classify(address) {
  const tx = await sentTx(address, "");
  if (!tx) return { address, verdict: "no_sent_transaction" };
  const results = [];
  for (const s of tx.signatures) {
    const parsed = parseSerializedSignature(s.signatureBytes);
    if (parsed.signatureScheme !== "MultiSig") {
      results.push({ scheme: parsed.signatureScheme, derived: null, raw: parsed });
      continue;
    }
    const members = parsed.multisig.multisig_pk.pk_map.map((m) => ({ ...toPk(m.pubKey), weight: m.weight }));
    if (members.some((m) => m.unsupported)) { results.push({ scheme: "MultiSig", unsupported: members }); continue; }
    const msp = MultiSigPublicKey.fromPublicKeys({
      threshold: parsed.multisig.multisig_pk.threshold,
      publicKeys: members.map((m) => ({ publicKey: m.pk, weight: m.weight })),
    });
    results.push({
      scheme: "MultiSig",
      derived: msp.toSuiAddress(),
      threshold: parsed.multisig.multisig_pk.threshold,
      bitmap: parsed.multisig.bitmap,
      members: members.map((m, i) => ({
        index: i, scheme: m.scheme, weight: m.weight,
        address: m.pk.toSuiAddress(),
        signed_this_tx: Boolean(parsed.multisig.bitmap & (1 << i)),
      })),
    });
  }
  const mine = results.find((r) => r.derived === address);
  return { address, digest: tx.digest, sigs: results.length, verdict: mine ? "multisig" : "not_multisig(or sponsor)", match: mine ?? null, all: results };
}

const target = process.argv[2] ?? "0xcf4e7b88a5a0d2026026b7356c23d2c03281f8a84dc2a2e55597b4464d767cc7";
console.log(JSON.stringify(await classify(target), null, 1));
