/** Drives the identify_address handler the way the MCP server does. */
import { registerIdentifyTools } from "../../dist/tools/identify.js";
import { runWithNetwork } from "../../dist/config.js";

let handler;
const fakeServer = { tool: (_n, _d, _s, h) => { handler = h; } };
registerIdentifyTools(fakeServer);

await runWithNetwork("mainnet", async () => {
  for (const address of [
    "0xcf4e7b88a5a0d2026026b7356c23d2c03281f8a84dc2a2e55597b4464d767cc7", // 1-of-2
    "0xafe2fafac0b048c9c70a61cc1798400a85173df96b30118c40af6f3382b5a777", // plain
    "0x" + "e".repeat(64),                                                // never sent
  ]) {
    const r = await handler({ address });
    const j = JSON.parse(r.content[0].text);
    console.log(`\n=== ${address.slice(0, 16)}… ===`);
    console.log("auth:", j.authentication ? `${j.authentication.scheme}${j.authentication.multisig ? ` ${j.authentication.multisig.threshold}-of-${j.authentication.multisig.members.length}` : ""} verified=${j.authentication.verified}` : "null");
    if (j.authentication_caveat) console.log("caveat:", j.authentication_caveat.slice(0, 120));
    for (const m of j.committee_members ?? [])
      console.log("  member", m.address.slice(0, 14) + "…", m.name ?? "", m.label ?? "", m.authentication?.scheme ?? "");
    console.log("hint:", j.hint.slice(0, 130));
  }
});
