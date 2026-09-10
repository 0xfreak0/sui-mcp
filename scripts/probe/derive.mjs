import { MultiSigPublicKey } from "@mysten/sui/multisig";
import { Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";

const committee = {
  threshold: 1,
  members: [
    { pk: "zKVjBVK4lCZOYOboq4+U3AudO2STrceo4HK5vHGxV4I=", weight: 1, scheme: 0 },
    { pk: "+x5KLRu40AVqvOVyktmj0sRNYHeMYwxLMz8gG2RRaGo=", weight: 1, scheme: 0 },
  ],
};
const expected = "0xcf4e7b88a5a0d2026026b7356c23d2c03281f8a84dc2a2e55597b4464d767cc7";

const pubkeys = committee.members.map((m) => ({
  publicKey: new Ed25519PublicKey(Buffer.from(m.pk, "base64")),
  weight: m.weight,
}));

const ms = MultiSigPublicKey.fromPublicKeys({ threshold: committee.threshold, publicKeys: pubkeys });
const derived = ms.toSuiAddress();
console.log("derived  ", derived);
console.log("expected ", expected);
console.log("MATCH:", derived === expected);
console.log("member addresses:");
for (const p of pubkeys) console.log("  ", p.publicKey.toSuiAddress(), "weight", p.weight);
