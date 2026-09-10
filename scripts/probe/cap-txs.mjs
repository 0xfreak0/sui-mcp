const ask=async(q,v)=>(await(await fetch("https://graphql.mainnet.sui.io/graphql",{method:"POST",
  headers:{"content-type":"application/json"},body:JSON.stringify({query:q,variables:v})})).json());
const caps=(await ask(`{ objects(filter:{type:"0x2::package::UpgradeCap"}, first:6){ nodes{ address version
  owner{ __typename ... on AddressOwner{ address{address} } } } } }`)).data?.objects?.nodes ?? [];
for (const c of caps.slice(0,3)) {
  const r=await ask(`query($o:SuiAddress!){ transactions(filter:{affectedObject:$o}, first:20){
    pageInfo{hasNextPage} nodes{ digest sender{address} effects{ timestamp
      objectChanges(first:30){ nodes{ address inputState{ owner{ __typename ... on AddressOwner{address{address}} } }
        outputState{ owner{ __typename ... on AddressOwner{address{address}} } } } } } } } }`, {o:c.address});
  const nodes=r.data?.transactions?.nodes ?? [];
  console.log(`\n${c.address.slice(0,18)}…  owner=${c.owner?.address?.address?.slice(0,14) ?? c.owner?.__typename}  txs=${nodes.length}${r.errors?" ERR "+JSON.stringify(r.errors[0].message).slice(0,90):""}`);
  for (const n of nodes.slice(0,3)) {
    const ch=(n.effects?.objectChanges?.nodes??[]).find(x=>x.address===c.address);
    const from=ch?.inputState?.owner?.address?.address ?? ch?.inputState?.owner?.__typename ?? "-";
    const to=ch?.outputState?.owner?.address?.address ?? ch?.outputState?.owner?.__typename ?? "-";
    console.log(`   ${n.digest.slice(0,14)}… ${String(n.effects?.timestamp).slice(0,10)}  ${String(from).slice(0,14)} -> ${String(to).slice(0,14)}`);
  }
}
