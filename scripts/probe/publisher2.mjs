import { getClients } from "../../dist/clients/grpc.js";
import { runWithNetwork } from "../../dist/config.js";
await runWithNetwork("mainnet", async () => {
  const { archive } = getClients("mainnet");
  const { response: tx } = await archive.ledgerService.getTransaction({
    digest: "FrES2GmZ9Z5QXjJM13pnyvQ1SD9PyuNdKZNu2VBoXuu7",
    readMask: { paths: ["transaction","timestamp"] },
  });
  const t = tx.transaction?.transaction;
  console.log("archive served it.");
  console.log("  publisher:", t?.sender);
  console.log("  kind     :", t?.kind?.data?.oneofKind);
  const ts = tx.transaction?.timestamp;
  console.log("  published:", ts ? new Date(Number(ts.seconds)*1000).toISOString() : "?");
});
