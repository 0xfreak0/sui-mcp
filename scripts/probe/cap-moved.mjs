import { resolvePublisher } from "../../dist/utils/publisher.js";
import { runWithNetwork } from "../../dist/config.js";
const ask=async(q,v)=>(await(await fetch("https://graphql.mainnet.sui.io/graphql",{method:"POST",
  headers:{"content-type":"application/json"},body:JSON.stringify({query:q,variables:v})})).json());
await runWithNetwork("mainnet", async () => {
  const r=await ask(`{ objects(filter:{type:"0x2::package::UpgradeCap"}, first:14){ nodes{
    address asMoveObject{ contents{ json } } owner{ __typename ... on AddressOwner{ address{address} } } } } }`);
  for (const c of r.data.objects.nodes) {
    const j=c.asMoveObject?.contents?.json;
    if (!j?.package) continue;
    const p=await resolvePublisher(j.package);
    const holder=c.owner?.address?.address;
    if (p.publisher && holder && holder.toLowerCase()!==p.publisher.toLowerCase()) {
      console.log("cap     :", c.address);
      console.log("package :", j.package);
      console.log("policy  :", j.policy, "| version:", j.version);
      console.log("publisher:", p.publisher);
      console.log("holder  :", holder, "| ownerKind:", c.owner?.__typename);
      console.log("zero addr?", /^0x0+$/.test(holder));
    }
  }
});
