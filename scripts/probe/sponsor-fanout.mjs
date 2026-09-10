/** How many distinct addresses does a sponsor pay gas for? */
const ask=async(q,v)=>(await(await fetch("https://graphql.mainnet.sui.io/graphql",{method:"POST",
  headers:{"content-type":"application/json"},body:JSON.stringify({query:q,variables:v})})).json());
const Q=`query($a:SuiAddress!,$c:String){ transactions(filter:{affectedAddress:$a}, first:50, after:$c){
  pageInfo{hasNextPage endCursor}
  nodes{ digest sender{address} gasInput{ gasSponsor{address} } } } }`;
async function measure(addr, maxPages=8){
  let after=null, scanned=0, sponsored=0, selfPaid=0; const payees=new Set();
  for(let i=0;i<maxPages;i++){
    const r=await ask(Q,{a:addr,c:after}); const c=r.data?.transactions; if(!c) break;
    for(const n of c.nodes){
      scanned++;
      const sp=n.gasInput?.gasSponsor?.address, s=n.sender?.address;
      if(sp===addr && s && s!==addr){ sponsored++; payees.add(s); }
      else if(s===addr) selfPaid++;
    }
    if(!c.pageInfo.hasNextPage) break; after=c.pageInfo.endCursor;
  }
  return {addr, scanned, sponsored, selfPaid, distinct_payees: payees.size};
}
for (const [label,a] of [
  ["sponsor from the multisig tx","0xdca840bf8889485caa9ba956798ca230c34c7528a2bff5380daa89a7cab58cc6"],
  ["ordinary wallet",            "0xafe2fafac0b048c9c70a61cc1798400a85173df96b30118c40af6f3382b5a777"],
]) {
  const m = await measure(a);
  console.log(`${label.padEnd(30)} scanned=${String(m.scanned).padStart(4)} sponsored=${String(m.sponsored).padStart(4)} distinct_payees=${String(m.distinct_payees).padStart(4)} self_paid=${m.selfPaid}`);
}
