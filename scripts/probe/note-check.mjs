import { describeAddresses, identityNote } from "../../dist/utils/identity.js";
import { runWithNetwork } from "../../dist/config.js";
await runWithNetwork("mainnet", async () => {
  const a = "0xcf4e7b88a5a0d2026026b7356c23d2c03281f8a84dc2a2e55597b4464d767cc7";
  const out = await describeAddresses([a], { expandMembers: true });
  console.log(identityNote(out.get(a)));
});
