/** End-to-end smoke test of describeAddresses({ authentication: true }). */
import { describeAddresses, identityNote } from "../../dist/utils/identity.js";
import { runWithNetwork } from "../../dist/config.js";

const addrs = [
  "0xa1eb94d1700652aa85b417b46fa6775575b8b98d3352d864fb5146eb45d335fb", // 2-of-3
  "0x045dadba87e5ad53f12075a1f0fa94bd94550a3bcf2abbe316e2d3b16ceb9440", // 4-of-7
  "0x088e69d25fdcd212e70085e7560585789c8eea8d4df5a17817827c4e44847b07", // 3-of-6
  "0xcf4e7b88a5a0d2026026b7356c23d2c03281f8a84dc2a2e55597b4464d767cc7", // 1-of-2 sponsored
  "0xafe2fafac0b048c9c70a61cc1798400a85173df96b30118c40af6f3382b5a777", // plain ed25519
  "0xdeee14aade14eb6cf9c1cbca831216774d3e098db67c2e1550a561796d9f46f5", // zkLogin
  "0x" + "e".repeat(64),                                                 // never sent
];

await runWithNetwork("mainnet", async () => {
  const t0 = Date.now();
  const out = await describeAddresses(addrs, { expandMembers: true });
  console.log(`describeAddresses: ${addrs.length} addresses in ${Date.now() - t0}ms\n`);
  for (const a of addrs) {
    const id = out.get(a);
    const auth = id?.authentication;
    const shape = auth?.multisig ? ` ${auth.multisig.threshold}-of-${auth.multisig.members.length}` : "";
    console.log(`${a.slice(0, 14)}…  kind=${id?.kind}  auth=${auth?.scheme ?? "UNKNOWN (never sent)"}${shape} verified=${auth?.verified ?? "-"}`);
    const note = identityNote(id);
    if (note) console.log(`    ${note.slice(0, 150)}`);
    (id?.committee_members ?? []).forEach((cm, i) => {
      const m = auth.multisig.members[i];
      const tags = [cm.name, cm.label, cm.kind !== "wallet" ? cm.kind : null,
                    cm.authentication?.scheme, cm.names_held?.length ? `${cm.names_held.length} held name(s)` : null]
        .filter(Boolean).join(", ");
      console.log(`    [${i}] ${cm.address.slice(0,14)}… w=${m.weight} ${m.signed ? "SIGNED" : "      "} ${tags || "(nothing known)"}`);
    });
  }
});
